import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Collector, ParsedArticle } from '../shared/types.js';
import { createApp, type ArchiveApp } from '../server/app.js';
import { ArchiveService } from '../server/service.js';
import { Store, type StoredAsset } from '../server/store.js';

const BIZ = 'MzkzNzg5Njc2MQ==';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const url = (mid: string) => `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(BIZ)}&mid=${mid}&idx=1&sn=public&chksm=public`;
const image = (mid: string, seq: number) => `https://mmbiz.qpic.cn/test/${mid}/${seq}/640`;
function parsed(mid = '101'): ParsedArticle { return { biz: BIZ, mid, idx: '1', title: `文章${mid}`, account: '测试公众号', publishedAt: '2026-10-20 12:00', url: url(mid), textLength: 4,
  blocks: [{ type: 'text', text: '正文<script>仅文本</script>' }, { type: 'image', seq: 1 }, { type: 'image', seq: 2 }], images: [{ seq: 1, src: image(mid, 1) }, { seq: 2, src: image(mid, 2) }] }; }

class MockSource implements Collector {
  connected = true;
  gate: string | null = null;
  articleRequests: string[] = [];
  imageRequests: string[] = [];
  pageRequests: number[] = [];
  failImageOnce?: string;
  articleFailure?: { code: string; blocked: boolean; message?: string };
  holdImage = false;
  onImage?: () => void;
  async fetchArticle(input: string): Promise<ParsedArticle> {
    this.articleRequests.push(input);
    if (this.articleFailure) throw this.articleFailure;
    return parsed(new URL(input).searchParams.get('mid') || '101');
  }
  async fetchImage(input: string, _referer: string, signal?: AbortSignal) {
    this.imageRequests.push(input);
    this.onImage?.();
    if (this.holdImage) await new Promise<void>((_resolve, reject) => { if (signal?.aborted) reject(new DOMException('Stopped', 'AbortError')); else signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }); });
    if (input === this.failImageOnce) { this.failImageOnce = undefined; throw { code: 'network' }; }
    return { buffer: PNG, ext: 'png', mime: 'image/png', sha256: hash(PNG) };
  }
  async captureSession(_biz: string) { this.connected = true; this.gate = null; }
  hasSession(_biz: string) { return this.connected; }
  getGate() { return this.gate; }
  clearGate() { this.gate = null; }
  async discoverPage(_biz: string, offset: number) {
    this.pageRequests.push(offset);
    return { entries: [{ url: url(String(101 + offset)), title: `文章${101 + offset}`, publishedAt: `2026-10-${20 - offset} 12:00` }], nextOffset: offset + 1, canContinue: offset < 2 };
  }
}

