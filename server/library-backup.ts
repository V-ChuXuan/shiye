import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path';
import { acquireLibraryLock } from './startup.js';
import { validateImage } from './source.js';

export class LibraryBackupError extends Error {}
type Result = { directory: string; images: number; articles: number };
export type LibraryProgress = { phase: 'checking' | 'database' | 'images' | 'covers' | 'publishing'; completed: number; total: number };
type Progress = (value: LibraryProgress) => void;
type FileEntry = { path: string; bytes: number; sha256: string };
type ImageEntry = { articleId: string; seq: number; path: string; file: string };
type Manifest = { format: 'shiye-library'; version: 1; files: FileEntry[]; images: ImageEntry[] };
type JsonRow = { id: string; data: string };
type AssetRow = { article_id: string; seq: number; data: string };
const manifestName = 'shiye-backup.json';
const manifestMaxBytes = 16 * 1024 * 1024;
const fail = (message = '文库或备份校验失败，原文件已保留'): never => { throw new LibraryBackupError(message); };
const comparable = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const inside = (path: string, root: string) => comparable(path) === comparable(root) || comparable(path).startsWith(`${comparable(root)}${sep}`);
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function directory(path: string): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f]/.test(path)) fail('请选择完整的文库或备份路径');
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('文库和备份路径不能包含目录链接');
  }
  if (comparable(await realpath(absolute)) !== comparable(absolute)) fail('文库和备份路径不能包含目录链接');
  return absolute;
}
function relativeFile(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || isAbsolute(value) || win32.isAbsolute(value) || /[:\x00-\x1f]/.test(value)) fail('备份文件路径无效');
  const parts = (value as string).replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) fail('备份文件路径无效');
  return parts.join('/');
}
function assetFile(value: unknown): string {
  let path = relativeFile(value);
  if (path.startsWith('library/')) path = path.slice(8);
  if (![2, 3].includes(path.split('/').length)) fail('登记图片路径无效');
  return path;
}
async function plainFile(path: string, max = Number.MAX_SAFE_INTEGER): Promise<number> {
  await directory(dirname(path));
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > max) fail('备份包含无效文件或文件链接');
  return info.size;
}
async function fingerprint(path: string): Promise<FileEntry> {
  const bytes = await plainFile(path), hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  await plainFile(path);
  return { path: '', bytes, sha256: hash.digest('hex') };
}
async function copy(source: string, target: string, expected?: { bytes: unknown; sha256: unknown }): Promise<FileEntry> {
  await plainFile(source); await directory(dirname(target));
  await copyFile(source, target, constants.COPYFILE_EXCL);
  const from = await fingerprint(source), to = await fingerprint(target);
  if (from.bytes !== to.bytes || from.sha256 !== to.sha256) fail('备份复制校验失败，未完成发布');
  if (expected && (to.bytes !== expected.bytes || to.sha256 !== expected.sha256)) fail('备份文件在操作期间改变，未完成发布');
  return to;
}
async function emptyTarget(path: string): Promise<{ target: string; stage: string; guard: string }> {
  if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) fail('请选择完整的文库或备份路径');
  const target = resolve(path); await directory(dirname(target));
  try { await mkdir(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await directory(target);
  if ((await readdir(target)).length) fail('目标必须是新的空文件夹，未覆盖已有内容');
  const stage = join(target, `.partial-${randomUUID().slice(0, 8)}`);
  const guard = join(target, '.shiye-incomplete'); await writeFile(guard, stage.slice(target.length + 1), { flag: 'wx' }); await mkdir(stage);
  return { target, stage, guard };
}
const schemas: Record<string, string> = {
  accounts: 'CREATE TABLE accounts (id TEXT PRIMARY KEY,biz TEXT UNIQUE NOT NULL,data TEXT NOT NULL)',
  articles: 'CREATE TABLE articles (id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),canonical TEXT UNIQUE,data TEXT NOT NULL)',
  aliases: 'CREATE TABLE aliases (url TEXT PRIMARY KEY,article_id TEXT NOT NULL REFERENCES articles(id))',
  assets: 'CREATE TABLE assets (article_id TEXT NOT NULL REFERENCES articles(id),seq INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(article_id,seq))',
  jobs: 'CREATE TABLE jobs (id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES accounts(id),data TEXT NOT NULL)',
  job_items: 'CREATE TABLE job_items (job_id TEXT NOT NULL REFERENCES jobs(id),ordinal INTEGER NOT NULL,article_id TEXT NOT NULL REFERENCES articles(id),status TEXT NOT NULL,error TEXT,PRIMARY KEY(job_id,ordinal))',
  runtime: 'CREATE TABLE runtime (key TEXT PRIMARY KEY,value TEXT NOT NULL)',
};
const normalizedSql = (sql: string) => sql.replace(/IF\s+NOT\s+EXISTS/gi, '').replace(/\s+/g, '').toLowerCase();
function object(data: string): Record<string, unknown> {
  const value: unknown = JSON.parse(data);
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  return value as Record<string, unknown>;
}
function validateDatabase(db: Database.Database): void {
  db.pragma('trusted_schema = OFF');
  const definitions = db.prepare('SELECT type,name,sql FROM sqlite_schema').all() as { type: string; name: string; sql: string | null }[];
  for (const item of definitions) {
    if (item.type === 'index' && item.sql === null && item.name.startsWith('sqlite_autoindex_')) continue;
    if (item.type === 'index' && item.name === 'articles_account' && normalizedSql(item.sql || '') === normalizedSql('CREATE INDEX articles_account ON articles(account_id)')) continue;
    if (item.type !== 'table' || !schemas[item.name] || normalizedSql(item.sql || '') !== normalizedSql(schemas[item.name])) fail('备份数据库结构不受支持');
  }
  if (definitions.filter(item => item.type === 'table').length !== Object.keys(schemas).length) fail('备份数据库结构不完整');
  if (db.pragma('integrity_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) fail('备份数据库完整性校验失败');
  for (const table of ['accounts', 'articles', 'jobs']) for (const row of db.prepare(`SELECT * FROM ${table}`).iterate() as Iterable<JsonRow & { biz?: string; account_id?: string }>) {
    const value = object(row.data);
    if (typeof row.id !== 'string' || !row.id || value.id !== row.id) fail('备份记录身份无效');
    if (table === 'accounts' && (value.biz !== row.biz || typeof value.biz !== 'string' || typeof value.name !== 'string' || !['disconnected', 'connected', 'expired', 'blocked'].includes(String(value.connection)) || !['manual', 'discover', 'download'].includes(String(value.updatePolicy)) || !value.coverage || typeof value.coverage !== 'object' || Array.isArray(value.coverage))) fail('备份公众号记录无效');
    const optionalText = table === 'accounts' ? ['lastCheckedAt', 'nextCheckAt'] : table === 'articles' ? ['error'] : [];
    if (optionalText.some(key => value[key] !== undefined && typeof value[key] !== 'string')) fail('备份文字字段无效');
    if (table === 'accounts') {
      const coverage = value.coverage as Record<string, unknown>;
      if (typeof coverage.complete !== 'boolean' || !Number.isFinite(coverage.count) || ['oldest', 'newest', 'stopReason'].some(key => coverage[key] !== undefined && typeof coverage[key] !== 'string')) fail('备份覆盖信息无效');
    }
    if (table !== 'accounts' && value.accountId !== row.account_id) fail('备份记录所属公众号无效');
    if (table === 'articles') {
      if (typeof value.title !== 'string' || typeof value.url !== 'string' || typeof value.publishedAt !== 'string' || !['discovered', 'downloading', 'partial', 'complete', 'unavailable'].includes(String(value.status)) || !Array.isArray(value.blocks) || !Number.isSafeInteger(value.imageCount) || Number(value.imageCount) < 0) fail('备份文章记录无效');
      for (const block of value.blocks as Record<string, unknown>[]) if (!block || typeof block !== 'object' || (block.type === 'text' ? typeof block.text !== 'string' : block.type !== 'image' || !Number.isSafeInteger(block.seq) || Number(block.seq) < 1)) fail('备份正文结构无效');
    }
    if (table === 'jobs' && (!['archive', 'discover'].includes(String(value.kind)) || !['queued', 'running', 'paused', 'waiting_session', 'blocked', 'partial', 'completed', 'failed'].includes(String(value.status)) || typeof value.accountName !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || typeof value.message !== 'string' || ['progress', 'total', 'completed', 'failed'].some(key => !Number.isFinite(value[key])))) fail('备份任务记录无效');
  }
  for (const row of db.prepare('SELECT article_id,seq,data FROM assets').iterate() as Iterable<AssetRow>) {
    const value = object(row.data);
    if (!Number.isSafeInteger(row.seq) || row.seq < 1 || value.seq !== row.seq || !['pending', 'failed', 'complete'].includes(String(value.status))) fail('备份图片记录无效');
    if (typeof value.src !== 'string') fail('备份图片来源无效');
    if (value.status === 'complete' && (typeof value.file !== 'string' || !Number.isSafeInteger(value.bytes) || Number(value.bytes) <= 0 || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256))) fail('备份图片资料不完整');
  }
  for (const row of db.prepare("SELECT id,data FROM articles WHERE json_extract(data,'$.status')='complete'").iterate() as Iterable<JsonRow>) {
    const value = object(row.data), complete = db.prepare("SELECT seq FROM assets WHERE article_id=? AND json_extract(data,'$.status')='complete'").all(row.id) as { seq: number }[];
    const sequences = new Set(complete.map(asset => asset.seq));
    if (complete.length !== value.imageCount || (value.blocks as Record<string, unknown>[]).some(block => block.type === 'image' && !sequences.has(Number(block.seq)))) fail('完整文章与已登记图片不一致');
  }
}
function assets(db: Database.Database): { row: AssetRow; value: Record<string, unknown> }[] {
  return (db.prepare('SELECT article_id,seq,data FROM assets ORDER BY article_id,seq').all() as AssetRow[]).map(row => ({ row, value: object(row.data) })).filter(({ value }) => value.status === 'complete');
}
async function image(path: string, asset: Record<string, unknown>): Promise<void> {
  await plainFile(path, 32 * 1024 * 1024);
  const bytes = await readFile(path); validateImage(bytes, typeof asset.mime === 'string' ? asset.mime : undefined);
  if (asset.bytes !== bytes.length || asset.sha256 !== digest(bytes)) fail('已登记图片缺失或损坏，请先补全后再备份');
}
async function finish(target: string, stage: string, guard: string, entries: string[], signal?: AbortSignal, onProgress?: Progress): Promise<void> {
  const existing = await readdir(target);
  if (existing.length !== 2 || !existing.includes('.shiye-incomplete') || !existing.includes(stage.slice(target.length + 1)) || await readFile(guard, 'utf8') !== stage.slice(target.length + 1)) fail('目标目录在操作期间发生变化，未覆盖内容');
  const total = onProgress ? (await readdir(stage, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile()).length : 0;
  let completed = 0; onProgress?.({ phase: 'publishing', completed, total });
  async function publish(source: string, destination: string): Promise<void> {
    signal?.throwIfAborted();
    const info = await lstat(source);
    if (info.isDirectory() && !info.isSymbolicLink()) {
      await directory(dirname(destination)); await mkdir(destination);
      for (const entry of await readdir(source)) await publish(join(source, entry), join(destination, entry));
      await rmdir(source);
    } else {
      await plainFile(source); await directory(dirname(destination));
      await copy(source, destination); await unlink(source);
      onProgress?.({ phase: 'publishing', completed: ++completed, total });
    }
  }
  for (const name of entries) await publish(join(stage, name), join(target, name));
  signal?.throwIfAborted(); await rmdir(stage);
  if (completed !== total) onProgress?.({ phase: 'publishing', completed, total: completed });
  signal?.throwIfAborted(); await unlink(guard);
}

export async function backupLibrary(sourceRoot: string, destination: string, signal?: AbortSignal, onProgress?: Progress): Promise<Result> {
  signal?.throwIfAborted();
  onProgress?.({ phase: 'database', completed: 0, total: 0 });
  const source = await directory(sourceRoot), data = await directory(join(source, 'data'));
  if ((await readdir(source)).includes('.shiye-incomplete')) fail('文库操作尚未完成，不能备份不完整目标');
  await plainFile(join(data, 'archive.sqlite'));
  if (inside(destination, source) || inside(source, destination)) fail('备份必须位于文库之外的独立文件夹');
  const release = await acquireLibraryLock(data);
  let db: Database.Database | undefined;
  try {
    db = new Database(join(data, 'archive.sqlite'), { readonly: true, fileMustExist: true }); validateDatabase(db);
    const entries = assets(db), configured = (db.prepare("SELECT value FROM runtime WHERE key='image_directory'").get() as { value: string } | undefined)?.value;
    if (!configured && entries.some(({ value }) => typeof value.storageDirectory !== 'string' && !String(value.file).replaceAll('\\', '/').startsWith('library/'))) fail('旧图片缺少登记根目录，请先在原程序确认保存位置后再备份');
    const fallback = configured || join(data, 'library');
    const paths = [];
    onProgress?.({ phase: 'checking', completed: 0, total: entries.length });
    for (const entry of entries) {
      signal?.throwIfAborted();
      const root = await directory(typeof entry.value.storageDirectory === 'string' ? entry.value.storageDirectory : fallback);
      if (inside(destination, root) || inside(root, destination)) fail('备份不能放在已登记图片目录中或其上级目录');
      const file = assetFile(entry.value.file), path = join(root, file); await image(path, entry.value);
      paths.push({ ...entry, file, path });
      onProgress?.({ phase: 'checking', completed: paths.length, total: entries.length });
    }
    const { target, stage, guard } = await emptyTarget(destination);
    await mkdir(join(stage, 'assets')); await mkdir(join(stage, 'covers'));
    onProgress?.({ phase: 'database', completed: 0, total: 0 });
    const database = join(stage, 'database.sqlite'); await db.backup(database, { progress: () => { signal?.throwIfAborted(); return 100; } });
    const manifest: Manifest = { format: 'shiye-library', version: 1, files: [{ ...(await fingerprint(database)), path: 'database.sqlite' }], images: [] };
    onProgress?.({ phase: 'images', completed: 0, total: paths.length });
    for (const [index, entry] of paths.entries()) {
      signal?.throwIfAborted();
      const format = validateImage(await readFile(entry.path));
      const path = `assets/${String(index + 1).padStart(6, '0')}.${format.ext}`;
      manifest.files.push({ ...(await copy(entry.path, join(stage, path), { bytes: entry.value.bytes, sha256: entry.value.sha256 })), path });
      manifest.images.push({ articleId: entry.row.article_id, seq: entry.row.seq, path, file: entry.file });
      onProgress?.({ phase: 'images', completed: index + 1, total: paths.length });
    }
    const covers = join(data, 'covers');
    try {
      await directory(covers);
      const entries = (await readdir(covers, { withFileTypes: true })).filter(entry => /^[a-f0-9]{64}\.image$/.test(entry.name));
      onProgress?.({ phase: 'covers', completed: 0, total: entries.length });
      for (const [index, entry] of entries.entries()) {
        signal?.throwIfAborted();
        const file = join(covers, entry.name); await plainFile(file, 2 * 1024 * 1024); validateImage(await readFile(file));
        const path = `covers/${entry.name}`; manifest.files.push({ ...(await copy(file, join(stage, path))), path });
        onProgress?.({ phase: 'covers', completed: index + 1, total: entries.length });
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const serialized = JSON.stringify(manifest, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > manifestMaxBytes) fail(`备份清单超过 ${manifestMaxBytes / (1024 * 1024)} MiB 上限，未完成发布，原文库已保留`);
    await writeFile(join(stage, manifestName), serialized, { flag: 'wx' });
    const articles = (db.prepare('SELECT COUNT(*) AS count FROM articles').get() as { count: number }).count;
    await finish(target, stage, guard, ['database.sqlite', 'assets', 'covers', manifestName], signal, onProgress);
    return { directory: target, images: entries.length, articles };
  } finally { db?.close(); await release(); }
}

async function readManifest(root: string, signal?: AbortSignal, onProgress?: Progress): Promise<Manifest> {
  await plainFile(join(root, manifestName), manifestMaxBytes);
  const candidate = JSON.parse(await readFile(join(root, manifestName), 'utf8')) as Manifest;
  if (candidate.format !== 'shiye-library' || candidate.version !== 1 || !Array.isArray(candidate.files) || !Array.isArray(candidate.images) || candidate.files.length > 1_000_000 || candidate.images.length > candidate.files.length) fail('不是受支持的完整拾页备份');
  const names = new Set<string>();
  const total = candidate.files.length + candidate.images.length;
  onProgress?.({ phase: 'checking', completed: 0, total });
  for (const [index, file] of candidate.files.entries()) {
    signal?.throwIfAborted();
    const name = relativeFile(file.path);
    if (file.path !== name || !/^(database\.sqlite|assets\/\d+\.(png|jpg|gif|webp|bmp|avif)|covers\/[a-f0-9]{64}\.image)$/.test(name) || names.has(name.toLowerCase()) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('备份文件清单无效');
    names.add(name.toLowerCase());
    const actual = await fingerprint(join(root, name));
    if (actual.bytes !== file.bytes || actual.sha256 !== file.sha256) fail('备份文件缺失或已损坏');
    onProgress?.({ phase: 'checking', completed: index + 1, total });
  }
  if (!names.has('database.sqlite')) fail('备份缺少数据库');
  const keys = new Set<string>(), paths = new Set<string>();
  for (const asset of candidate.images) {
    const key = JSON.stringify([asset.articleId, asset.seq]);
    if (typeof asset.articleId !== 'string' || !asset.articleId || !Number.isSafeInteger(asset.seq) || asset.seq < 1 || !names.has(asset.path) || !asset.path.startsWith('assets/') || keys.has(key) || paths.has(asset.path) || assetFile(asset.file) !== asset.file) fail('备份图片关联无效');
    keys.add(key); paths.add(asset.path);
  }
  if (candidate.files.filter(file => file.path.startsWith('assets/')).length !== candidate.images.length) fail('备份图片关联不完整');
  return candidate;
}

export async function restoreLibrary(backupDir: string, targetRoot: string, signal?: AbortSignal, onProgress?: Progress): Promise<Result> {
  signal?.throwIfAborted();
  onProgress?.({ phase: 'checking', completed: 0, total: 0 });
  const source = await directory(backupDir);
  if ((await readdir(source)).includes('.shiye-incomplete')) fail('备份操作尚未完成');
  if (inside(targetRoot, source) || inside(source, targetRoot)) fail('恢复目标必须是备份之外的新空文件夹');
  const manifest = await readManifest(source, signal, onProgress);
  const original = new Database(join(source, 'database.sqlite'), { readonly: true, fileMustExist: true });
  let db: Database.Database | undefined;
  try {
    onProgress?.({ phase: 'database', completed: 0, total: 0 });
    validateDatabase(original);
    const entries = assets(original);
    const savedImages = new Map(manifest.images.map(asset => [JSON.stringify([asset.articleId, asset.seq]), asset]));
    if (entries.length !== manifest.images.length || entries.some(({ row }) => !savedImages.has(JSON.stringify([row.article_id, row.seq])))) fail('备份数据库与图片清单不一致');
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted();
      await image(join(source, savedImages.get(JSON.stringify([entry.row.article_id, entry.row.seq]))!.path), entry.value);
      onProgress?.({ phase: 'checking', completed: manifest.files.length + index + 1, total: manifest.files.length + entries.length });
    }
    const { target, stage, guard } = await emptyTarget(targetRoot);
    await mkdir(join(stage, 'data')); await mkdir(join(stage, 'pictures')); await mkdir(join(stage, 'data/covers'));
    const database = join(stage, 'data/archive.sqlite'); await copy(join(source, 'database.sqlite'), database, manifest.files.find(file => file.path === 'database.sqlite'));
    db = new Database(database); db.pragma('trusted_schema = OFF'); validateDatabase(db);
    const used = new Map<string, string>();
    onProgress?.({ phase: 'images', completed: 0, total: entries.length });
    for (const [index, entry] of entries.entries()) {
      signal?.throwIfAborted();
      const saved = savedImages.get(JSON.stringify([entry.row.article_id, entry.row.seq]))!;
      let file = saved.file;
      const key = (name: string) => process.platform === 'win32' ? name.toLowerCase() : name;
      let collision = 0;
      while (used.has(key(file)) && used.get(key(file)) !== entry.value.sha256) {
        file = `恢复图片/${digest(Buffer.from(entry.row.article_id)).slice(0, 12)}/${entry.row.seq}${collision ? `-${collision}` : ''}.${validateImage(await readFile(join(source, saved.path))).ext}`;
        collision++;
      }
      const output = join(stage, 'pictures', file); await mkdir(dirname(output), { recursive: true });
      if (!used.has(key(file))) await copy(join(source, saved.path), output, { bytes: entry.value.bytes, sha256: entry.value.sha256 });
      await image(output, entry.value);
      used.set(key(file), String(entry.value.sha256));
      db.prepare('UPDATE assets SET data=? WHERE article_id=? AND seq=?').run(JSON.stringify({ ...entry.value, file, storageDirectory: join(target, 'pictures') }), entry.row.article_id, entry.row.seq);
      onProgress?.({ phase: 'images', completed: index + 1, total: entries.length });
    }
    const covers = manifest.files.filter(file => file.path.startsWith('covers/'));
    onProgress?.({ phase: 'covers', completed: 0, total: covers.length });
    for (const [index, file] of covers.entries()) {
      signal?.throwIfAborted();
      await copy(join(source, file.path), join(stage, 'data', file.path), file);
      onProgress?.({ phase: 'covers', completed: index + 1, total: covers.length });
    }
    onProgress?.({ phase: 'database', completed: 0, total: 0 });
    db.transaction(() => {
      for (const row of db!.prepare('SELECT id,data FROM accounts').all() as JsonRow[]) db!.prepare('UPDATE accounts SET data=? WHERE id=?').run(JSON.stringify({ ...object(row.data), connection: 'disconnected', updatePolicy: 'manual', nextCheckAt: undefined }), row.id);
      for (const row of db!.prepare('SELECT id,data FROM jobs').all() as JsonRow[]) {
        const value = object(row.data); db!.prepare('UPDATE jobs SET data=? WHERE id=?').run(JSON.stringify({ ...value, autoDownload: false, status: ['queued', 'running'].includes(String(value.status)) ? 'paused' : value.status }), row.id);
      }
      for (const row of db!.prepare('SELECT id,data FROM articles').all() as JsonRow[]) {
        const value = object(row.data); if (value.status === 'downloading') db!.prepare('UPDATE articles SET data=? WHERE id=?').run(JSON.stringify({ ...value, status: 'partial', error: '恢复后请确认并继续补全' }), row.id);
      }
      db!.prepare("UPDATE job_items SET status='pending' WHERE status='running'").run();
      db!.prepare("DELETE FROM runtime WHERE key='gate' OR key LIKE 'image_folder:%' OR key LIKE 'image_account:%'").run();
      for (const row of db!.prepare("SELECT article_id,seq,data FROM assets WHERE json_extract(data,'$.status')<>'complete'").all() as AssetRow[]) db!.prepare('UPDATE assets SET data=? WHERE article_id=? AND seq=?').run(JSON.stringify({ ...object(row.data), file: undefined, storageDirectory: undefined }), row.article_id, row.seq);
      for (const [id, entry] of new Map(manifest.images.map(entry => [entry.articleId, entry]))) db!.prepare('INSERT OR REPLACE INTO runtime(key,value) VALUES(?,?)').run(`image_folder:${id}`, dirname(entry.file));
      db!.prepare("INSERT OR REPLACE INTO runtime(key,value) VALUES('image_directory',?)").run(join(target, 'pictures'));
    })();
    const articles = (db.prepare('SELECT COUNT(*) AS count FROM articles').get() as { count: number }).count;
    db.close(); db = undefined;
    await finish(target, stage, guard, ['pictures', 'data'], signal, onProgress);
    return { directory: target, images: entries.length, articles };
  } finally { db?.close(); original.close(); }
}
