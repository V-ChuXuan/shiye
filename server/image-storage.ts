import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from 'node:path';
import type { Store, StoredAsset } from './store.js';
import { validateImage } from './source.js';

export class StorageError extends Error {
  constructor(message: string, readonly code = 'storage_error', readonly statusCode = 422) { super(message); }
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const compare = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
const inside = (path: string, root: string) => compare(path) === compare(root) || compare(path).startsWith(`${compare(root)}${sep}`);

function imageFile(file: string): string {
  if (!file || isAbsolute(file) || win32.isAbsolute(file) || /[:\0]/.test(file)) throw new StorageError('图片文件路径无效', 'unsafe_path', 403);
  const parts = file.replaceAll('\\', '/').split('/');
  if (parts[0] === 'library') parts.shift();
  if (![2, 3].includes(parts.length) || parts.some(part => !part || part === '.' || part === '..')) throw new StorageError('图片文件路径无效', 'unsafe_path', 403);
  return join(...parts);
}

function folderName(value: string, limit: number): string {
  let name = value.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0, limit).replace(/[. ]+$/, '').replace(/[\uD800-\uDBFF]$/, '');
  if (!name || name === '.' || name === '..') name = '未命名';
  if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name) || name.toLowerCase() === 'library') name = `_${name}`;
  return name.slice(0, limit).replace(/[. ]+$/, '');
}

async function directory(path: string, create: boolean): Promise<string> {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current); info = await lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new StorageError('保存位置包含文件或目录链接，请选择普通文件夹', 'unsafe_path');
  }
  const actual = await realpath(absolute);
  if (compare(actual) !== compare(absolute)) throw new StorageError('保存位置包含目录链接', 'unsafe_path');
  return actual;
}

async function readImage(path: string, expected?: StoredAsset): Promise<Buffer> {
  await directory(dirname(path), false);
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new StorageError('图片文件不是有效的普通文件', 'unsafe_path');
  if (expected && (!Number.isSafeInteger(expected.bytes) || Number(expected.bytes) <= 0 || expected.bytes !== info.size)) throw new StorageError('已有图片长度不符，请补全后再使用', 'invalid_content');
  const bytes = await readFile(path); validateImage(bytes, expected?.mime);
  if (expected && (!expected.sha256 || expected.bytes !== bytes.length || expected.sha256 !== hash(bytes))) throw new StorageError('已有图片校验失败，请补全后再更改保存位置', 'invalid_content');
  return bytes;
}

