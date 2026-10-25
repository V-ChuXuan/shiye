import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { createApp, type AppOptions, type ArchiveApp } from '../server/app.js';
import type { Collector } from '../shared/types.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const BIZ = 'MzkzNzg5Njc2MQ==';
const source: Collector = {
  fetchArticle: async () => { throw new Error('No network expected'); },
  fetchImage: async () => { throw new Error('No network expected'); },
  captureSession: async () => {}, hasSession: () => false, getGate: () => null, clearGate: () => {},
  discoverPage: async () => { throw new Error('No network expected'); },
};
async function fixture(t: test.TestContext, options: Partial<AppOptions> = {}) {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'settings-test-')), dataDir = join(root, 'data');
  const open = () => createApp({ dataDir, source, schedulerEnabled: false, staticDir: join(root, 'no-client'), ...options });
  let app = await open();
  t.after(async () => { await app.close(); assert.ok(root.startsWith(`${parent}${sep}settings-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, dataDir, get app() { return app; }, async restart() { await app.close(); app = await open(); } };
}
function article(app: ArchiveApp, mid = '101') {
  const account = app.archive.store.upsertAccount(BIZ, '本地保存测试');
  return app.archive.store.upsertArticle({ accountId: account.id, biz: BIZ, mid, idx: '1', title: `文章${mid}`,
    url: `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(BIZ)}&mid=${mid}&idx=1`,
    blocks: [{ type: 'image', seq: 1 }], imageCount: 1, status: 'complete' });
}

test('settings expose an isolated default and about uses the package version', async t => {
  const f = await fixture(t);
  const settings = await f.app.inject('/api/settings'); assert.equal(settings.statusCode, 200);
  const value = settings.json(); assert.equal(value.imageDirectory, join(f.dataDir, 'pictures')); assert.equal(value.defaultImageDirectory, join(f.dataDir, 'pictures'));
  const about = (await f.app.inject('/api/about')).json(); assert.equal(about.name, '拾页'); assert.equal(about.version, JSON.parse(await readFile('package.json', 'utf8')).version);
});

test('moving registered images preserves public resource URLs and survives restart', async t => {
  const f = await fixture(t), a = article(f.app);
  await f.app.archive.saveImage(a.id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/640', status: 'pending' }, PNG, 'png', 'image/png');
  const oldFile = await f.app.archive.filePath(f.app.archive.store.storedAssets(a.id)[0].file!);
  const before = f.app.archive.article(a.id), target = join(f.root, 'chosen');
  const response = await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: target, migrateExisting: true } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().migratedImages, 1); assert.deepEqual(response.json().warnings, []);
  await assert.rejects(readFile(oldFile));
  assert.deepEqual(f.app.archive.article(a.id), before);
  assert.deepEqual((await f.app.inject(before.assets[0].localUrl!)).rawPayload, PNG);
  await f.restart(); assert.equal((await f.app.inject('/api/settings')).json().imageDirectory, target);
  assert.deepEqual((await f.app.inject(before.assets[0].localUrl!)).rawPayload, PNG);
});

test('legacy library images migrate without touching unrelated files, database or article state', async t => {
  const f = await fixture(t), a = article(f.app);
  const name = `001-${digest(PNG).slice(0, 12)}.png`, legacy = join(f.dataDir, 'library', a.id);
  await mkdir(legacy, { recursive: true }); await writeFile(join(legacy, name), PNG); await writeFile(join(legacy, 'keep.txt'), 'personal');
  f.app.archive.store.db.prepare('DELETE FROM runtime WHERE key=?').run('image_directory');
  f.app.archive.store.saveAsset(a.id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/640', status: 'complete', file: join('library', a.id, name), mime: 'image/png', sha256: digest(PNG), bytes: PNG.length });
  await f.restart(); assert.equal(f.app.archive.settings().imageDirectory, join(f.dataDir, 'library'));
  const original = f.app.archive.article(a.id), target = join(f.root, 'chosen');
  const response = await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: target, migrateExisting: true } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().migratedImages, 1);
  const moved = f.app.archive.store.storedAssets(a.id)[0];
  assert.deepEqual(await readFile(join(target, moved.file!)), PNG); await assert.rejects(readFile(join(legacy, name)));
  assert.equal(await readFile(join(legacy, 'keep.txt'), 'utf8'), 'personal');
  assert.ok((await readFile(join(f.dataDir, 'archive.sqlite'))).length > 0); assert.deepEqual(f.app.archive.article(a.id), original);
  const b = article(f.app, '102'); await f.app.archive.saveImage(b.id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/640', status: 'pending' }, PNG, 'png', 'image/png');
  assert.ok((await f.app.archive.filePath(f.app.archive.store.storedAssets(b.id)[0].file!)).startsWith(`${target}${sep}`));
  await f.app.archive.updateSettings({ imageDirectory: join(f.root, 'second'), migrateExisting: true }); await f.restart();
  assert.deepEqual((await f.app.inject(original.assets[0].localUrl!)).rawPayload, PNG);
});

test('invalid, protected, nested and conflicting paths do not change settings or delete sources', async t => {
  const f = await fixture(t), a = article(f.app);
  await f.app.archive.saveImage(a.id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/640', status: 'pending' }, PNG, 'png', 'image/png');
  const before = f.app.archive.settings(), asset = f.app.archive.store.storedAssets(a.id)[0], old = await f.app.archive.filePath(asset.file!);
  for (const invalid of ['relative/path', f.dataDir, join(before.imageDirectory, 'child'), resolve('server'), join(f.dataDir, 'covers', 'nested')]) {
    const response = await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: invalid, migrateExisting: true } });
    assert.ok(response.statusCode >= 400); assert.equal(f.app.archive.settings().imageDirectory, before.imageDirectory); assert.deepEqual(await readFile(old), PNG);
  }
  const target = join(f.root, 'conflict'); await mkdir(dirname(join(target, asset.file!)), { recursive: true }); await writeFile(join(target, asset.file!), 'do not replace');
  const response = await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: target, migrateExisting: true } });
  assert.equal(response.statusCode, 409); assert.equal(response.json().code, 'file_conflict');
  assert.equal(await readFile(join(target, asset.file!), 'utf8'), 'do not replace'); assert.deepEqual(await readFile(old), PNG);
  assert.equal(f.app.archive.settings().imageDirectory, before.imageDirectory);
});

test('damaged sources and commit failures retain the original directory and all source files', async t => {
  const f = await fixture(t), a = article(f.app);
  await f.app.archive.saveImage(a.id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/640', status: 'pending' }, PNG, 'png', 'image/png');
  const asset = f.app.archive.store.storedAssets(a.id)[0], from = await f.app.archive.filePath(asset.file!), previous = f.app.archive.settings().imageDirectory;
  await writeFile(from, 'damaged');
  assert.equal((await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: join(f.root, 'bad-source'), migrateExisting: true } })).statusCode, 422);
  assert.equal(await readFile(from, 'utf8'), 'damaged'); assert.equal(f.app.archive.settings().imageDirectory, previous);
  await writeFile(from, PNG);
  const original = f.app.archive.store.saveImageDirectory;
  f.app.archive.store.saveImageDirectory = () => { throw new Error('forced commit failure'); };
  try {
    await assert.rejects(f.app.archive.updateSettings({ imageDirectory: join(f.root, 'failed-commit'), migrateExisting: true }));
    assert.deepEqual(await readFile(from), PNG); assert.equal(f.app.archive.settings().imageDirectory, previous);
  } finally { f.app.archive.store.saveImageDirectory = original; }
});

test('post-commit cleanup leaves user-modified originals in place and reports a warning', async t => {
  const f = await fixture(t), a = article(f.app);
  await f.app.archive.saveImage(a.id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/640', status: 'pending' }, PNG, 'png', 'image/png');
  const asset = f.app.archive.store.storedAssets(a.id)[0], from = await f.app.archive.filePath(asset.file!), original = f.app.archive.store.saveImageDirectory;
  f.app.archive.store.saveImageDirectory = function (path: string) { original.call(this, path); writeFileSync(from, 'modified by user'); };
  const response = await f.app.archive.updateSettings({ imageDirectory: join(f.root, 'changed-original'), migrateExisting: true });
  assert.equal(response.warnings.length, 1); assert.equal(await readFile(from, 'utf8'), 'modified by user');
  assert.deepEqual((await f.app.inject(f.app.archive.article(a.id).assets[0].localUrl!)).rawPayload, PNG);
  f.app.archive.store.saveImageDirectory = original;
});

test('a target changed during commit cannot cause the verified source to be removed', async t => {
  const f = await fixture(t), a = article(f.app);
  await f.app.archive.saveImage(a.id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/640', status: 'pending' }, PNG, 'png', 'image/png');
  const asset = f.app.archive.store.storedAssets(a.id)[0], from = await f.app.archive.filePath(asset.file!);
  const target = join(f.root, 'changed-target'), original = f.app.archive.store.saveImageDirectory;
  f.app.archive.store.saveImageDirectory = function (path: string) {
    original.call(this, path); writeFileSync(join(target, asset.file!), 'changed after target validation');
  };
  try {
    const response = await f.app.archive.updateSettings({ imageDirectory: target, migrateExisting: true });
    assert.equal(response.warnings.length, 1);
    assert.deepEqual(await readFile(from), PNG);
  } finally { f.app.archive.store.saveImageDirectory = original; }
});

test('migration and direct writes exclude competing jobs/imports and closing waits for successful or failed moves', async t => {
  const f = await fixture(t), a = article(f.app), asset = { seq: 1, src: 'https://mmbiz.qpic.cn/test/640', status: 'pending' as const };
  const writing = f.app.archive.saveImage(a.id, asset, PNG, 'png', 'image/png');
  assert.throws(() => f.app.archive.updateSettings({ imageDirectory: join(f.root, 'too-early'), migrateExisting: true }), /等待/); await writing;
  const move = f.app.archive.updateSettings({ imageDirectory: join(f.root, 'moving'), migrateExisting: true });
  assert.throws(() => f.app.archive.createArchiveJob(a.accountId, [a.id]), /迁移/);
  assert.throws(() => f.app.archive.createDiscoveryJob(a.accountId), /迁移/);
  assert.throws(() => f.app.archive.saveImage(a.id, asset, PNG, 'png', 'image/png'), /迁移/);
  await assert.rejects(f.app.archive.beginImport(), /迁移/);
  await Promise.all([move, f.app.close()]); await f.restart();
  const original = f.app.archive.store.saveImageDirectory;
  f.app.archive.store.saveImageDirectory = () => { throw new Error('fail during close'); };
  const failure = f.app.archive.updateSettings({ imageDirectory: join(f.root, 'failed-move'), migrateExisting: true });
  await Promise.all([assert.rejects(failure), f.app.close()]); assert.equal(f.app.archive.store.db.open, false);
  f.app.archive.store.saveImageDirectory = original; await f.restart();
  assert.deepEqual((await f.app.inject(f.app.archive.article(a.id).assets[0].localUrl!)).rawPayload, PNG);
});

test('directory picker cancellation and Unicode selection do not save settings', async t => {
  let selected: string | null = null, calls = 0;
  const initial: string[] = [];
  const f = await fixture(t, { chooseDirectory: async directory => { initial.push(directory); calls++; return selected; } });
  const before = f.app.archive.settings().imageDirectory;
  assert.deepEqual((await f.app.inject({ method: 'POST', url: '/api/settings/choose-directory', payload: {} })).json(), { path: null });
  selected = join(f.root, '中文 目录');
  assert.deepEqual((await f.app.inject({ method: 'POST', url: '/api/settings/choose-directory', payload: {} })).json(), { path: selected });
  assert.equal(calls, 2); assert.deepEqual(initial, [before, before]); assert.equal(f.app.archive.settings().imageDirectory, before);
  assert.equal((await f.app.inject({ method: 'PUT', url: '/api/settings', headers: { origin: 'https://evil.example' }, payload: { imageDirectory: selected, migrateExisting: true } })).statusCode, 403);

});

test('directory picker excludes concurrent opens and recovers after failure', async t => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(done => { entered = done; });
  const held = new Promise<void>(done => { release = done; });
  let calls = 0;
  const f = await fixture(t, { chooseDirectory: async () => {
    if (++calls === 1) { entered(); await held; throw new Error('private picker failure'); }
    return null;
  } });
  const before = f.app.archive.settings();
  const first = f.app.inject({ method: 'POST', url: '/api/settings/choose-directory', payload: {} }).then(response => response);
  await started;
  const busy = await f.app.inject({ method: 'POST', url: '/api/settings/choose-directory', payload: {} });
  assert.equal(busy.statusCode, 409); assert.equal(busy.json().code, 'busy'); assert.equal(calls, 1);
  release();
  const failed = await first;
  assert.equal(failed.statusCode, 422); assert.equal(failed.json().code, 'directory_picker_failed');
  assert.equal(failed.body.includes('private picker failure'), false);
  assert.deepEqual((await f.app.inject({ method: 'POST', url: '/api/settings/choose-directory', payload: {} })).json(), { path: null });
  assert.equal(calls, 2); assert.deepEqual(f.app.archive.settings(), before);
});

test('modern directory picker preserves Windows PowerShell Unicode and compiles without opening a window', async () => {
  const bytes = await readFile('scripts/choose-directory.ps1');
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'Windows PowerShell needs a BOM to read Chinese source.');
  assert.equal(bytes.toString('utf8').includes('FolderBrowserDialog'), false);
  if (process.platform === 'win32') {
    const script = resolve('scripts/choose-directory.ps1').replaceAll("'", "''");
    const command = `$ProgressPreference='SilentlyContinue';$tokens=$null;$errors=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile('${script}',[ref]$tokens,[ref]$errors);if($errors.Count){throw $errors[0]};$definition=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type' -and $node.Extent.Text -match '-TypeDefinition'},$true);if($definition.Count -ne 1){throw 'Missing native definition'};Invoke-Expression $definition[0].Extent.Text;$title=$ast.FindAll({param($node) $node -is [System.Management.Automation.Language.StringConstantExpressionAst] -and $node.Value -eq '选择文件夹'},$true);if($title.Count -ne 1){throw 'Chinese title was not decoded'};Write-Output 'valid'`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
    assert.equal(output.trim(), 'valid');
  }
});

