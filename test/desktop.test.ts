import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { acquireLibraryLock, LibraryStartupError } from '../server/startup.js';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const { argument, externalLink, libraryPaths, mainPage } = require('../desktop/config.cjs');
test('desktop paths accept only explicit libraries', () => {
  assert.equal(argument(['--library-root=E:\\中文 空格'], 'library-root'), 'E:\\中文 空格');
  assert.throws(() => libraryPaths('relative'));
  assert.equal(libraryPaths(resolve('data/desktop-verification/library')).data, resolve('data/desktop-verification/library/data'));
});
test('desktop external links allow public articles and the five exact credit repositories', () => {
  for (const url of ['https://mp.weixin.qq.com/s/../s', 'https://mp.weixin.qq.com/s/x/../']) assert.equal(externalLink(url), false, url);
  for (const url of ['https://mp.weixin.qq.com/s/article', 'https://mp.weixin.qq.com/s?__biz=fixture&mid=1&sn=public',
    'https://github.com/shadcn-ui/ui', 'https://github.com/lucide-icons/lucide', 'https://github.com/pmndrs/zustand',
    'https://github.com/motiondivision/motion', 'https://github.com/bvaughn/react-resizable-panels']) assert.equal(externalLink(url), true, url);
  for (const url of ['file:///C:/private', 'data:text/html,private', 'javascript:alert(1)', 'https://example.com/',
    'https://mp.weixin.qq.com.evil/s/x', 'https://user:pass@mp.weixin.qq.com/s/x', 'https://mp.weixin.qq.com:443/s/x',
    'https://mp.weixin.qq.com:8443/s/x', 'https://mp.weixin.qq.com/mp/profile_ext', 'https://mp.weixin.qq.com/suffix',
    'http://mp.weixin.qq.com/s/x', 'https://mp.weixin.qq.com/a/../s/x', 'https://mp.weixin.qq.com/s/%2e%2e/s/x',
    'https://mp.weixin.qq.com/s/%2fsecret', 'https://mp.weixin.qq.com\\@example.com/s/x', ' https://mp.weixin.qq.com/s/x',
    'https://github.com/shadcn-ui/ui/issues', 'https://github.com/shadcn-ui/ui.evil', 'https://github.com/shadcn-ui/ui/',
    'https://github.com/shadcn-ui/ui?next=evil', 'https://github.com/shadcn-ui/ui#evil', 'https://github.com/other/repo',
    'https://user@github.com/shadcn-ui/ui', 'https://github.com:443/shadcn-ui/ui', 'https://github.com.evil/shadcn-ui/ui',
    'https://github.com/shadcn-ui/%75i', 'https://github.com/other/../shadcn-ui/ui', '', 'not a URL']) assert.equal(externalLink(url), false, url);
});
test('desktop top-level navigation stays on its exact local root UI', () => {
  const origin = 'http://127.0.0.1:1234';
  for (const path of ['/', '/#accounts', '/#reader?article=fixture']) assert.equal(mainPage(`${origin}${path}`, origin), true);
  for (const url of [`${origin}/api/assets/a/1`, `${origin}/api/covers/a`, `${origin}/api/settings`, `${origin}/other`,
    `${origin}/?next=/api/settings`, `${origin}/api/../`, `http://user@127.0.0.1:1234/`, 'http://127.0.0.1:1235/',
    'https://mp.weixin.qq.com/s/x', 'file:///C:/private', 'data:text/plain,private', 'invalid']) assert.equal(mainPage(url, origin), false, url);
});
test('web and desktop library locks exclude a second process and preserve replaced or unknown locks', async t => {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'desktop-lock-'));
  t.after(async () => { assert.ok(root.startsWith(`${parent}${sep}desktop-lock-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const release = await acquireLibraryLock(root);
  await assert.rejects(acquireLibraryLock(root), error => error instanceof LibraryStartupError && error.code === 'library_in_use');
  await release();
  const again = await acquireLibraryLock(root);
  const file = join(root, '.shiye-service.lock');
  await writeFile(file, 'unrecognized'); await again();
  assert.equal(await readFile(file, 'utf8'), 'unrecognized');
  await assert.rejects(acquireLibraryLock(root), error => error instanceof LibraryStartupError && error.code === 'library_lock_unknown');
  const dead = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await new Promise<void>((done, reject) => { dead.once('error', reject); dead.once('exit', () => done()); });
  const stale = JSON.stringify({ pid: dead.pid, id: 'stale' });
  await writeFile(file, stale);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLibraryLock(root)));
  assert.ok(results.every(result => result.status === 'rejected' && result.reason instanceof LibraryStartupError && ['library_lock_stale', 'library_in_use'].includes(result.reason.code)));
  assert.ok(results.some(result => result.status === 'rejected' && result.reason.code === 'library_lock_stale'));
  assert.equal(await readFile(file, 'utf8'), stale, 'Concurrent recovery must never delete another process\'s lock.');
});

test('an incomplete restored library cannot acquire a service lock or change its database', async t => {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'desktop-incomplete-')), data = join(root, 'data');
  t.after(async () => { assert.ok(root.startsWith(`${parent}${sep}desktop-incomplete-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  await mkdir(data);
  const database = Buffer.from('incomplete database must not be opened');
  await writeFile(join(data, 'archive.sqlite'), database);
  const marker = join(root, '.shiye-incomplete'); await writeFile(marker, 'restoring');
  await assert.rejects(acquireLibraryLock(data), error => error instanceof LibraryStartupError && error.code === 'library_incomplete');
  assert.deepEqual(await readFile(join(data, 'archive.sqlite')), database);
  assert.equal(await readFile(marker, 'utf8'), 'restoring');
  await assert.rejects(readFile(join(data, '.shiye-service.lock')), { code: 'ENOENT' });
  await rm(marker); await mkdir(marker);
  await assert.rejects(acquireLibraryLock(data), /文库恢复尚未完成/);
  assert.deepEqual(await readFile(join(data, 'archive.sqlite')), database);
  await assert.rejects(readFile(join(data, '.shiye-service.lock')), { code: 'ENOENT' });
});