async function setup(t: test.TestContext, schedulerEnabled = false): Promise<{ app: ArchiveApp; source: MockSource; root: string }> {
  const testRoot = resolve('data'); await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, 'backend-test-')), source = new MockSource();
  const app = await createApp({ dataDir: join(root, 'db'), source, schedulerEnabled, staticDir: join(root, 'absent-client') });
  t.after(async () => { await app.close(); assert.ok(root.startsWith(`${testRoot}${sep}backend-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { app, source, root };
}
const add = async (app: ArchiveApp) => (await app.inject({ method: 'POST', url: '/api/accounts', payload: { biz: BIZ, name: '测试公众号' } })).json<{ id: string }>();
function entry(app: ArchiveApp, accountId: string, mid: string) { return app.archive.store.upsertArticle({ accountId, biz: BIZ, mid, idx: '1', url: url(mid), title: `文章${mid}`, publishedAt: '2026-10-20' }); }

test('local API has real empty state and rejects foreign Host/Origin', async t => {
  const { app } = await setup(t);
  const health = await app.inject('/api/health'); assert.equal(health.statusCode, 200); assert.deepEqual(health.json(), { ok: true });
  assert.deepEqual((await app.inject('/api/summary')).json(), { accountCount: 0, articleCount: 0, archivedCount: 0, imageCount: 0, activeJobs: 0, completedJobsCount: 0, connectionBlocked: false });
  assert.equal((await app.inject({ url: '/api/summary', headers: { host: 'evil.example' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', headers: { origin: 'https://evil.example' }, payload: { biz: BIZ, name: 'x' } })).statusCode, 403);
  assert.equal((await app.inject('/api/not-a-route')).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/api/accounts', payload: { url: 'file:///private' } })).statusCode, 400);
});

test('summary and account coverage count stored states without per-article queries', async t => {
  const { app, source } = await setup(t), store = app.archive.store;
  const first = store.upsertAccount(BIZ, '第一个号');
  const second = store.upsertAccount('MzOtherAccount==', '空号');
  store.saveAccount({ ...first, coverage: { count: 0, complete: true, stopReason: 'reached-end' } });
  for (let index = 0; index < 467; index++) {
    const article = store.upsertArticle({ accountId: first.id, biz: BIZ, mid: String(index), url: url(String(index)),
      title: `文章${index}`, publishedAt: index === 0 ? '' : index === 1 ? '2025-12-31' : '2026-10-24',
      status: index < 5 ? 'complete' : index === 5 ? 'partial' : 'discovered', savedImageCount: 999 });
    if (index < 6) {
      store.saveAsset(article.id, { seq: 1, src: image(String(index), 1), status: 'complete' });
      store.saveAsset(article.id, { seq: 2, src: image(String(index), 2), status: index % 2 ? 'failed' : 'pending' });
    }
  }
  for (const status of ['queued', 'running', 'paused', 'blocked', 'waiting_session', 'completed', 'partial', 'failed'] as const) {
    const job = store.createJob(first, 'archive'); store.saveJob({ ...job, status });
  }
  const prepare = t.mock.method(store.db, 'prepare');
  assert.deepEqual(store.summary(), { accountCount: 2, articleCount: 467, archivedCount: 5, imageCount: 6, activeJobs: 2, completedJobsCount: 1, connectionBlocked: false });
  const summaryQueries = prepare.mock.callCount();
  prepare.mock.resetCalls();
  const accounts = store.accounts(), accountQueries = prepare.mock.callCount();
  const populated = accounts.find(account => account.id === first.id)!, empty = accounts.find(account => account.id === second.id)!;
  assert.deepEqual(populated.coverage, { count: 467, complete: true, stopReason: 'reached-end', oldest: '2025-12-31', newest: '2026-10-24' });
  assert.equal(populated.archivedCount, 5); assert.equal(populated.articleCount, 467);
  assert.deepEqual(empty.coverage, { count: 0, complete: false, oldest: undefined, newest: undefined });
  store.gate = 'verification'; assert.equal(store.summary().connectionBlocked, true);
  store.gate = null; source.gate = 'rate_limit'; assert.equal(app.archive.summary().connectionBlocked, true);
  source.gate = null; assert.equal(app.archive.summary().connectionBlocked, false);
  t.diagnostic(`467 articles: summary=${summaryQueries}, accounts=${accountQueries} SQL preparations`);
  assert.ok(summaryQueries <= 6, `Summary must aggregate, got ${summaryQueries} queries.`);
  assert.ok(accountQueries <= accounts.length + 1, `Account counts must not query each article, got ${accountQueries} queries.`);
});

test('short link metadata and canonical discovery merge to one article without downloading images', async t => {
  const { app, source } = await setup(t);
  const result = await app.inject({ method: 'POST', url: '/api/accounts', payload: { url: 'https://mp.weixin.qq.com/s/abcdefghijklmno' } });
  assert.equal(result.statusCode, 201); const accountId = result.json<{ id: string }>().id;
  const job = await app.inject({ method: 'POST', url: `/api/accounts/${accountId}/discover`, payload: { maxPages: 1 } });
  assert.equal(job.statusCode, 201); await app.archive.idle();
  assert.equal(app.archive.store.articles().length, 1); assert.equal(source.imageRequests.length, 0);
  assert.equal(app.archive.store.jobs()[0].coverage?.complete, false);
  assert.equal(app.archive.store.jobs()[0].coverage?.stopReason, 'page_limit');
  assert.equal(app.archive.store.articles()[0].status, 'discovered');
});

test('selected article IDs freeze five entries and leave unselected articles untouched', async t => {
  const { app, source } = await setup(t), account = await add(app);
  const articles = Array.from({ length: 6 }, (_, i) => entry(app, account.id, String(101 + i)));
  const response = await app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId: account.id, articleIds: articles.slice(0, 5).map(item => item.id) } });
  assert.equal(response.statusCode, 201); await app.archive.idle();
  const job = app.archive.store.job(response.json<{ id: string }>().id)!;
  assert.equal(app.archive.store.jobItems(job.id).length, 5); assert.equal(job.total, 5); assert.equal(job.completed, 5); assert.equal(job.status, 'completed'); assert.equal(job.progress, 100);
  assert.equal(source.imageRequests.length, 10); assert.equal(app.archive.article(articles[5].id).status, 'discovered');
  assert.equal((await app.inject({ method: 'POST', url: '/api/jobs', payload: { accountId: account.id, articleIds: [] } })).statusCode, 400);
});

test('partial image download is not complete and resume only fetches the missing asset', async t => {
  const { app, source } = await setup(t), account = await add(app), article = entry(app, account.id, '101');
  source.failImageOnce = image('101', 2);
  const job = app.archive.createArchiveJob(account.id, [article.id]); await app.archive.idle();
  assert.equal(app.archive.store.job(job.id)?.status, 'partial'); assert.equal(app.archive.article(article.id).status, 'partial');
  assert.equal(app.archive.article(article.id).savedImageCount, 1);
  app.archive.resume(job.id); await app.archive.idle();
  assert.equal(app.archive.store.job(job.id)?.status, 'completed'); assert.equal(app.archive.article(article.id).savedImageCount, 2);
  assert.equal(source.imageRequests.filter(item => item === image('101', 1)).length, 1);
  assert.equal(source.imageRequests.filter(item => item === image('101', 2)).length, 2);
  assert.equal(source.articleRequests.length, 1);
  const detail = (await app.inject(`/api/articles/${article.id}`)).json<{ assets: { localUrl: string }[]; blocks: unknown[] }>();
  assert.ok(detail.blocks.length); const binary = await app.inject(detail.assets[0].localUrl); assert.equal(binary.statusCode, 200); assert.equal(binary.headers['content-type'], 'image/png'); assert.deepEqual(binary.rawPayload, PNG);
});

test('previously complete local images are checked and corrupted files are repaired', async t => {
  const { app, source } = await setup(t), account = await add(app), article = entry(app, account.id, '101');
  app.archive.createArchiveJob(account.id, [article.id]); await app.archive.idle();
  const first = app.archive.store.storedAssets(article.id)[0]; await writeFile(await app.archive.filePath(first.file!), Buffer.from('broken'));
  app.archive.createArchiveJob(account.id, [article.id]); await app.archive.idle();
  assert.equal(source.articleRequests.length, 1); assert.equal(source.imageRequests.filter(item => item === image('101', 1)).length, 2); assert.equal(source.imageRequests.filter(item => item === image('101', 2)).length, 1);
  assert.ok(await app.archive.validAsset(app.archive.store.storedAssets(article.id)[0]));
});

test('running requests pause without pretending completion and resume from saved state', async t => {
  const { app, source } = await setup(t), account = await add(app), article = entry(app, account.id, '101');
  let started!: () => void; const startedPromise = new Promise<void>(resolve => { started = resolve; });
  source.holdImage = true; source.onImage = started;
  const job = app.archive.createArchiveJob(account.id, [article.id]); await startedPromise;
  assert.equal((await app.inject({ method: 'POST', url: '/api/import', payload: { path: resolve('data/absent') } })).statusCode, 409);
  app.archive.pause(job.id); await app.archive.idle();
  assert.equal(app.archive.store.job(job.id)?.status, 'paused'); assert.equal(app.archive.article(article.id).status, 'partial');
  source.holdImage = false; app.archive.resume(job.id); await app.archive.idle(); assert.equal(app.archive.store.job(job.id)?.status, 'completed');
});

test('pause during reused-image or final disk validation cannot be overwritten by completion', async t => {
  for (const stage of ['reuse', 'final', 'completed-item']) await t.test(stage, async child => {
    const { app, source } = await setup(child), account = await add(app), article = entry(app, account.id, '101');
    app.archive.createArchiveJob(account.id, [article.id]); await app.archive.idle();
    const original = app.archive.validAsset.bind(app.archive), requests = source.imageRequests.length;
    let release!: () => void, entered!: () => void, calls = 0;
    const held = new Promise<void>(done => { release = done; }), started = new Promise<void>(done => { entered = done; });
    child.mock.method(app.archive, 'validAsset', async (asset: StoredAsset) => {
      if (++calls === (stage === 'final' ? 4 : stage === 'reuse' ? 2 : 1)) { entered(); await held; }
      return original(asset);
    });
    const job = app.archive.createArchiveJob(account.id, [article.id]);
    if (stage === 'completed-item') app.archive.store.setJobItem(job.id, 0, 'complete');
    await started;
    assert.equal(app.archive.pause(job.id).status, 'paused'); release(); await app.archive.idle();
    assert.equal(app.archive.store.job(job.id)?.status, 'paused', 'The acknowledged pause must survive the pending disk check.');
    assert.notEqual(app.archive.store.jobItems(job.id)[0].status, 'failed');
    assert.equal(source.imageRequests.length, requests, 'Checking existing images must not issue another image request.');
    assert.equal(app.archive.article(article.id).savedImageCount, 2);
  });
});

test('startup converts interrupted jobs to paused without performing network requests', async t => {
  const { app, source, root } = await setup(t), account = await add(app), article = entry(app, account.id, '101');
  const job = app.archive.store.createJob(app.archive.account(account.id), 'archive', [article.id]);
  app.archive.store.saveJob({ ...job, status: 'running' }); app.archive.store.setJobItem(job.id, 0, 'running');
  await app.close();
  const restored = new ArchiveService(join(root, 'db'), source, false);
  try { assert.equal(restored.store.job(job.id)?.status, 'paused'); assert.equal(source.articleRequests.length, 0); restored.resume(job.id); await restored.idle(); assert.equal(restored.store.job(job.id)?.status, 'completed'); }
  finally { await restored.close(); }
});

test('verification stops the shared source, preserves pending entries and never stores raw errors', async t => {
  const { app, source, root } = await setup(t), account = await add(app), one = entry(app, account.id, '101'), two = entry(app, account.id, '102');
  source.articleFailure = { code: 'verification', blocked: true, message: 'https://mp.weixin.qq.com/?key=SUPER_SECRET' };
  const job = app.archive.createArchiveJob(account.id, [one.id, two.id]); await app.archive.idle();
  assert.equal(app.archive.store.job(job.id)?.status, 'blocked'); assert.equal(app.archive.store.job(job.id)?.failed, 1); assert.equal(source.articleRequests.length, 1);
  assert.equal(app.archive.store.jobItems(job.id)[1].status, 'pending'); assert.equal(app.archive.summary().connectionBlocked, true);
  const resume = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/resume`, payload: {} }); assert.equal(resume.statusCode, 409);
  assert.ok(!JSON.stringify((await app.inject('/api/jobs')).json()).includes('SUPER_SECRET'));
  assert.ok(!(await readFile(join(root, 'db', 'archive.sqlite-wal'))).includes(Buffer.from('SUPER_SECRET')));
  source.articleFailure = undefined; await app.archive.connect(account.id); app.archive.resume(job.id); await app.archive.idle();
  assert.equal(app.archive.store.job(job.id)?.status, 'completed'); assert.equal(app.archive.summary().connectionBlocked, false);
});