test('linked target directories cannot redirect registered image writes', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside'), linked = join(f.root, 'linked');
  await mkdir(outside);
  try { await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) { t.skip('Directory links require additional host permissions'); return; } throw error; }
  const before = f.app.archive.settings().imageDirectory;
  const response = await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: linked, migrateExisting: true } });
  assert.equal(response.statusCode, 422); assert.equal(f.app.archive.settings().imageDirectory, before);
});

test('downloads and read-only legacy imports use the selected directory after migration', async t => {
  const localSource = { ...source, fetchImage: async () => ({ buffer: PNG, ext: 'png', mime: 'image/png', sha256: digest(PNG) }) };
  const f = await fixture(t, { source: localSource }), target = join(f.root, 'selected');
  await f.app.archive.updateSettings({ imageDirectory: target, migrateExisting: true });
  const a = article(f.app);
  f.app.archive.store.setArticle(a.id, { status: 'discovered' });
  f.app.archive.store.saveAsset(a.id, { seq: 1, src: 'https://mmbiz.qpic.cn/download/640', status: 'pending' });
  f.app.archive.createArchiveJob(a.accountId, [a.id]); await f.app.archive.idle();
  assert.equal(f.app.archive.article(a.id).status, 'complete');
  assert.ok((await f.app.archive.filePath(f.app.archive.store.storedAssets(a.id)[0].file!)).startsWith(`${target}${sep}`));
  const legacy = join(f.root, 'import-source'), document = join(legacy, 'sample');
  await mkdir(join(document, 'images'), { recursive: true }); await writeFile(join(document, 'images', '001.png'), PNG);
  const metadata = { biz: BIZ, mid: '102', idx: '1', account: '旧资料', title: '迁移后导入', url: `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(BIZ)}&mid=102&idx=1`, imageCount: 1, images: [{ seq: 1, src: 'https://mmbiz.qpic.cn/import/640', file: '001.png', bytes: PNG.length }] };
  await writeFile(join(document, 'meta.json'), JSON.stringify(metadata)); await writeFile(join(document, 'article.md'), '# 标题\n---\n正文\n![](images/001.png)');
  await writeFile(join(legacy, 'index.jsonl'), JSON.stringify({ ...metadata, dir: document }) + '\n');
  const response = await f.app.inject({ method: 'POST', url: '/api/import', payload: { path: legacy } });
  assert.equal(response.statusCode, 200); assert.equal(response.json().images, 1); assert.deepEqual(await readFile(join(document, 'images', '001.png')), PNG);
  const imported = f.app.archive.store.articles().find(item => item.mid === '102')!;
  assert.equal(imported.status, 'complete'); assert.ok((await f.app.archive.filePath(f.app.archive.store.storedAssets(imported.id)[0].file!)).startsWith(`${target}${sep}`));
  const queued = f.app.archive.store.createJob(f.app.archive.account(a.accountId), 'archive', [a.id]);
  assert.equal((await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: join(f.root, 'while-queued'), migrateExisting: true } })).statusCode, 409);
  f.app.archive.store.saveJob({ ...queued, status: 'paused' });
});

