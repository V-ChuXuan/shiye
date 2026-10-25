import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Collector, ParsedArticle } from '../shared/types.js';
import { createApp } from '../server/app.js';

const BIZ = 'MzkzNzg5Njc2MQ==';
const URL = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(BIZ)}&mid=101&idx=1`;
const AVATAR = 'https://mmbiz.qpic.cn/fixture/account-avatar/0?wx_fmt=png';
const IMAGE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

class AvatarSource implements Collector {
  articleRequests: string[] = [];
  previews = 0;
  gate: string | null = null;
  failure?: { code: string; blocked?: boolean };
  hold?: Promise<void>;
  started?: () => void;
  aborted = false;
  parsed: ParsedArticle = { biz: BIZ, mid: '101', idx: '1', title: '来自来源的不同标题', account: '来源名称', url: URL,
    publishedAt: '2026-10-24', avatarUrl: AVATAR.replace('https:', 'http:') + '&key=PRIVATE',
    blocks: [{ type: 'text', text: '不应覆盖本地正文' }], images: [], textLength: 9 };
  async fetchArticle(url: string, signal?: AbortSignal) {
    this.articleRequests.push(url); this.started?.();
    if (this.hold) await Promise.race([this.hold, new Promise<void>((_resolve, reject) => {
      const abort = () => { this.aborted = true; reject(new DOMException('Closed', 'AbortError')); };
      if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
    })]);
    if (this.failure) throw this.failure;
    return this.parsed;
  }
  async fetchCover() { this.previews++; return { buffer: IMAGE, ext: 'png', mime: 'image/png', sha256: createHash('sha256').update(IMAGE).digest('hex') }; }
  async fetchImage(): Promise<never> { throw new Error('Avatar must not download body images'); }
  async captureSession() {}
  hasSession() { return true; }
  getGate() { return this.gate; }
  clearGate() { this.gate = null; }
  async discoverPage() { return { entries: [], nextOffset: 0, canContinue: false }; }
}

async function setup(t: test.TestContext) {
  const testRoot = resolve('data'); await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'avatars-test-')), source = new AvatarSource(), dataDir = join(root, 'db');
  let app = await createApp({ dataDir, source, schedulerEnabled: false, staticDir: join(root, 'absent-client') });
  t.after(async () => { await app.close(); assert.ok(root.startsWith(`${testRoot}${sep}avatars-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const account = app.archive.store.upsertAccount(BIZ, '本地名称');
  const article = app.archive.store.upsertArticle({ accountId: account.id, biz: BIZ, mid: '101', url: URL, title: '本地已归档标题', publishedAt: '2025-01-01',
    status: 'complete', blocks: [{ type: 'text', text: '本地正文' }, { type: 'image', seq: 1 }], imageCount: 1 });
  await app.archive.saveImage(article.id, { seq: 1, src: 'https://mmbiz.qpic.cn/body/0', status: 'pending' }, IMAGE, 'png', 'image/png');
  return { get app() { return app; }, source, account, article,
    restart: async () => { await app.close(); app = await createApp({ dataDir, source, schedulerEnabled: false, staticDir: join(root, 'absent-client') }); } };
}