test('bounded history discovery records partial coverage and repeated discovery is idempotent', async t => {
  const { app, source } = await setup(t), account = await add(app);
  app.archive.createDiscoveryJob(account.id, 2); await app.archive.idle();
  assert.deepEqual(source.pageRequests, [0, 1]); assert.equal(app.archive.account(account.id).coverage.complete, false); assert.equal(app.archive.store.articles().length, 2);
  app.archive.createDiscoveryJob(account.id, 10); await app.archive.idle();
  assert.equal(app.archive.account(account.id).coverage.complete, true); assert.equal(app.archive.store.articles().length, 3); assert.equal(source.imageRequests.length, 0);
});

test('missing session explains waiting state and disabled policy stays persisted', async t => {
  const { app, source } = await setup(t), account = await add(app); source.connected = false;
  const job = app.archive.createDiscoveryJob(account.id); await app.archive.idle();
  assert.equal(app.archive.store.job(job.id)?.status, 'waiting_session'); assert.equal(source.pageRequests.length, 0);
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/accounts/${account.id}`, payload: { updatePolicy: 'discover', intervalMinutes: 5 } })).statusCode, 200);
  const manual = await app.inject({ method: 'PATCH', url: `/api/accounts/${account.id}`, payload: { updatePolicy: 'manual' } }); assert.equal(manual.json<{ updatePolicy: string }>().updatePolicy, 'manual');
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/accounts/${account.id}`, payload: { intervalMinutes: 0 } })).statusCode, 400);
});