test('saving a new location defaults to keeping old images and later migration gathers every recorded root', async t => {
  const f = await fixture(t), a = article(f.app, '201');
  const save = async (id: string) => f.app.archive.saveImage(id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/640', status: 'pending' }, PNG, 'png', 'image/png');
  await save(a.id);
  const original = await f.app.archive.filePath(f.app.archive.store.storedAssets(a.id)[0].file!);
  const second = join(f.root, 'second-root'), target = join(f.root, 'final-root');
  const firstChange = await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: second } });
  assert.equal(firstChange.statusCode, 200); assert.equal(firstChange.json().migratedImages, 0);
  assert.deepEqual(await readFile(original), PNG);
  await f.restart();
  assert.deepEqual((await f.app.inject(`/api/assets/${a.id}/1`)).rawPayload, PNG);
  const b = article(f.app, '202'); await save(b.id);
  const secondFile = await f.app.archive.filePath(f.app.archive.store.storedAssets(b.id)[0].file!);
  const change = await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: target, migrateExisting: false } });
  assert.equal(change.statusCode, 200); assert.equal(change.json().migratedImages, 0);
  const c = article(f.app, '203'); await save(c.id);
  const targetFile = await f.app.archive.filePath(f.app.archive.store.storedAssets(c.id)[0].file!);
  await f.restart();
  for (const item of [a, b, c]) {
    const detail = f.app.archive.article(item.id);
    assert.equal(detail.status, 'complete'); assert.equal(detail.savedImageCount, 1);
    assert.equal('storageDirectory' in detail.assets[0], false, 'Internal image roots must not be exposed in public assets.');
    assert.deepEqual((await f.app.inject(`/api/assets/${item.id}/1`)).rawPayload, PNG);
  }
  const migrated = await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: target, migrateExisting: true } });
  assert.equal(migrated.statusCode, 200); assert.equal(migrated.json().migratedImages, 2);
  assert.deepEqual(migrated.json().warnings, []);
  await assert.rejects(readFile(original)); await assert.rejects(readFile(secondFile));
  assert.deepEqual(await readFile(targetFile), PNG, 'Images already in the destination must never be removed.');
  await f.restart();
  for (const item of [a, b, c]) assert.deepEqual((await f.app.inject(`/api/assets/${item.id}/1`)).rawPayload, PNG);
});

test('migration requires a real boolean and a default location change does not require readable old files', async t => {
  const f = await fixture(t), a = article(f.app);
  await f.app.archive.saveImage(a.id, { seq: 1, src: 'https://mmbiz.qpic.cn/test/640', status: 'pending' }, PNG, 'png', 'image/png');
  const file = await f.app.archive.filePath(f.app.archive.store.storedAssets(a.id)[0].file!), current = f.app.archive.settings().imageDirectory;
  for (const migrateExisting of ['false', 'true', 1, null]) {
    const response = await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: join(f.root, 'invalid'), migrateExisting } });
    assert.equal(response.statusCode, 400); assert.equal(f.app.archive.settings().imageDirectory, current);
  }
  await writeFile(file, 'already damaged');
  const changed = await f.app.inject({ method: 'PUT', url: '/api/settings', payload: { imageDirectory: join(f.root, 'new-only') } });
  assert.equal(changed.statusCode, 200); assert.equal(changed.json().migratedImages, 0);
  assert.equal(await readFile(file, 'utf8'), 'already damaged');
});