async function putImage(path: string, bytes: Buffer, repair = false): Promise<void> {
  try {
    const old = await readImage(path);
    if (old.equals(bytes)) return;
    if (!repair) throw new StorageError('目标目录存在同名的不同文件，未覆盖原文件', 'file_conflict', 409);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof StorageError && error.code === 'unsafe_path') throw error;
      if (!repair) throw new StorageError('目标目录存在不可覆盖的同名文件', 'file_conflict', 409);
    }
  }
  const temporary = `${path}.${randomUUID()}.part`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    if (!(await readFile(temporary)).equals(bytes)) throw new StorageError('图片写入校验失败');
    try { if (repair) await rename(temporary, path); else await link(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new StorageError('目标文件系统无法安全写入图片，请选择支持普通文件写入的文件夹');
      let same = false;
      try { same = (await readImage(path)).equals(bytes); } catch { /* A conflicting target is never replaced. */ }
      if (!same) throw new StorageError('目标目录文件冲突，未覆盖原文件', 'file_conflict', 409);
    }
  } finally {
    try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export class ImageStorage {
  readonly defaultDirectory: string;
  private currentDirectory: string;
  constructor(private readonly store: Store, readonly dataDirectory: string, defaultDirectory = join(dataDirectory, 'pictures')) {
    this.defaultDirectory = resolve(defaultDirectory);
    const configured = store.imageDirectory;
    if (configured) { this.currentDirectory = configured; return; }
    const legacy = store.db.prepare(`SELECT
      EXISTS(SELECT 1 FROM assets WHERE substr(replace(json_extract(data,'$.file'),char(92),'/'),1,8)='library/') AS library,
      EXISTS(SELECT 1 FROM assets) AS present`).get() as { library: number; present: number };
    this.currentDirectory = legacy.library ? join(dataDirectory, 'library') : this.defaultDirectory;
    if (!legacy.present) store.saveImageDirectory(this.currentDirectory);
  }
  get imageDirectory() { return this.currentDirectory; }

  private folders(): Map<string, string> {
    return new Map((this.store.db.prepare("SELECT key,value FROM runtime WHERE key LIKE 'image_folder:%' OR key LIKE 'image_account:%'").all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
  }
  private folder(articleId: string, folders: Map<string, string>, root: string): string {
    const assigned = folders.get(`image_folder:${articleId}`);
    if (assigned) { imageFile(join(assigned, 'check.png')); return assigned; }
    const article = this.store.db.prepare("SELECT account_id,json_extract(data,'$.title') AS title FROM articles WHERE id=?").get(articleId) as { account_id: string; title: string } | undefined;
    if (!article) throw new StorageError('文章不存在', 'not_found', 404);
    const account = this.store.account(article.account_id);
    if (!account) throw new StorageError('公众号不存在', 'not_found', 404);
    // Leave room for the image name and the atomic-write temporary suffix.
    const available = 240 - resolve(root).length - 50;
    if (available < 36) throw new StorageError('保存位置路径过长，请选择较短的图片根目录', 'unsafe_path', 400);
    const unique = (name: string, key: string, prefix: string, limit: number) => {
      const occupied = (candidate: string) => [...folders].some(([other, value]) => other !== key && other.startsWith(prefix) && value.toLowerCase() === candidate.toLowerCase());
      if (!occupied(name)) return name;
      const suffix = createHash('sha256').update(key).digest('hex').slice(0, 8);
      const parent = prefix === 'image_folder:' ? dirname(name) : '';
      const stem = basename(name).slice(0, Math.max(1, limit - 9)).replace(/[. ]+$/, '').replace(/[\uD800-\uDBFF]$/, '');
      const candidate = join(parent, `${stem}~${suffix}`);
      if (occupied(candidate)) throw new StorageError('目录名称冲突，请更改文章标题后重试', 'file_conflict', 409);
      return candidate;
    };
    const accountKey = `image_account:${account.id}`, accountLimit = Math.min(40, Math.floor(available / 3));
    const accountFolder = folders.get(accountKey) || unique(folderName(account.name, accountLimit), accountKey, 'image_account:', accountLimit);
    folders.set(accountKey, accountFolder);
    const titleLimit = Math.min(90, available - accountFolder.length);
    if (titleLimit < 18) throw new StorageError('保存位置路径过长，请选择较短的图片根目录', 'unsafe_path', 400);
    const key = `image_folder:${articleId}`, desired = join(accountFolder, folderName(article.title, titleLimit));
    const path = unique(desired, key, 'image_folder:', titleLimit);
    folders.set(key, path);
    return path;
  }
  private saveFolders(folders: Map<string, string>) {
    const statement = this.store.db.prepare('INSERT OR REPLACE INTO runtime(key,value) VALUES(?,?)');
    for (const [key, value] of folders) statement.run(key, value);
  }
  imageFile(articleId: string, name: string): string {
    const assigned = this.store.db.prepare('SELECT value FROM runtime WHERE key=?').get(`image_folder:${articleId}`) as { value: string } | undefined;
    const folders = assigned ? undefined : this.folders();
    const file = join(assigned?.value || this.folder(articleId, folders!, this.currentDirectory), name);
    imageFile(file);
    if (resolve(this.currentDirectory, file).length > 240) throw new StorageError('保存位置路径过长，请选择较短的图片根目录', 'unsafe_path', 400);
    if (folders) this.store.db.transaction(() => this.saveFolders(folders))();
    return file;
  }

  async filePath(file: string, storageDirectory = this.currentDirectory): Promise<string> {
    const name = imageFile(file), root = await directory(storageDirectory, false), path = resolve(root, name);
    if (!inside(path, root) || path === root) throw new StorageError('图片文件路径越界', 'unsafe_path', 403);
    await directory(dirname(path), false);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !inside(await realpath(path), root)) throw new StorageError('图片文件路径越界', 'unsafe_path', 403);
    return path;
  }
  async validAsset(asset: StoredAsset): Promise<boolean> {
    if (asset.status !== 'complete' || !asset.file || !asset.sha256 || !Number.isSafeInteger(asset.bytes) || Number(asset.bytes) <= 0 || Number(asset.bytes) > 32 * 1024 * 1024) return false;
    try { await readImage(await this.filePath(asset.file, asset.storageDirectory), asset); return true; } catch { return false; }
  }
  async write(file: string, bytes: Buffer, repair = false): Promise<void> {
    const name = imageFile(file), root = await directory(this.currentDirectory, true), path = resolve(root, name);
    if (path.length > 240) throw new StorageError('图片文件路径过长，请选择较短的保存位置', 'unsafe_path', 400);
    await directory(dirname(path), true);
    if (!inside(path, root)) throw new StorageError('图片文件路径越界', 'unsafe_path', 403);
    await putImage(path, bytes, repair);
  }

  async setDirectory(input: unknown, migrateExisting = false): Promise<{ migratedImages: number; warnings: string[] }> {
    if (typeof input !== 'string' || !input.trim() || input.length > 4096 || !isAbsolute(input) || /[\0-\x1f]/.test(input) || (process.platform === 'win32' && !/^[a-z]:[\\/]/i.test(input))) throw new StorageError('请填写有效的完整文件夹路径', 'invalid_path', 400);
    const target = resolve(input.trim()), previous = resolve(this.currentDirectory);
    const unchanged = compare(target) === compare(previous);
    if (unchanged && !migrateExisting) return { migratedImages: 0, warnings: [] };
    if (target === parse(target).root || !unchanged && (inside(target, previous) || inside(previous, target)) || inside(this.dataDirectory, target) || inside(target, join(this.dataDirectory, 'covers')) || ['server', 'client', 'shared', 'scripts', 'test', 'node_modules', 'dist'].some(part => inside(target, resolve(part)))) throw new StorageError('请使用独立的图片文件夹，不能选择程序、数据库或嵌套目录', 'unsafe_path', 400);
    const root = await directory(target, true);
    const probe = join(root, `.shiye-write-${randomUUID()}.tmp`);
    try { await writeFile(probe, 'shiye', { flag: 'wx' }); }
    finally { try { await unlink(probe); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
    const entries = (this.store.db.prepare('SELECT article_id,data FROM assets ORDER BY article_id,seq').all() as { article_id: string; data: string }[])
      .map(row => ({ articleId: row.article_id, asset: JSON.parse(row.data) as StoredAsset })).filter(({ asset }) => asset.file);
    const folders = this.folders();
    const moves = migrateExisting ? entries.filter(({ asset }) => asset.status === 'complete').map(entry => {
      const file = join(this.folder(entry.articleId, folders, root), basename(imageFile(entry.asset.file!)));
      if (resolve(root, file).length > 240) throw new StorageError('图片文件路径过长，请选择较短的保存位置', 'unsafe_path', 400);
      return { ...entry, file };
    }) : [];
    const commit = () => this.store.db.transaction(() => {
      for (const { articleId, asset } of entries) this.store.saveAsset(articleId, {
        ...asset, storageDirectory: migrateExisting && asset.status === 'complete' ? root : asset.storageDirectory || previous,
        file: moves.find(move => move.articleId === articleId && move.asset.seq === asset.seq)?.file || asset.file,
      });
      if (migrateExisting) this.saveFolders(folders);
      this.store.saveImageDirectory(root);
    })();
    if (!migrateExisting) {
      commit(); this.currentDirectory = root;
      return { migratedImages: 0, warnings: [] };
    }
    const originals: { path: string; target: string; asset: StoredAsset }[] = [];
    for (const { asset, file } of moves) {
      const from = await this.filePath(asset.file!, asset.storageDirectory || previous), bytes = await readImage(from, asset), to = resolve(root, imageFile(file));
      await directory(dirname(to), true);
      await putImage(to, bytes); await readImage(to, asset);
      if (compare(from) !== compare(to)) originals.push({ path: from, target: to, asset });
    }
    for (const original of originals) { await readImage(original.path, original.asset); await readImage(original.target, original.asset); }
    commit();
    this.currentDirectory = root;
    const warnings: string[] = [];
    const targets = new Set(moves.map(move => compare(resolve(root, move.file))));
    for (const original of originals) {
      if (targets.has(compare(original.path))) continue;
      try {
        await readImage(original.target, original.asset); await readImage(original.path, original.asset); await unlink(original.path);
        const parent = dirname(original.path);
        const sourceRoot = original.asset.storageDirectory || previous;
        if (inside(parent, sourceRoot) && compare(parent) !== compare(sourceRoot)) {
          await directory(parent, false);
          try { await rmdir(parent); } catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code || '')) throw error; }
        }
      }
      catch { warnings.push('新位置已可读取图片，部分旧文件未清理并仍保留。'); }
    }
    return { migratedImages: originals.length, warnings: [...new Set(warnings)] };
  }
}