test('legacy import copies verified files, preserves originals and rejects directory escape', async t => {
  const { app, root } = await setup(t);
  const legacy = join(root, 'legacy'), dir = join(legacy, 'old-article'); await mkdir(join(dir, 'images'), { recursive: true });
  const meta = { biz: BIZ, mid: '101', idx: '1', account: '旧公众号', title: '旧文章', url: url('101'), publishTime: '2025-01-01', imageCount: 1,
    images: [{ seq: 1, src: image('101', 1), file: '001.png', sha1: createHash('sha1').update(PNG).digest('hex'), bytes: PNG.length }] };
  await writeFile(join(dir, 'images', '001.png'), PNG); await writeFile(join(dir, 'meta.json'), JSON.stringify(meta)); await writeFile(join(dir, 'article.md'), '# 旧文章\n---\n正文\n![](images/001.png)');
  const index = JSON.stringify({ ...meta, dir }) + '\n'; await writeFile(join(legacy, 'index.jsonl'), index);
  const imported = await app.inject({ method: 'POST', url: '/api/import', payload: { path: legacy, limit: 1 } });
  assert.equal(imported.statusCode, 200); assert.equal(imported.json<{ articles: number }>().articles, 1); assert.equal(imported.json<{ images: number }>().images, 1); assert.equal(app.archive.store.articles()[0].status, 'complete');
  assert.deepEqual(await readFile(join(dir, 'images', '001.png')), PNG); assert.equal(await readFile(join(legacy, 'index.jsonl'), 'utf8'), index);
  const reimport = await app.inject({ method: 'POST', url: '/api/import', payload: { path: legacy } }); assert.equal(reimport.json<{ images: number }>().images, 0); assert.equal(app.archive.store.articles().length, 1);
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(legacy, 'index.jsonl'), JSON.stringify({ ...meta, dir: outside }));
  const escaped = await app.inject({ method: 'POST', url: '/api/import', payload: { path: legacy } }); assert.equal(escaped.json<{ skipped: number }>().skipped, 1); assert.equal(app.archive.store.articles().length, 1);
});

