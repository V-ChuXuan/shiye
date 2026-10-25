import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { backupLibrary, restoreLibrary, LibraryBackupError } from '../server/library-backup.js';
import { Store } from '../server/store.js';
import { createApp } from '../server/app.js';
import { acquireLibraryLock } from '../server/startup.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const manifestLimit = 16 * 1024 * 1024;
function expandManifest(t: test.TestContext, length: number, characters = false) {
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (...args: unknown[]) => {
    const text = Reflect.apply(stringify, JSON, args) as string | undefined;
    if (!text || !args[0] || typeof args[0] !== 'object' || (args[0] as { format?: unknown }).format !== 'shiye-library') return text;
    return text + ' '.repeat(length - (characters ? text.length : Buffer.byteLength(text)));
  });
}
async function fixture(t: test.TestContext) {
  const parent = resolve('data/reliability-verification'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'backup-test-')), library = join(root, '中文文库 空格');
  const store = new Store(join(library, 'data'));
  const account = store.upsertAccount('backup-fixture-biz', '来源作者');
  const article = store.upsertArticle({ accountId: account.id, biz: account.biz, mid: '101', idx: '1', title: '可恢复正文',
    url: 'https://mp.weixin.qq.com/s/backup-fixture', status: 'complete', imageCount: 2,
    blocks: [{ type: 'text', text: '离线正文' }, { type: 'image', seq: 1 }, { type: 'image', seq: 2 }] });
  const first = join(library, 'pictures'), second = join(root, '自选图片 空格');
  for (const [seq, directory] of [[1, first], [2, second]] as const) {
    const file = `来源作者/可恢复正文/00${seq}.png`; await mkdir(join(directory, '来源作者/可恢复正文'), { recursive: true });
    await writeFile(join(directory, file), PNG);
    store.saveAsset(article.id, { seq, src: `https://mmbiz.qpic.cn/backup/${seq}/0`, status: 'complete', file, storageDirectory: directory, bytes: PNG.length, sha256: hash(PNG), mime: 'image/png' });
  }
  store.saveImageDirectory(second);
  store.saveAccount({ ...account, connection: 'connected', updatePolicy: 'download' });
  const job = store.createJob(account, 'archive', [article.id]);
  store.saveJob({ ...job, status: 'running' });
  store.close();
  t.after(async () => { assert.ok(root.startsWith(`${parent}${sep}backup-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { root, library, first, second, account, article, backup: join(root, '备份 空格'), target: join(root, '恢复文库 空格') };
}
async function tree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(path: string) { for (const entry of await readdir(path, { withFileTypes: true })) {
    const file = join(path, entry.name); if (entry.isDirectory()) await walk(file); else if (!/archive\.sqlite-(wal|shm)$/.test(entry.name)) result[file.slice(root.length)] = hash(await readFile(file));
  } }
  await walk(root); return result;
}

test('complete backup gathers multiple roots and restores an offline readable relocated library without modifying originals', async t => {
  const f = await fixture(t), before = await tree(f.library), external = await tree(f.second);
  assert.deepEqual(await backupLibrary(f.library, f.backup), { directory: f.backup, images: 2, articles: 1 });
  assert.deepEqual(await tree(f.library), before); assert.deepEqual(await tree(f.second), external);
  assert.deepEqual(await restoreLibrary(f.backup, f.target), { directory: f.target, images: 2, articles: 1 });
  const db = new Database(join(f.target, 'data/archive.sqlite'), { readonly: true });
  const account = JSON.parse((db.prepare('SELECT data FROM accounts').get() as { data: string }).data);
  const job = JSON.parse((db.prepare('SELECT data FROM jobs').get() as { data: string }).data);
  assert.equal(account.connection, 'disconnected'); assert.equal(account.updatePolicy, 'manual'); assert.equal(job.status, 'paused'); db.close();
  const app = await createApp({ dataDir: join(f.target, 'data'), defaultImageDirectory: join(f.target, 'pictures'), schedulerEnabled: false });
  try {
    const article = app.archive.article(f.article.id); assert.equal(article.status, 'complete'); assert.equal(article.blocks[0].type, 'text');
    for (const asset of article.assets) assert.deepEqual((await app.inject(asset.localUrl!)).rawPayload, PNG);
    assert.equal(app.archive.settings().imageDirectory, join(f.target, 'pictures'));
  } finally { await app.close(); }
  assert.deepEqual(await tree(f.library), before); assert.deepEqual(await tree(f.second), external);
});

test('backup and restore report bounded file progress through validation, copying and publication', async t => {
  const f = await fixture(t), before = await tree(f.library);
  await mkdir(join(f.library, 'data/covers')); await writeFile(join(f.library, `data/covers/${'a'.repeat(64)}.image`), PNG);
  for (const operation of ['backup', 'restore'] as const) {
    const destination = operation === 'backup' ? f.backup : f.target;
    const progress: { phase: string; completed: number; total: number }[] = [];
    const report = (value: { phase: string; completed: number; total: number }) => {
      assert.deepEqual(Object.keys(value).sort(), ['completed', 'phase', 'total']);
      assert.ok(Number.isSafeInteger(value.completed) && Number.isSafeInteger(value.total) && value.completed >= 0 && value.completed <= value.total);
      if (value.phase === 'publishing') assert.equal(existsSync(join(destination, '.shiye-incomplete')), true, 'Publishing progress is not a completed backup.');
      progress.push(value);
    };
    await (operation === 'backup' ? backupLibrary(f.library, destination, undefined, report) : restoreLibrary(f.backup, destination, undefined, report));
    assert.deepEqual(new Set(progress.map(value => value.phase)), new Set(['checking', 'database', 'images', 'covers', 'publishing']));
    for (const phase of ['checking', 'images', 'covers', 'publishing']) {
      const values = progress.filter(value => value.phase === phase);
      assert.ok(values.length >= 2, `${phase} must update while processing files.`);
      assert.equal(values.at(-1)!.completed, values.at(-1)!.total, `${operation} ${phase}: ${JSON.stringify(values)}`);
    }
    assert.equal(existsSync(join(destination, '.shiye-incomplete')), false);
  }
  const after = await tree(f.library); delete after[join(sep, 'data', 'covers', `${'a'.repeat(64)}.image`)];
  assert.deepEqual(after, before);
});

test('restore publication reconciles the final file count after a transient staging sidecar disappears', async t => {
  const f = await fixture(t); await backupLibrary(f.library, f.backup);
  let temporary = '';
  const progress: { completed: number; total: number }[] = [];
  await restoreLibrary(f.backup, f.target, undefined, value => {
    const guard = join(f.target, '.shiye-incomplete');
    if (value.phase === 'database' && existsSync(guard)) {
      temporary = join(f.target, readFileSync(guard, 'utf8'), 'data/archive.sqlite-shm.tmp');
      writeFileSync(temporary, 'transient staging file');
    }
    if (value.phase === 'publishing') {
      if (!value.completed) { assert.ok(temporary); unlinkSync(temporary); }
      assert.equal(existsSync(guard), true);
      assert.ok(value.completed <= value.total);
      progress.push(value);
    }
  });
  assert.equal(progress.at(-1)!.completed, 3);
  assert.equal(progress[0].total, 4);
  assert.equal(progress.at(-1)!.total, 3);
  assert.equal(existsSync(join(f.target, '.shiye-incomplete')), false);
});

test('canceling the final reconciled progress keeps restore incomplete', async t => {
  const f = await fixture(t), controller = new AbortController();
  await backupLibrary(f.library, f.backup);
  let temporary = '';
  await assert.rejects(restoreLibrary(f.backup, f.target, controller.signal, value => {
    const guard = join(f.target, '.shiye-incomplete');
    if (value.phase === 'database' && existsSync(guard)) {
      temporary = join(f.target, readFileSync(guard, 'utf8'), 'data/archive.sqlite-shm.tmp');
      writeFileSync(temporary, 'transient staging file');
    }
    if (value.phase === 'publishing') {
      if (!value.completed) unlinkSync(temporary);
      if (value.completed === 3 && value.total === 3) {
        assert.equal(existsSync(guard), true);
        controller.abort();
      }
    }
  }), { name: 'AbortError' });
  assert.equal(controller.signal.aborted, true);
  assert.equal(existsSync(join(f.target, '.shiye-incomplete')), true);
});

test('an unexpected persistent staging file still prevents completed restore publication', async t => {
  const f = await fixture(t); await backupLibrary(f.library, f.backup);
  const manifest = await readFile(join(f.backup, 'shiye-backup.json'));
  const database = await readFile(join(f.backup, 'database.sqlite'));
  let temporary = '';
  await assert.rejects(restoreLibrary(f.backup, f.target, undefined, value => {
    const guard = join(f.target, '.shiye-incomplete');
    if (value.phase === 'database' && existsSync(guard)) {
      temporary = join(f.target, readFileSync(guard, 'utf8'), 'unexpected-file');
      writeFileSync(temporary, 'keep');
    }
  }), { code: 'ENOTEMPTY' });
  assert.equal(readFileSync(temporary, 'utf8'), 'keep');
  assert.equal(existsSync(join(f.target, '.shiye-incomplete')), true);
  assert.deepEqual(await readFile(join(f.backup, 'shiye-backup.json')), manifest);
  assert.deepEqual(await readFile(join(f.backup, 'database.sqlite')), database);
});

test('canceling from a progress callback never publishes success and releases the source lock', async t => {
  const f = await fixture(t), controller = new AbortController();
  await assert.rejects(backupLibrary(f.library, f.backup, controller.signal, value => { if (value.phase === 'checking' && value.completed === 1) controller.abort(); }));
  assert.equal(existsSync(join(f.backup, 'shiye-backup.json')), false);
  const release = await acquireLibraryLock(join(f.library, 'data')); await release();
});

test('backup refuses oversized serialized manifests before publication and releases its source lock', async t => {
  const f = await fixture(t), before = await tree(f.library), external = await tree(f.second);
  expandManifest(t, manifestLimit + 1);
  await assert.rejects(backupLibrary(f.library, f.backup), error => error instanceof LibraryBackupError && /16 MiB/.test(error.message));
  assert.deepEqual(await tree(f.library), before); assert.deepEqual(await tree(f.second), external);
  await assert.rejects(readFile(join(f.backup, 'shiye-backup.json')), { code: 'ENOENT' });
  assert.ok((await readdir(f.backup)).includes('.shiye-incomplete'));
  const release = await acquireLibraryLock(join(f.library, 'data')); await release();
});

for (const bytes of [manifestLimit - 1, manifestLimit]) test(`a ${bytes}-byte manifest backs up and restores at the shared capacity boundary`, async t => {
  const f = await fixture(t);
  expandManifest(t, bytes);
  await backupLibrary(f.library, f.backup);
  const manifest = await readFile(join(f.backup, 'shiye-backup.json'));
  assert.equal(manifest.length, bytes);
  assert.deepEqual(await restoreLibrary(f.backup, f.target), { directory: f.target, images: 2, articles: 1 });
  await writeFile(join(f.backup, 'shiye-backup.json'), Buffer.concat([manifest, Buffer.alloc(manifestLimit + 1 - bytes, 0x20)]));
  await assert.rejects(restoreLibrary(f.backup, join(f.root, 'over-limit')), LibraryBackupError);
});

test('manifest capacity counts UTF-8 bytes rather than JavaScript characters', async t => {
  const f = await fixture(t), before = await tree(f.library);
  expandManifest(t, manifestLimit, true);
  await assert.rejects(backupLibrary(f.library, f.backup), error => error instanceof LibraryBackupError && /16 MiB/.test(error.message));
  assert.deepEqual(await tree(f.library), before);
  await assert.rejects(readFile(join(f.backup, 'shiye-backup.json')), { code: 'ENOENT' });
});

test('backup rejects active libraries, missing registered images and destinations inside an image root', async t => {
  const f = await fixture(t), release = await acquireLibraryLock(join(f.library, 'data'));
  try { await assert.rejects(backupLibrary(f.library, f.backup)); } finally { await release(); }
  await assert.rejects(backupLibrary(f.library, join(f.second, 'nested')));
  await rm(join(f.second, '来源作者/可恢复正文/002.png'));
  await assert.rejects(backupLibrary(f.library, f.backup));
  await assert.rejects(readFile(join(f.backup, 'shiye-backup.json')));
});

test('restore rejects corruption, directory links, path traversal, nonempty targets and added executable SQLite schema', async t => {
  const f = await fixture(t); await backupLibrary(f.library, f.backup);
  await mkdir(f.target); await writeFile(join(f.target, 'mine.txt'), 'keep');
  await assert.rejects(restoreLibrary(f.backup, f.target)); assert.equal(await readFile(join(f.target, 'mine.txt'), 'utf8'), 'keep');
  const manifestPath = join(f.backup, 'shiye-backup.json'), original = await readFile(manifestPath, 'utf8'), manifest = JSON.parse(original);
  manifest.files[0].path = '../escape'; await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restoreLibrary(f.backup, join(f.root, 'unsafe'))); await writeFile(manifestPath, original);
  const image = manifest.files.find((file: { path: string }) => file.path.startsWith('assets/'));
  const imagePath = join(f.backup, image.path), bytes = await readFile(imagePath); await writeFile(imagePath, 'corrupt');
  await assert.rejects(restoreLibrary(f.backup, join(f.root, 'corrupt'))); await writeFile(imagePath, bytes);
  const linked = join(f.root, 'linked');
  try { await symlink(f.backup, linked, process.platform === 'win32' ? 'junction' : 'dir'); await assert.rejects(restoreLibrary(linked, join(f.root, 'link-result'))); }
  catch (error) { if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
  const dbFile = join(f.backup, 'database.sqlite'), db = new Database(dbFile); db.exec('CREATE TRIGGER extra AFTER INSERT ON runtime BEGIN DELETE FROM articles; END'); db.close();
  const schemaManifest = JSON.parse(original); const changed = await readFile(dbFile);
  Object.assign(schemaManifest.files.find((file: { path: string }) => file.path === 'database.sqlite'), { bytes: changed.length, sha256: hash(changed) });
  await writeFile(manifestPath, JSON.stringify(schemaManifest)); await assert.rejects(restoreLibrary(f.backup, join(f.root, 'schema')));
});

test('an empty library can be backed up and restored without scheduled work or image directories', async t => {
  const f = await fixture(t), empty = join(f.root, 'empty'), store = new Store(join(empty, 'data')); store.close();
  const backup = join(f.root, 'empty-backup'), target = join(f.root, 'empty-restored');
  assert.equal((await backupLibrary(empty, backup)).images, 0); assert.equal((await restoreLibrary(backup, target)).articles, 0);
});

test('legacy library-prefixed images retain readable paths and ambiguous unregistered roots are rejected', async t => {
  const f = await fixture(t), db = new Database(join(f.library, 'data/archive.sqlite'));
  for (const row of db.prepare('SELECT article_id,seq,data FROM assets').all() as { article_id: string; seq: number; data: string }[]) {
    const value = JSON.parse(row.data), path = join(f.library, 'data/library', value.file);
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, PNG);
    db.prepare('UPDATE assets SET data=? WHERE article_id=? AND seq=?').run(JSON.stringify({ ...value, file: `library/${value.file}`, storageDirectory: undefined }), row.article_id, row.seq);
  }
  db.prepare("DELETE FROM runtime WHERE key='image_directory'").run(); db.close();
  await backupLibrary(f.library, f.backup); await restoreLibrary(f.backup, f.target);
  const restored = new Store(join(f.target, 'data'));
  try { for (const asset of restored.storedAssets(f.article.id)) assert.deepEqual(await readFile(join(asset.storageDirectory!, asset.file!)), PNG); } finally { restored.close(); }
  const broken = new Database(join(f.library, 'data/archive.sqlite'));
  const row = broken.prepare('SELECT data FROM assets WHERE seq=1').get() as { data: string };
  broken.prepare('UPDATE assets SET data=? WHERE seq=1').run(JSON.stringify({ ...JSON.parse(row.data), file: 'unknown/image.png' })); broken.close();
  await assert.rejects(backupLibrary(f.library, join(f.root, 'ambiguous')));
});

test('restore keeps distinct same-named images from separate roots without overwriting either one', async t => {
  const f = await fixture(t), gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const db = new Database(join(f.library, 'data/archive.sqlite'));
  const original = JSON.parse((db.prepare('SELECT data FROM assets WHERE seq=1').get() as { data: string }).data);
  const second = JSON.parse((db.prepare('SELECT data FROM assets WHERE seq=2').get() as { data: string }).data);
  await writeFile(join(f.second, original.file), gif);
  db.prepare('UPDATE assets SET data=? WHERE seq=2').run(JSON.stringify({ ...second, file: original.file, mime: 'image/gif', bytes: gif.length, sha256: hash(gif) })); db.close();
  await backupLibrary(f.library, f.backup); await restoreLibrary(f.backup, f.target);
  const restored = new Store(join(f.target, 'data'));
  try {
    const [first, other] = restored.storedAssets(f.article.id); assert.notEqual(first.file, other.file);
    assert.deepEqual(await readFile(join(first.storageDirectory!, first.file!)), PNG); assert.deepEqual(await readFile(join(other.storageDirectory!, other.file!)), gif);
  } finally { restored.close(); }
});

test('restore also disambiguates when the fallback name is already a different registered image', async t => {
  const f = await fixture(t), first = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'), second = Buffer.from(first);
  second[13] = 123;
  const file = `恢复图片/${hash(Buffer.from(f.article.id)).slice(0, 12)}/2.gif`;
  const db = new Database(join(f.library, 'data/archive.sqlite'));
  for (const [seq, bytes, directory] of [[1, first, f.first], [2, second, f.second]] as const) {
    const row = JSON.parse((db.prepare('SELECT data FROM assets WHERE seq=?').get(seq) as { data: string }).data);
    await mkdir(join(directory, file, '..'), { recursive: true }); await writeFile(join(directory, file), bytes);
    db.prepare('UPDATE assets SET data=? WHERE seq=?').run(JSON.stringify({ ...row, file, storageDirectory: directory, mime: 'image/gif', bytes: bytes.length, sha256: hash(bytes) }), seq);
  }
  db.close(); const before = await tree(f.library), external = await tree(f.second);
  await backupLibrary(f.library, f.backup); await restoreLibrary(f.backup, f.target);
  const restored = new Store(join(f.target, 'data'));
  try {
    const assets = restored.storedAssets(f.article.id); assert.notEqual(assets[0].file, assets[1].file);
    for (const asset of assets) assert.equal(hash(await readFile(join(asset.storageDirectory!, asset.file!))), asset.sha256);
  } finally { restored.close(); }
  assert.deepEqual(await tree(f.library), before); assert.deepEqual(await tree(f.second), external);
});

test('incomplete backups, unassociated images and malformed body objects cannot restore successfully', async t => {
  const f = await fixture(t); await backupLibrary(f.library, f.backup);
  await writeFile(join(f.backup, '.shiye-incomplete'), 'unfinished');
  await assert.rejects(restoreLibrary(f.backup, f.target)); await rm(join(f.backup, '.shiye-incomplete'));
  const path = join(f.backup, 'shiye-backup.json'), original = await readFile(path, 'utf8'), manifest = JSON.parse(original);
  manifest.images[0].articleId = 'unknown-article'; await writeFile(path, JSON.stringify(manifest));
  await assert.rejects(restoreLibrary(f.backup, f.target)); await writeFile(path, original);
  const dbPath = join(f.backup, 'database.sqlite'), db = new Database(dbPath);
  const row = db.prepare('SELECT id,data FROM articles').get() as { id: string; data: string };
  db.prepare('UPDATE articles SET data=? WHERE id=?').run(JSON.stringify({ ...JSON.parse(row.data), blocks: [{ type: 'text', text: { bad: 'object' } }] }), row.id); db.close();
  const changed = await readFile(dbPath), edited = JSON.parse(original);
  Object.assign(edited.files.find((file: { path: string }) => file.path === 'database.sqlite'), { bytes: changed.length, sha256: hash(changed) }); await writeFile(path, JSON.stringify(edited));
  await assert.rejects(restoreLibrary(f.backup, f.target));
});

test('canceled offline work does not publish success and releases its source library lock', async t => {
  const f = await fixture(t), controller = new AbortController();
  const operation = backupLibrary(f.library, f.backup, controller.signal);
  setImmediate(() => controller.abort());
  await assert.rejects(operation);
  const release = await acquireLibraryLock(join(f.library, 'data')); await release();
  await assert.rejects(readFile(join(f.backup, 'shiye-backup.json')));
  controller.abort(); await assert.rejects(restoreLibrary(f.backup, f.target, controller.signal));
});
