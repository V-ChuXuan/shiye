import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export class LibraryStartupError extends Error {
  constructor(readonly code: 'library_in_use' | 'library_lock_unknown' | 'library_lock_stale' | 'library_incomplete', message: string, readonly recoveryClaim?: string) {
    super(message); this.name = 'LibraryStartupError';
  }
}

async function requireComplete(dataDir: string) {
  const incomplete = await lstat(join(dirname(resolve(dataDir)), '.shiye-incomplete')).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  if (incomplete) throw new LibraryStartupError('library_incomplete', '文库恢复尚未完成，请重新从完整备份恢复到新的文库');
}

async function readLock(path: string): Promise<{ claim: string; pid: number }> {
  try {
    const before = await lstat(path);
    if (!before.isFile() || before.size < 1 || before.size > 1024) throw new Error('Invalid lock file');
    const file = await open(path, 'r');
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('Lock file changed');
      const bytes = Buffer.alloc(1025), { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead < 1 || bytesRead > 1024 || bytesRead !== opened.size) throw new Error('Invalid lock size');
      const claim = bytes.subarray(0, bytesRead).toString('utf8'), value: unknown = JSON.parse(claim);
      if (!Buffer.from(claim).equals(bytes.subarray(0, bytesRead)) || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid lock');
      const { pid, id } = value as { pid?: unknown; id?: unknown };
      if (!Number.isSafeInteger(pid) || Number(pid) <= 0 || typeof id !== 'string' || !id.trim() || id.length > 256) throw new Error('Invalid owner');
      return { claim, pid: Number(pid) };
    } finally { await file.close(); }
  } catch {
    throw new LibraryStartupError('library_lock_unknown', '文库锁无法识别或读取，请确认其他拾页程序已退出');
  }
}

function lockError(previous: { claim: string; pid: number }) {
  let alive = true;
  try { process.kill(previous.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
  if (alive) return new LibraryStartupError('library_in_use', '这份文库已由另一个拾页进程使用，请先退出原程序');
  return new LibraryStartupError('library_lock_stale', '上次程序异常退出，请选择恢复并打开文库。', process.platform === 'win32' ? previous.claim : undefined);
}

async function guardLibrary(dataDir: string): Promise<() => Promise<void>> {
  if (process.platform !== 'win32') return async () => {};
  const guard = createServer(socket => socket.destroy());
  const name = createHash('sha256').update(dataDir.toLowerCase()).digest('hex');
  await new Promise<void>((done, reject) => {
    guard.once('error', error => reject(new LibraryStartupError((error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? 'library_in_use' : 'library_lock_unknown',
      (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? '这份文库已由另一个拾页进程使用，请先退出原程序' : '无法取得文库使用权，请检查目录权限后重试')));
    guard.listen(`\\\\?\\pipe\\shiye-library-${name}`, () => done());
  });
  return () => new Promise<void>((done, reject) => guard.close(error => error ? reject(error) : done()));
}

export async function acquireLibraryLock(dataDir: string, options: { recoverClaim?: string } = {}): Promise<() => Promise<void>> {
  await requireComplete(dataDir);
  await mkdir(dataDir, { recursive: true });
  dataDir = await realpath(dataDir);
  const closeGuard = await guardLibrary(dataDir), path = join(dataDir, '.shiye-service.lock');
  const claim = JSON.stringify({ pid: process.pid, id: randomUUID() });
  async function publish() {
    if (process.platform !== 'win32') {
      const file = await open(path, 'wx');
      try { await file.writeFile(claim); } finally { await file.close(); }
      return;
    }
    const temporary = `${path}.tmp-${randomUUID()}`, file = await open(temporary, 'wx');
    try {
      try { await file.writeFile(claim); await file.sync(); } finally { await file.close(); }
      // Publishing a complete claim without replacement also protects older versions without the pipe guard.
      try { await link(temporary, path); }
      catch (error) {
        if (['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV'].includes((error as NodeJS.ErrnoException).code || '')) {
          throw new LibraryStartupError('library_lock_unknown', '无法安全创建文库锁，请检查写入权限，或选择支持硬链接的本地磁盘。');
        }
        throw error;
      }
    } finally { await unlink(temporary).catch(() => {}); }
  }
  try {
    await requireComplete(dataDir);
    if (options.recoverClaim !== undefined) {
      if (process.platform !== 'win32' || typeof options.recoverClaim !== 'string' || Buffer.byteLength(options.recoverClaim) > 1024) {
        throw new LibraryStartupError('library_lock_unknown', '无法确认这次文库恢复，请重新打开文库后重试');
      }
      const previous = await readLock(path), error = lockError(previous);
      if (error.code !== 'library_lock_stale' || previous.claim !== options.recoverClaim) throw error;
      await requireComplete(dataDir);
      const current = await readLock(path), currentError = lockError(current);
      if (current.claim !== previous.claim || currentError.code !== 'library_lock_stale') throw currentError;
      await rename(path, `${path}.stale-${randomUUID()}`);
    }
    try { await publish(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw lockError(await readLock(path));
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try { if ((await readLock(path).catch(() => undefined))?.claim === claim) await unlink(path); }
      finally { await closeGuard(); }
    };
  } catch (error) {
    await closeGuard();
    throw error;
  }
}

// Probe before opening SQLite: a duplicate start must not recover the live process's jobs.
export async function isPortAvailable(port: number): Promise<boolean> {
  const probe = createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', error => {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') resolve(false);
      else reject(error);
    });
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve(true)));
  });
}