test('page-limited history can continue from its saved cursor in equal-sized batches', async t => {
  const { app, source } = await setup(t), account = await add(app);
  const job = app.archive.createDiscoveryJob(account.id, 1); await app.archive.idle();
  assert.equal(app.archive.store.job(job.id)?.status, 'paused');
  app.archive.resume(job.id); await app.archive.idle();
  assert.deepEqual(source.pageRequests, [0, 1]);
  assert.equal(app.archive.store.job(job.id)?.status, 'paused');
  app.archive.resume(job.id); await app.archive.idle();
  assert.deepEqual(source.pageRequests, [0, 1, 2]);
  assert.equal(app.archive.store.job(job.id)?.coverage?.complete, true);
  assert.equal(app.archive.store.job(job.id)?.status, 'completed');
});

test('automatic download retains articles discovered before a page interruption', async t => {
  const { app, source } = await setup(t), account = await add(app);
  const original = source.discoverPage.bind(source);
  let fail = true;
  source.discoverPage = async (biz, offset) => {
    if (offset === 1 && fail) { fail = false; source.pageRequests.push(offset); throw { code: 'network' }; }
    return original(biz, offset);
  };
  const job = app.archive.createDiscoveryJob(account.id, 3, true); await app.archive.idle();
  assert.equal(app.archive.store.job(job.id)?.status, 'failed');
  assert.equal(app.archive.store.articles().length, 1);
  app.archive.resume(job.id); await app.archive.idle();
  assert.equal(app.archive.store.articles({ status: 'complete' }).length, 3);
  assert.equal(source.imageRequests.length, 6);
});

