import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Collector, ParsedArticle } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { CoverCache } from '../server/covers.js';

const BIZ = 'MzkzNzg5Njc2MQ==';
const URL = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(BIZ)}&mid=101&idx=1`;
const COVER = 'https://mmbiz.qpic.cn/fixture/cover/640?wx_fmt=png';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

class CoverSource implements Collector {
  requests = 0;
  bodyRequests = 0;
  gate: string | null = null;
  failure?: { code: string; blocked?: boolean };
  async fetchArticle(): Promise<ParsedArticle> { this.bodyRequests++; throw new Error('Cover preview must not fetch body'); }
  async fetchImage(): Promise<never> { throw new Error('Cover preview must use bounded thumbnail fetch'); }
  async fetchCover(_url: string, _referer: string, _signal?: AbortSignal) {
    this.requests++;
    if (this.failure) throw this.failure;
    return { buffer: PNG, ext: 'png', mime: 'image/png', sha256: createHash('sha256').update(PNG).digest('hex') };
  }
  async captureSession() {}
  hasSession() { return true; }
  getGate() { return this.gate; }
  clearGate() { this.gate = null; }
  async discoverPage() { return { entries: [{ url: URL, title: '待采集封面样本', publishedAt: '2026-10-20', coverUrl: `${COVER}&key=PRIVATE` }], nextOffset: 1, canContinue: false }; }
}

async function setup(t: test.TestContext) {
  const testRoot = resolve('data'); await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'covers-test-'));
  const dataDir = join(root, 'db'), source = new CoverSource();
  let app = await createApp({ dataDir, source, schedulerEnabled: false, staticDir: join(root, 'absent-client') });
  t.after(async () => { await app.close(); assert.ok(root.startsWith(`${testRoot}${sep}covers-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const account = app.archive.store.upsertAccount(BIZ, '预览公众号');
  const entry = (mid = '101', coverSource = COVER) => app.archive.store.upsertArticle({ accountId: account.id, biz: BIZ, mid, idx: '1', url: URL.replace('mid=101', `mid=${mid}`), title: `待采集${mid}`, coverSource });
  return { get app() { return app; }, source, root, dataDir, account, entry,
    async restart() { await app.close(); app = await createApp({ dataDir, source, schedulerEnabled: false, staticDir: join(root, 'absent-client') }); } };
}

test('history cover previews are local, deduplicated and never count as body archives', async t => {
  const env = await setup(t);
  env.app.archive.createDiscoveryJob(env.account.id, 1); await env.app.archive.idle();
  const article = env.app.archive.store.articles()[0];
  assert.equal(article.coverSource, COVER);
  assert.equal(article.coverUrl, `/api/covers/${article.id}`);
  const before = env.app.archive.summary();
  const replies = await Promise.all(Array.from({ length: 6 }, () => env.app.inject(article.coverUrl!)));
  assert.ok(replies.every(reply => reply.statusCode === 200 && reply.headers['content-type']?.startsWith('image/png')));
  assert.ok(replies.every(reply => reply.rawPayload.equals(PNG)));
  assert.equal(env.source.requests, 1); assert.equal(env.source.bodyRequests, 0);
  assert.deepEqual(env.app.archive.summary(), before);
  const saved = env.app.archive.article(article.id);
  assert.equal(saved.status, 'discovered'); assert.equal(saved.savedImageCount, 0); assert.equal(saved.imageCount, 0);
  assert.deepEqual(saved.assets, []); assert.deepEqual(saved.blocks, []);
  assert.ok(env.app.archive.jobs().every(job => job.kind === 'discover'));
  assert.ok(!(await readdir(join(env.dataDir, 'covers'))).some(file => file.endsWith('.part')));
});

test('validated cover cache survives restart and a shared source gate', async t => {
  const env = await setup(t), article = env.entry();
  assert.equal((await env.app.inject(article.coverUrl!)).statusCode, 200);
  await env.restart(); env.source.gate = 'rate_limited';
  assert.equal((await env.app.inject(article.coverUrl!)).statusCode, 200); assert.equal(env.source.requests, 1);
  const uncached = env.entry('102');
  assert.equal((await env.app.inject(uncached.coverUrl!)).statusCode, 409); assert.equal(env.source.requests, 1);
  assert.equal(env.app.archive.article(uncached.id).status, 'discovered');
});

