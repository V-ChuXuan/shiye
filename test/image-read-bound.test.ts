import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { ArchiveService } from '../server/service.js';
import type { StoredAsset } from '../server/store.js';
import type { Collector } from '../shared/types.js';

const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const limit = 32 * 1024 * 1024;
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
async function fixture(t: test.TestContext) {
  const parent = resolve('data'); await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(join(parent, 'image-read-bound-'));
  const forbidden = async () => { throw new Error('No source request'); };
  const source: Collector = { fetchArticle: forbidden, fetchImage: forbidden, discoverPage: forbidden, captureSession: forbidden, hasSession: () => false, getGate: () => null, clearGate() {} };
  const service = new ArchiveService(join(root, 'data'), source, false);
  const directory = service.settings().imageDirectory, file = join(directory, 'article/image.gif');
  await fs.mkdir(join(directory, 'article'), { recursive: true }); await fs.writeFile(file, GIF);
  const asset: StoredAsset = { seq: 1, src: '', status: 'complete', file: 'article/image.gif', storageDirectory: directory, mime: 'image/gif', bytes: GIF.length, sha256: hash(GIF) };
  let reads = 0; const original = fs.readFile;
  t.mock.method(fs, 'readFile', (async (path: Parameters<typeof fs.readFile>[0], ...args: unknown[]) => {
    if (String(path) === file) reads++;
    return Reflect.apply(original, fs, [path, ...args]);
  }) as typeof fs.readFile); syncBuiltinESMExports();
  t.after(async () => { t.mock.restoreAll(); syncBuiltinESMExports(); await service.close(); assert.ok(root.startsWith(`${parent}${sep}image-read-bound-`)); await fs.rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { service, file, directory, asset, reads: () => reads };
}

test('oversized files, size mismatches and invalid registrations are rejected before reading their bytes', async t => {
  const f = await fixture(t);
  await fs.truncate(f.file, limit + 1);
  assert.equal(await f.service.validAsset(f.asset), false); assert.equal(f.reads(), 0, 'An oversized local replacement must not be read into memory.');
  await fs.writeFile(f.file, GIF);
  for (const bytes of [GIF.length + 1, undefined, 0, NaN, Infinity, 1.5, -1, limit + 1]) {
    assert.equal(await f.service.validAsset({ ...f.asset, bytes }), false);
    assert.equal(f.reads(), 0, `Invalid registered length ${bytes} must not read the image.`);
  }
});

test('valid and exact-limit files retain structure/hash validation while missing and linked files fail safely', async t => {
  const f = await fixture(t); assert.equal(await f.service.validAsset(f.asset), true); assert.equal(f.reads(), 1);
  assert.equal(await f.service.validAsset({ ...f.asset, sha256: 'a'.repeat(64) }), false);
  const bmp = Buffer.alloc(limit); bmp.write('BM'); bmp.writeUInt32LE(limit, 2); bmp.writeUInt32LE(54, 10); bmp.writeUInt32LE(40, 14);
  bmp.writeInt32LE(1, 18); bmp.writeInt32LE(1, 22); bmp.writeUInt16LE(1, 26); bmp.writeUInt16LE(24, 28);
  await fs.writeFile(f.file, bmp);
  assert.equal(await f.service.validAsset({ ...f.asset, mime: 'image/bmp', bytes: limit, sha256: hash(bmp) }), true);
  await fs.unlink(f.file); const before = f.reads(); assert.equal(await f.service.validAsset(f.asset), false); assert.equal(f.reads(), before);
  const target = join(f.directory, 'article/target.gif'); await fs.writeFile(target, GIF);
  try { await fs.symlink(target, f.file); }
  catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) { t.diagnostic('Symlink fixture unavailable on this host.'); return; } throw error; }
  assert.equal(await f.service.validAsset(f.asset), false); assert.equal(f.reads(), before);
  assert.deepEqual(await fs.readFile(target), GIF);
});