test('a damaged older import cannot replace an already complete local article', async t => {
  const { app, root } = await setup(t), account = await add(app), original = entry(app, account.id, '101');
  app.archive.createArchiveJob(account.id, [original.id]); await app.archive.idle();
  const before = app.archive.article(original.id);
  const legacy = join(root, 'older-backup'), dir = join(legacy, 'old-article'); await mkdir(join(dir, 'images'), { recursive: true });
  const meta = { biz: BIZ, mid: '101', idx: '1', account: '旧公众号', title: '不完整旧版本', url: url('101'), imageCount: 1,
    images: [{ seq: 1, src: image('101', 1), file: 'missing.png' }] };
  await writeFile(join(dir, 'meta.json'), JSON.stringify(meta)); await writeFile(join(dir, 'article.md'), '# 旧版\n---\n不应覆盖现有正文\n![](images/missing.png)');
  await writeFile(join(legacy, 'index.jsonl'), JSON.stringify({ ...meta, dir }));
  await app.inject({ method: 'POST', url: '/api/import', payload: { path: legacy } });
  const after = app.archive.article(original.id);
  assert.equal(after.status, 'complete'); assert.equal(after.imageCount, 2); assert.equal(after.savedImageCount, 2);
  assert.deepEqual(after.blocks, before.blocks); assert.equal(after.title, before.title);
  for (const asset of app.archive.store.storedAssets(original.id)) assert.ok(await app.archive.validAsset(asset));
});

test('resume while a request is still pausing cannot lose the resume intent', async t => {
  const { app, source } = await setup(t), account = await add(app), article = entry(app, account.id, '101');
  let started!: () => void; const pending = new Promise<void>(resolve => { started = resolve; });
  source.holdImage = true; source.onImage = started;
  const job = app.archive.createArchiveJob(account.id, [article.id]); await pending;
  app.archive.pause(job.id);
  assert.throws(() => app.archive.resume(job.id), /暂停/);
  await app.archive.idle(); source.holdImage = false;
  app.archive.resume(job.id); await app.archive.idle();
  assert.equal(app.archive.store.job(job.id)?.status, 'completed');
});

