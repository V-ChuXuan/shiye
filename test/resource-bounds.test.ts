import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Collector } from '../shared/types.js';
import { ArchiveService } from '../server/service.js';
import { ImageStorage } from '../server/image-storage.js';
import { Store, type StoredAsset } from '../server/store.js';
import { importLegacy } from '../server/legacy.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const wait = () => new Promise<void>(done => setImmediate(done));
async function fixture(t: test.TestContext, count = 200) {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'resource-bounds-'));
  let requests = 0;
  const forbidden = async () => { requests++; throw new Error('This fixture must not request the source.'); };
  const source: Collector = { fetchArticle: forbidden, fetchImage: forbidden, discoverPage: forbidden,
    captureSession: forbidden, hasSession: () => false, getGate: () => null, clearGate() {} };
  const service = new ArchiveService(join(root, 'data'), source, false);
  t.after(async () => { await service.close(); assert.ok(root.startsWith(`${parent}${sep}resource-bounds-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const account = service.store.upsertAccount('ResourceBounds==', '资源回归号');
  const article = service.store.upsertArticle({ accountId: account.id, biz: account.biz, mid: '101', idx: '1',
    title: '多图本地文章', url: 'https://mp.weixin.qq.com/s?__biz=ResourceBounds%3D%3D&mid=101&idx=1', status: 'complete', imageCount: count,
    blocks: Array.from({ length: count }, (_, index) => ({ type: 'image' as const, seq: index + 1 })) });
  for (let seq = 1; seq <= count; seq++) service.store.saveAsset(article.id, { seq, src: `https://mmbiz.qpic.cn/bounds/${seq}/0`,
    status: 'complete', file: `本地文章/${seq}.gif`, bytes: GIF.length, sha256: 'a'.repeat(64) });
  return { root, service, account, article, requests: () => requests };
}
function observe(t: test.TestContext, service: ArchiveService, check: (asset: StoredAsset, call: number) => boolean | Promise<boolean>) {
  let active = 0, peak = 0, calls = 0;
  t.mock.method(service, 'validAsset', async (asset: StoredAsset) => {
    active++; peak = Math.max(peak, active); const call = ++calls;
    try { await wait(); return await check(asset, call); } finally { active--; }
  });
  return { peak: () => peak, calls: () => calls };
}

for (const completedItem of [false, true]) test(`200 reused images are checked one at a time (${completedItem ? 'completed item' : 'final validation'})`, async t => {
  const f = await fixture(t), checks = observe(t, f.service, () => true);
  const job = f.service.createArchiveJob(f.account.id, [f.article.id]);
  if (completedItem) f.service.store.setJobItem(job.id, 0, 'complete');
  await f.service.idle();
  assert.equal(f.service.store.job(job.id)?.status, 'completed');
  assert.equal(f.service.article(f.article.id).status, 'complete');
  assert.equal(checks.calls(), completedItem ? 200 : 400);
  assert.equal(checks.peak(), 1, 'Whole-article checks must not open every image concurrently.');
  assert.equal(f.requests(), 0);
});

test('pausing the first final check stops further checks and cannot mark the article complete', async t => {
  const f = await fixture(t), checks = observe(t, f.service, (_asset, call) => {
    if (call === 201) f.service.pause(job.id);
    return true;
  });
  const job = f.service.createArchiveJob(f.account.id, [f.article.id]);
  await f.service.idle();
  assert.equal(f.service.store.job(job.id)?.status, 'paused');
  assert.equal(f.service.article(f.article.id).status, 'partial');
  assert.equal(checks.calls(), 201, 'Pause must prevent launching the next local file check.');
  assert.equal(f.service.store.storedAssets(f.article.id).length, 200);
  assert.equal(f.requests(), 0);
});

test('a failed final check keeps the archive partial without requesting otherwise valid local images', async t => {
  const f = await fixture(t), checks = observe(t, f.service, (_asset, call) => call !== 225);
  const job = f.service.createArchiveJob(f.account.id, [f.article.id]); await f.service.idle();
  assert.equal(f.service.store.job(job.id)?.status, 'partial');
  assert.equal(f.service.article(f.article.id).status, 'partial');
  assert.equal(f.service.store.jobItems(job.id)[0].status, 'failed');
  assert.equal(checks.peak(), 1); assert.equal(f.requests(), 0);
});

test('configured image roots avoid all asset reads, including roots temporarily unavailable on disk', async t => {
  const f = await fixture(t), root = join(f.root, 'not-mounted'); f.service.store.saveImageDirectory(root);
  const queries: string[] = [], original = f.service.store.db.prepare;
  t.mock.method(f.service.store.db, 'prepare', function (this: Store['db'], sql: string) { queries.push(sql); return original.call(this, sql); });
  const storage = new ImageStorage(f.service.store, join(f.root, 'data'));
  assert.equal(storage.imageDirectory, root);
  assert.equal(queries.some(sql => /\bFROM\s+assets\b/i.test(sql)), false, 'Saved roots do not need any legacy asset lookup.');
});

test('missing image-root settings keep empty, modern and both legacy-prefix defaults without hydrating asset JSON', async t => {
  const f = await fixture(t, 0);
  for (const file of [undefined, '作者/文章/001.gif', 'library/作者/001.gif', 'library\\作者\\001.gif', 'Library/作者/001.gif']) {
    const db = f.service.store.db;
    db.prepare("DELETE FROM runtime WHERE key='image_directory'").run(); db.prepare('DELETE FROM assets').run();
    if (file) f.service.store.saveAsset(f.article.id, { seq: 1, src: '', status: 'pending', file });
    const queries: string[] = [], original = db.prepare;
    t.mock.method(db, 'prepare', function (this: Store['db'], sql: string) { queries.push(sql); return original.call(this, sql); });
    const data = join(f.root, 'data'), defaults = join(f.root, 'default-pictures'), storage = new ImageStorage(f.service.store, data, defaults);
    t.mock.restoreAll();
    assert.equal(storage.imageDirectory, file?.startsWith('library') ? join(data, 'library') : defaults);
    assert.equal(f.service.store.imageDirectory, file ? undefined : defaults, 'Only an empty library establishes the initial remembered default.');
    assert.equal(queries.some(sql => /SELECT\s+data\s+FROM\s+assets\b/i.test(sql)), false, 'Legacy inference must stay in SQL and return only bounded flags.');
  }
});

test('legacy import final validation and complete-article reuse share bounded real-image checks', async t => {
  const f = await fixture(t, 0), legacy = join(f.root, 'legacy'), dir = join(legacy, 'article');
  await mkdir(join(dir, 'images'), { recursive: true });
  const images = Array.from({ length: 200 }, (_, index) => ({ seq: index + 1, file: `${index + 1}.gif`, src: `https://mmbiz.qpic.cn/legacy/${index + 1}/0` }));
  const index = JSON.stringify({ dir: 'article', title: '旧资料多图' });
  const meta = JSON.stringify({ url: 'https://mp.weixin.qq.com/s?__biz=ResourceBounds%3D%3D&mid=202&idx=1', account: f.account.name, title: '旧资料多图', images });
  const body = images.map(image => `![${image.seq}](images/${image.file})`).join('\n');
  await writeFile(join(legacy, 'index.jsonl'), index); await writeFile(join(dir, 'meta.json'), meta); await writeFile(join(dir, 'article.md'), body);
  for (const image of images) await writeFile(join(dir, 'images', image.file), GIF);
  const validate = f.service.validAsset.bind(f.service), checks = observe(t, f.service, asset => validate(asset));
  const imported = await importLegacy(f.service, legacy); assert.equal(imported.articles, 1); assert.equal(imported.images, 200); assert.deepEqual(imported.errors, []);
  const again = await importLegacy(f.service, legacy); assert.equal(again.skipped, 1); assert.equal(again.images, 0); assert.deepEqual(again.errors, []);
  assert.equal(checks.peak(), 1); assert.equal(checks.calls(), 400); assert.equal(f.requests(), 0);
  assert.equal(await readFile(join(legacy, 'index.jsonl'), 'utf8'), index); assert.equal(await readFile(join(dir, 'meta.json'), 'utf8'), meta); assert.equal(await readFile(join(dir, 'article.md'), 'utf8'), body);
  for (const image of images) assert.deepEqual(await readFile(join(dir, 'images', image.file)), GIF);
});