test('invalid cached bytes are fetched again and changed cover sources use fresh cache keys', async t => {
  const env = await setup(t), article = env.entry();
  assert.equal((await env.app.inject(article.coverUrl!)).statusCode, 200);
  const files = await readdir(join(env.dataDir, 'covers'));
  assert.equal(files.length, 1); await writeFile(join(env.dataDir, 'covers', files[0]), 'broken');
  assert.equal((await env.app.inject(article.coverUrl!)).statusCode, 200); assert.equal(env.source.requests, 2);
  env.app.archive.store.setArticle(article.id, { coverSource: COVER.replace('/cover/', '/updated/') });
  assert.equal((await env.app.inject(article.coverUrl!)).statusCode, 200); assert.equal(env.source.requests, 3);
  assert.equal((await readdir(join(env.dataDir, 'covers'))).length, 2);
});

test('cover failures cool down without mutating article status or retrying on each poll', async t => {
  const env = await setup(t), article = env.entry();
  let now = 10_000; t.mock.method(Date, 'now', () => now);
  env.source.failure = { code: 'network' };
  for (let i = 0; i < 5; i++) assert.equal((await env.app.inject(article.coverUrl!)).statusCode, 422);
  assert.equal(env.source.requests, 1); assert.equal(env.app.archive.article(article.id).status, 'discovered');
  env.source.failure = undefined; now += 61_000;
  assert.equal((await env.app.inject(article.coverUrl!)).statusCode, 200); assert.equal(env.source.requests, 2);
});

test('unknown articles, unsafe cover sources and outside cache links cannot fetch or disclose files', async t => {
  const env = await setup(t);
  const bad = env.entry('103', 'https://127.0.0.1/private.png');
  assert.equal(bad.coverSource, undefined); assert.equal(bad.coverUrl, undefined);
  assert.equal((await env.app.inject(`/api/covers/${bad.id}`)).statusCode, 404);
  assert.equal((await env.app.inject('/api/covers/missing?url=https://127.0.0.1/private.png')).statusCode, 404);
  assert.equal((await env.app.inject('/api/covers/..%2f..%2fprivate')).statusCode, 404);
  const article = env.entry();
  const outside = join(env.root, 'outside'); await mkdir(outside);
  await symlink(outside, join(env.dataDir, 'covers'), process.platform === 'win32' ? 'junction' : 'dir');
  try {
    assert.notEqual((await env.app.inject(article.coverUrl!)).statusCode, 200);
    assert.equal(env.source.requests, 0); assert.deepEqual(await readdir(outside), []);
  } finally { await unlink(join(env.dataDir, 'covers')); }
});

test('body assets take precedence over a separate preview without changing archive counters', async t => {
  const env = await setup(t), article = env.entry();
  env.app.archive.store.saveAsset(article.id, { seq: 1, src: COVER, status: 'complete', file: 'unused-test.png' });
  assert.equal(env.app.archive.article(article.id).coverUrl, `/api/assets/${article.id}/1`);
  assert.equal(env.app.archive.article(article.id).savedImageCount, 1);
  assert.equal(env.app.archive.article(article.id).status, 'discovered');
});

test('closing cover cache aborts the in-flight fetch and does not start queued fetches', async t => {
  const env = await setup(t);
  let requests = 0;
  let ready!: () => void;
  const started = new Promise<void>(done => { ready = done; });
  const cache = new CoverCache(env.dataDir, async (_url, _referer, signal) => {
    requests++; ready();
    return new Promise((_done, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const settled = Promise.allSettled([cache.get('first', COVER, URL), cache.get('second', COVER, URL)]);
  await started; await cache.close();
  assert.ok((await settled).every(result => result.status === 'rejected'));
  assert.equal(requests, 1); assert.deepEqual(await readdir(join(env.dataDir, 'covers')), []);
});

test('application shutdown cancels active cover responses before waiting for HTTP requests to drain', async t => {
  const env = await setup(t), article = env.entry();
  let ready!: () => void;
  const started = new Promise<void>(done => { ready = done; });
  env.source.fetchCover = async (_url, _referer, signal) => {
    ready();
    return new Promise((_done, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const response = env.app.inject(article.coverUrl!);
  void response.then(() => {});
  await started;
  await env.app.close();
  assert.notEqual((await response).statusCode, 200);
});
