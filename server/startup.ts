import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export class LibraryStartupError extends Error {
  constructor(readonly code: 'library_in_use' | 'library_lock_unknown' | 'library_lock_stale' | 'library_incomplete', message: string) {
    super(message); this.name = 'LibraryStartupError';
  }
}

export async function acquireLibraryLock(dataDir: string): Promise<() => Promise<void>> {
  const incomplete = await lstat(join(dirname(resolve(dataDir)), '.shiye-incomplete')).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  if (incomplete) throw new LibraryStartupError('library_incomplete', '文库恢复尚未完成，请重新从完整备份恢复到新的文库');
  await mkdir(dataDir, { recursive: true });
  const path = join(dataDir, '.shiye-service.lock');
  const claim = JSON.stringify({ pid: process.pid, id: randomUUID() });
  try {
    const file = await open(path, 'wx');
    try { await file.writeFile(claim); } finally { await file.close(); }
    return async () => { if (await readFile(path, 'utf8').catch(() => '') === claim) await unlink(path).catch(() => {}); };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const previous = await readFile(path, 'utf8').catch(() => { throw new LibraryStartupError('library_lock_unknown', '文库锁无法识别，请确认其他拾页程序已退出'); });
    let pid: unknown;
    try { pid = (JSON.parse(previous) as { pid?: unknown }).pid; } catch { /* An unknown lock must not be removed. */ }
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) throw new LibraryStartupError('library_lock_unknown', '文库锁无法识别，请确认其他拾页程序已退出');
    let alive = true;
    try { process.kill(Number(pid), 0); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
    if (alive) throw new LibraryStartupError('library_in_use', '这份文库已由另一个拾页进程使用，请先退出原程序');
    // A stale lock cannot be unlinked safely while another process may also recover it.
    throw new LibraryStartupError('library_lock_stale', `上次程序异常退出。请确认所有拾页程序已退出，再删除文库中的 .shiye-service.lock 后重试：${dataDir}`);
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