test('profile refresh changes only avatar metadata and uses the existing isolated image cache', async t => {
  const env = await setup(t), id = env.account.id, store = env.app.archive.store;
  const before = { article: store.article(env.article.id), assets: store.storedAssets(env.article.id), summary: env.app.archive.summary(), jobs: store.jobs() };
  assert.equal((await env.app.inject(`/api/accounts/${id}/avatar`)).statusCode, 404);
  assert.deepEqual(env.source.articleRequests, []);
  const response = await env.app.inject({ method: 'POST', url: `/api/accounts/${id}/profile` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().avatarSource, AVATAR);
  const avatarUrl = response.json().avatarUrl;
  assert.equal(new globalThis.URL(avatarUrl, 'http://localhost').pathname, `/api/accounts/${id}/avatar`);
  assert.equal(new globalThis.URL(avatarUrl, 'http://localhost').searchParams.get('v'), createHash('sha256').update(AVATAR).digest('hex'));
  assert.equal(response.json().name, env.account.name);
  assert.deepEqual(env.source.articleRequests, [URL]);
  const previews = await Promise.all([env.app.inject(avatarUrl), env.app.inject(avatarUrl)]);
  assert.ok(previews.every(reply => reply.statusCode === 200 && reply.headers['content-type'] === 'image/png'));
  assert.deepEqual(previews[0].rawPayload, IMAGE); assert.equal(env.source.previews, 1);
  assert.deepEqual({ article: store.article(env.article.id), assets: store.storedAssets(env.article.id), summary: env.app.archive.summary(), jobs: store.jobs() }, before);
  await env.restart(); env.source.gate = 'rate_limited';
  assert.equal((await env.app.inject(avatarUrl)).statusCode, 200); assert.equal(env.source.previews, 1);
  assert.equal((await env.app.inject('/api/accounts')).json()[0].avatarUrl, avatarUrl);
  assert.equal(env.source.articleRequests.length, 1, 'GET and polling must not refresh article metadata');
});

test('profile failures retain an existing avatar and cannot read a different account or unsafe image URL', async t => {
  const env = await setup(t), id = env.account.id;
  await env.app.inject({ method: 'POST', url: `/api/accounts/${id}/profile` });
  const before = env.app.archive.article(env.article.id);
  for (const parsed of [{ ...env.source.parsed, avatarUrl: undefined }, { ...env.source.parsed, avatarUrl: 'https://127.0.0.1/private' }, { ...env.source.parsed, biz: 'AnotherAccount==' }]) {
    env.source.parsed = parsed;
    assert.equal((await env.app.inject({ method: 'POST', url: `/api/accounts/${id}/profile` })).statusCode, 422);
    assert.equal(env.app.archive.account(id).avatarSource, AVATAR);
    assert.deepEqual(env.app.archive.article(env.article.id), before);
  }
  const empty = env.app.archive.store.upsertAccount('EmptyAccount==', '无文章的号');
  const requests = env.source.articleRequests.length;
  assert.equal((await env.app.inject({ method: 'POST', url: `/api/accounts/${empty.id}/profile` })).statusCode, 404);
  assert.equal((await env.app.inject('/api/accounts/missing/avatar?url=https://127.0.0.1/private')).statusCode, 404);
  env.app.archive.store.saveAccount({ ...empty, avatarSource: 'https://evil.test/image.png' });
  assert.equal((await env.app.inject(`/api/accounts/${empty.id}/avatar`)).statusCode, 404);
  assert.equal(env.source.articleRequests.length, requests); assert.equal(env.source.previews, 0);
  env.source.failure = { code: 'verification', blocked: true };
  assert.equal((await env.app.inject({ method: 'POST', url: `/api/accounts/${id}/profile` })).statusCode, 409);
  const blockedRequests = env.source.articleRequests.length;
  assert.equal((await env.app.inject({ method: 'POST', url: `/api/accounts/${id}/profile` })).statusCode, 409);
  assert.equal(env.source.articleRequests.length, blockedRequests);
  assert.equal(env.app.archive.account(id).avatarSource, AVATAR);
  assert.equal(env.app.archive.summary().connectionBlocked, true);
});

test('normal article identification retains safe avatar metadata and a later profile refresh preserves concurrent edits', async t => {
  const env = await setup(t);
  assert.equal((await env.app.archive.addAccount({ url: URL })).avatarSource, AVATAR);
  let release!: () => void, entered!: () => void;
  env.source.hold = new Promise(done => { release = done; });
  const started = new Promise<void>(done => { entered = done; }); env.source.started = entered;
  const pending = env.app.inject({ method: 'POST', url: `/api/accounts/${env.account.id}/profile` }).then(response => response);
  await started;
  const patch = await env.app.inject({ method: 'PATCH', url: `/api/accounts/${env.account.id}`, payload: { name: '并发改名', updatePolicy: 'discover', intervalMinutes: 15 } });
  assert.equal(patch.statusCode, 200);
  assert.equal((await env.app.inject({ method: 'POST', url: `/api/accounts/${env.account.id}/profile` })).statusCode, 409);
  assert.equal((await env.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: resolve('data/never-write-avatar-setting') } })).statusCode, 409);
  release(); assert.equal((await pending).statusCode, 200);
  const account = env.app.archive.account(env.account.id);
  assert.equal(account.name, '并发改名'); assert.equal(account.updatePolicy, 'discover'); assert.equal(account.intervalMinutes, 15); assert.equal(account.avatarSource, AVATAR);
});

test('shutdown aborts a held profile refresh before closing its database', async t => {
  const env = await setup(t);
  env.source.hold = new Promise(() => {});
  let entered!: () => void; const started = new Promise<void>(done => { entered = done; }); env.source.started = entered;
  const pending = env.app.inject({ method: 'POST', url: `/api/accounts/${env.account.id}/profile` }).then(response => response);
  await started;
  const close = env.app.close();
  await pending; await close;
  assert.equal(env.source.aborted, true);
});
