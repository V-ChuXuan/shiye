import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createApp } from '../server/app.js';
import type { Collector } from '../shared/types.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const hash = createHash('sha256').update(PNG).digest('hex');
const source: Collector = { fetchArticle: async () => { throw Error('No source'); }, fetchImage: async () => { throw Error('No source'); }, captureSession: async () => {}, hasSession: () => false, getGate: () => null, clearGate() {}, discoverPage: async () => { throw Error('No source'); } };
async function fixture(t: test.TestContext) {
  const parent = resolve('data'), root = await mkdtemp(join(parent, 'layout-test-'));
  const open = () => createApp({ dataDir: join(root, 'db'), source, schedulerEnabled: false, staticDir: join(root, 'no-client') });
  let app = await open();
  t.after(async () => { await app.close(); assert.ok(root.startsWith(`${parent}${sep}layout-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, get app() { return app; }, async restart() { await app.close(); app = await open(); } };
}
function article(app: Awaited<ReturnType<typeof createApp>>, biz = 'AccountFirst==', name = '一只条条吖', title = '可读文章标题', mid = '101') {
  const account = app.archive.store.upsertAccount(biz, name);
  return app.archive.store.upsertArticle({ accountId: account.id, biz, mid, title, url: `https://mp.weixin.qq.com/s?__biz=${biz}&mid=${mid}&idx=1`, status: 'complete', imageCount: 1, blocks: [{ type: 'image', seq: 1 }] });
}
const save = (app: Awaited<ReturnType<typeof createApp>>, id: string, seq = 1) => app.archive.saveImage(id, { seq, src: 'https://mmbiz.qpic.cn/test/0', status: 'pending' }, PNG, 'png', 'image/png');

test('images use readable account/title folders and keep assigned paths after rename and restart', async t => {
  const f = await fixture(t), a = article(f.app); await save(f.app, a.id);
  const original = f.app.archive.store.storedAssets(a.id)[0];
  assert.deepEqual(dirname(original.file!).split(sep), ['一只条条吖', '可读文章标题']);
  const account = f.app.archive.store.account(a.accountId)!;
  f.app.archive.store.saveAccount({ ...account, name: '修改后的公众号名' }); f.app.archive.store.setArticle(a.id, { title: '修改标题' });
  await f.restart(); await save(f.app, a.id, 2);
  assert.equal(dirname(f.app.archive.store.storedAssets(a.id)[1].file!), dirname(original.file!));
  assert.deepEqual((await f.app.inject(`/api/assets/${a.id}/1`)).rawPayload, PNG);
});

test('same names have separate ownership and Windows names stay bounded and safe', async t => {
  const f = await fixture(t), entries = [article(f.app), article(f.app, 'AccountSecond=='), article(f.app, 'AccountFirst==', '一只条条吖', '可读文章标题', '102'), article(f.app, 'AccountThird==', 'CON. ', 'NUL.txt'), article(f.app, 'AccountFourth==', '公/众\\号:*?<>|', '标/题\\:' + '很长标题'.repeat(80))];
  const files = [];
  for (const a of entries) { await save(f.app, a.id); const asset = f.app.archive.store.storedAssets(a.id)[0]; files.push(asset.file!); const path = await f.app.archive.filePath(asset.file!); assert.ok(path.length <= 240, path); assert.deepEqual(await readFile(path), PNG); }
  assert.equal(new Set(files.map(file => file.toLowerCase())).size, entries.length);
  for (const file of files) for (const part of dirname(file).split(sep)) { assert.ok(!/[<>:"/\\|?*\x00-\x1f]/.test(part)); assert.ok(!/[. ]$/.test(part)); assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)); }
});

test('short duplicate titles retain the account directory when disambiguated', async t => {
  const f = await fixture(t), a = article(f.app, 'ShortAccount==', '号', '文'), b = article(f.app, 'ShortAccount==', '号', '文', '102');
  await save(f.app, a.id); await save(f.app, b.id);
  const paths = [a, b].map(entry => f.app.archive.store.storedAssets(entry.id)[0].file!.split(sep));
  assert.ok(paths.every(parts => parts.length === 3 && parts[0] === '号'));
  assert.equal(paths[0][1], '文'); assert.match(paths[1][1], /^文~[a-f0-9]{8}$/);
});

test('same-root explicit migration organizes legacy files and leaves unknown content untouched', async t => {
  const f = await fixture(t), a = article(f.app), root = f.app.archive.settings().imageDirectory;
  const file = join(a.id, `001-${hash.slice(0, 12)}.png`), old = join(root, file);
  await mkdir(dirname(old), { recursive: true }); await writeFile(old, PNG); await writeFile(join(dirname(old), 'keep.txt'), 'user file');
  f.app.archive.store.saveAsset(a.id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/0', status: 'complete', file, storageDirectory: root, mime: 'image/png', sha256: hash, bytes: PNG.length });
  const before = f.app.archive.article(a.id);
  await f.app.archive.updateSettings({ imageDirectory: root }); assert.equal(f.app.archive.store.storedAssets(a.id)[0].file, file);
  const result = await f.app.archive.updateSettings({ imageDirectory: root, migrateExisting: true });
  assert.equal(result.migratedImages, 1); assert.deepEqual(result.warnings, []);
  const asset = f.app.archive.store.storedAssets(a.id)[0]; assert.deepEqual(dirname(asset.file!).split(sep), ['一只条条吖', '可读文章标题']);
  await assert.rejects(readFile(old)); assert.equal(await readFile(join(dirname(old), 'keep.txt'), 'utf8'), 'user file');
  assert.deepEqual(f.app.archive.article(a.id), before); assert.deepEqual((await f.app.inject(before.assets[0].localUrl!)).rawPayload, PNG);
  assert.equal((await f.app.archive.updateSettings({ imageDirectory: root, migrateExisting: true })).migratedImages, 0);
});

test('same-root conflict or failed transaction preserves old registrations and originals', async t => {
  const f = await fixture(t), a = article(f.app), root = f.app.archive.settings().imageDirectory;
  const file = join(a.id, `001-${hash.slice(0, 12)}.png`), old = join(root, file);
  await mkdir(dirname(old), { recursive: true }); await writeFile(old, PNG);
  f.app.archive.store.saveAsset(a.id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/0', status: 'complete', file, storageDirectory: root, mime: 'image/png', sha256: hash, bytes: PNG.length });
  const target = join(root, '一只条条吖', '可读文章标题', basename(file)); await mkdir(dirname(target), { recursive: true }); await writeFile(target, 'do not overwrite');
  await assert.rejects(f.app.archive.updateSettings({ imageDirectory: root, migrateExisting: true }));
  assert.equal(await readFile(target, 'utf8'), 'do not overwrite'); assert.deepEqual(await readFile(old), PNG); assert.equal(f.app.archive.store.storedAssets(a.id)[0].file, file);
  await rm(target);
  t.mock.method(f.app.archive.store, 'saveImageDirectory', () => { throw Error('commit failed'); });
  await assert.rejects(f.app.archive.updateSettings({ imageDirectory: root, migrateExisting: true }));
  assert.deepEqual(await readFile(old), PNG); assert.equal(f.app.archive.store.storedAssets(a.id)[0].file, file);
  assert.equal((f.app.archive.store.db.prepare("SELECT COUNT(*) AS count FROM runtime WHERE key LIKE 'image_folder:%'").get() as { count: number }).count, 0);
});

test('migration cleanup keeps every target even if another asset originally occupied it', async t => {
  const f = await fixture(t), a = article(f.app), b = article(f.app, 'AccountFirst==', '一只条条吖', '另一篇文章', '102');
  const root = f.app.archive.settings().imageDirectory, name = `001-${hash.slice(0, 12)}.png`;
  const oldA = join(a.id, name), oldB = join('一只条条吖', '可读文章标题', name);
  for (const [entry, file] of [[a, oldA], [b, oldB]] as const) {
    await mkdir(dirname(join(root, file)), { recursive: true }); await writeFile(join(root, file), PNG);
    f.app.archive.store.saveAsset(entry.id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/0', status: 'complete', file, storageDirectory: root, mime: 'image/png', sha256: hash, bytes: PNG.length });
  }
  const result = await f.app.archive.updateSettings({ imageDirectory: root, migrateExisting: true });
  assert.equal(result.migratedImages, 2); assert.deepEqual(result.warnings, []);
  assert.deepEqual(await readFile(join(root, oldB)), PNG, 'An old source that became another target must remain.');
  for (const entry of [a, b]) assert.deepEqual((await f.app.inject(`/api/assets/${entry.id}/1`)).rawPayload, PNG);
});

test('readable folder depth rejects traversal and links at intermediate levels', async t => {
  const f = await fixture(t), a = article(f.app), root = f.app.archive.settings().imageDirectory;
  for (const file of [join('a', 'b', 'c', 'd.png'), 'a/../x.png', 'a/./x.png', 'C:\\private.png']) await assert.rejects(f.app.archive.filePath(file));
  const outside = join(f.root, 'outside'); await mkdir(outside);
  await mkdir(root, { recursive: true }); await symlink(outside, join(root, '一只条条吖'), 'junction');
  await assert.rejects(save(f.app, a.id));
  assert.deepEqual(f.app.archive.store.storedAssets(a.id), []);
});
