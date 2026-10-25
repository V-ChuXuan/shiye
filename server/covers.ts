import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { sanitizeCoverUrl, SourceError, validateImage } from './source.js';

type Cover = { buffer: Buffer; mime: string };
type FetchCover = (source: string, referer: string, signal: AbortSignal) => Promise<Cover>;
const MAX_BYTES = 2 * 1024 * 1024;

export class CoverCache {
  private readonly pending = new Map<string, Promise<Cover>>();
  private readonly failures = new Map<string, { until: number; error: unknown }>();
  private readonly controller = new AbortController();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dataDir: string, private readonly fetchCover: FetchCover) {}

  get(id: string, source: string, referer: string): Promise<Cover> {
    const clean = sanitizeCoverUrl(source);
    if (!clean) return Promise.reject(new SourceError('invalid_content'));
    const key = createHash('sha256').update(id).update('\0').update(clean).digest('hex');
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.load(key, clean, referer).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }

  private async load(key: string, source: string, referer: string): Promise<Cover> {
    const directory = join(this.dataDir, 'covers');
    await mkdir(directory, { recursive: true });
    const root = await realpath(this.dataDir), actual = await realpath(directory);
    if (actual !== resolve(root, 'covers')) throw new SourceError('invalid_content');
    const file = join(actual, `${key}.image`);
    const cached = await this.read(file);
    if (cached) return cached;
    const failure = this.failures.get(key);
    if (failure && failure.until > Date.now()) throw failure.error;
    const work = this.queue.then(async () => {
      this.controller.signal.throwIfAborted();
      const temporary = `${file}.${randomUUID()}.part`;
      try {
        const image = await this.fetchCover(source, referer, this.controller.signal);
        this.controller.signal.throwIfAborted();
        if (image.buffer.length > MAX_BYTES) throw new SourceError('invalid_content');
        const format = validateImage(image.buffer, image.mime);
        await writeFile(temporary, image.buffer, { flag: 'wx' });
        const saved = await readFile(temporary);
        if (!saved.equals(image.buffer)) throw new SourceError('invalid_content');
        validateImage(saved, image.mime);
        this.controller.signal.throwIfAborted();
        await rename(temporary, file);
        this.failures.delete(key);
        return { buffer: image.buffer, mime: format.mime };
      } catch (error) {
        if (!this.controller.signal.aborted) this.failures.set(key, { until: Date.now() + 60_000, error });
        throw error;
      } finally { await rm(temporary, { force: true }); }
    });
    this.queue = work.then(() => {}, () => {});
    return work;
  }

  private async read(file: string): Promise<Cover | undefined> {
    let info;
    try { info = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || dirname(await realpath(file)) !== dirname(file)) throw new SourceError('invalid_content');
    if (info.size > MAX_BYTES) return;
    const buffer = await readFile(file);
    try { return { buffer, mime: validateImage(buffer).mime }; } catch { return; }
  }

  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled(this.pending.values());
  }
}