test('an older partial import cannot replace a valid image belonging to the preserved body', async t => {
  const { app, source, root } = await setup(t), account = await add(app), original = entry(app, account.id, '101');
  source.failImageOnce = image('101', 2);
  const job = app.archive.createArchiveJob(account.id, [original.id]); await app.archive.idle();
  const before = app.archive.store.storedAssets(original.id)[0];
  const legacy = join(root, 'changed-backup'), dir = join(legacy, 'old'); await mkdir(join(dir, 'images'), { recursive: true });
  const meta = { biz: BIZ, mid: '101', idx: '1', account: '旧公众号', title: '不同旧版本', url: url('101'), imageCount: 1,
    images: [{ seq: 1, src: image('old-version', 1), file: '001.png' }] };
  await writeFile(join(dir, 'images', '001.png'), PNG); await writeFile(join(dir, 'meta.json'), JSON.stringify(meta));
  await writeFile(join(dir, 'article.md'), '# 旧版\n---\n不同正文\n![](images/001.png)');
  await writeFile(join(legacy, 'index.jsonl'), JSON.stringify({ ...meta, dir }));
  const result = await app.inject({ method: 'POST', url: '/api/import', payload: { path: legacy } });
  assert.equal(result.statusCode, 200); assert.equal(app.archive.article(original.id).status, 'partial');
  assert.equal(app.archive.article(original.id).imageCount, 2);
  assert.deepEqual(app.archive.store.storedAssets(original.id)[0], before);
  app.archive.resume(job.id); await app.archive.idle();
  assert.equal(app.archive.article(original.id).status, 'complete');
});

test('duplicate startup reuses an existing app without opening or changing its database', async t => {
  const { root } = await setup(t);
  const listener = createServer((_request, response) => { response.setHeader('X-Wechat-Archive', '1'); response.end('{"ok":true}'); });
  await new Promise<void>((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
  t.after(() => new Promise<void>(done => listener.close(() => done())));
  const port = (listener.address() as { port: number }).port;
  const untouched = join(root, 'must-not-be-created');
  const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
    cwd: resolve('.'), env: { ...process.env, PORT: String(port), WECHAT_ARCHIVE_DATA: untouched }, windowsHide: true, timeout: 15000,
  });
  assert.match(child.stdout, /已在运行/);
  await assert.rejects(readFile(join(untouched, 'archive.sqlite')), { code: 'ENOENT' });
});

test('scheduled discovery respects manual policy, expired sessions and explicit automatic download', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const { app, source } = await setup(t, true), account = await add(app);
  const due = (policy: 'manual' | 'discover' | 'download') => app.archive.store.saveAccount({ ...app.archive.account(account.id), updatePolicy: policy, nextCheckAt: new Date(0).toISOString() });
  due('manual'); t.mock.timers.tick(30_000); await app.archive.idle();
  assert.equal(source.pageRequests.length, 0);
  source.connected = false; due('discover'); t.mock.timers.tick(30_000); await app.archive.idle();
  assert.equal(source.pageRequests.length, 0); assert.equal(app.archive.account(account.id).connection, 'expired');
  source.connected = true; due('discover'); t.mock.timers.tick(30_000); await app.archive.idle();
  assert.equal(app.archive.store.articles().length, 3); assert.equal(source.imageRequests.length, 0);
  source.discoverPage = async (_biz, offset) => {
    source.pageRequests.push(offset);
    return { entries: [{ url: url('501'), title: '新文章', publishedAt: '2026-10-24' }], nextOffset: offset, canContinue: false };
  };
  due('download'); t.mock.timers.tick(30_000); await app.archive.idle();
  assert.equal(app.archive.store.articles().length, 4); assert.equal(app.archive.store.articles({ status: 'complete' }).length, 1);
  assert.equal(source.imageRequests.length, 2);
  due('download'); t.mock.timers.tick(30_000); await app.archive.idle();
  assert.equal(source.imageRequests.length, 2); assert.equal(app.archive.store.jobs().filter(job => job.kind === 'archive').length, 1);
});
