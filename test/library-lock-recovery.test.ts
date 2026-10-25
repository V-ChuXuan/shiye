import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { acquireLibraryLock, LibraryStartupError } from '../server/startup.js';

const windows = process.platform === 'win32';
type Message = { type: string; code?: string; recoveryClaim?: string; path?: string };
async function fixture(t: TestContext) {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'lock-recovery-')), data = join(root, '文库/data');
  await mkdir(data, { recursive: true });
  const database = join(data, 'archive.sqlite'); await writeFile(database, 'unchanged database fixture');
  t.after(async () => { assert.ok(root.startsWith(`${parent}${sep}lock-recovery-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, data, lock: join(data, '.shiye-service.lock'), database };
}
async function deadClaim() {
  const worker = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await new Promise<void>((done, reject) => { worker.once('error', reject); worker.once('exit', () => done()); });
  return JSON.stringify({ pid: worker.pid, id: 'known-crashed-owner' });
}
async function worker(t: TestContext) {
  const child = fork(fileURLToPath(new URL('fixtures/library-lock.mjs', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = ''; child.stderr!.on('data', bytes => { stderr += bytes.toString(); });
  const messages: Message[] = [], waiting = new Set<() => void>();
  child.on('message', message => { messages.push(message as Message); for (const wake of waiting) wake(); });
  const exited = new Promise<void>((done, reject) => { child.once('exit', () => done()); child.once('error', reject); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  });
  async function next(...types: string[]) {
    const found = () => messages.find(message => types.includes(message.type));
    if (!found()) await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => { waiting.delete(wake); reject(new Error(`Lock fixture did not return ${types}: ${stderr}`)); }, 15000);
      const wake = () => { if (found()) { clearTimeout(timer); waiting.delete(wake); done(); } };
      waiting.add(wake); wake();
    });
    return found()!;
  }
  await next('prepared');
  return { child, exited, next, start: (data: string, recoverClaim?: string, pause?: string) => child.send({ type: 'start', data, recoverClaim, pause }) };
}

test('explicit Windows recovery preserves the exact stale claim and rejects a reused ticket', { skip: !windows }, async t => {
  const f = await fixture(t), original = await deadClaim(); await writeFile(f.lock, original);
  await assert.rejects(acquireLibraryLock(f.data), error => error instanceof LibraryStartupError && error.code === 'library_lock_stale' && error.recoveryClaim === original);
  const release = await acquireLibraryLock(f.data, { recoverClaim: original });
  assert.notEqual(await readFile(f.lock, 'utf8'), original);
  await assert.rejects(acquireLibraryLock(f.data, { recoverClaim: original }), { code: 'library_in_use' });
  await release();
  const archives = (await readdir(f.data)).filter(file => file.startsWith('.shiye-service.lock.stale-'));
  assert.equal(archives.length, 1); assert.equal(await readFile(join(f.data, archives[0]), 'utf8'), original);
  assert.equal(await readFile(f.database, 'utf8'), 'unchanged database fixture');
  assert.equal((await readdir(f.data)).some(file => file.includes('.tmp-')), false);
  await assert.rejects(acquireLibraryLock(f.data, { recoverClaim: original }), { code: 'library_lock_unknown' });
  await assert.rejects(readFile(f.lock), { code: 'ENOENT' });
});

test('unknown, active, changed and incomplete locks never authorize Windows recovery', { skip: !windows }, async t => {
  const f = await fixture(t), original = await deadClaim();
  for (const value of ['', '{', 'null', '[]', '{}', '{"pid":1}', '{"pid":1,"id":""}', 'x'.repeat(1025)]) {
    await writeFile(f.lock, value);
    await assert.rejects(acquireLibraryLock(f.data, { recoverClaim: value }), error => error instanceof LibraryStartupError && error.code === 'library_lock_unknown' && error.recoveryClaim === undefined);
    assert.equal(await readFile(f.lock, 'utf8'), value);
  }
  const active = JSON.stringify({ pid: process.pid, id: 'active-owner' }); await writeFile(f.lock, active);
  await assert.rejects(acquireLibraryLock(f.data, { recoverClaim: active }), { code: 'library_in_use' });
  assert.equal(await readFile(f.lock, 'utf8'), active);
  const changed = original.replace('known-crashed-owner', 'different-crashed-owner'); await writeFile(f.lock, changed);
  await assert.rejects(acquireLibraryLock(f.data, { recoverClaim: original }), error => error instanceof LibraryStartupError && error.code === 'library_lock_stale' && error.recoveryClaim === changed);
  assert.equal(await readFile(f.lock, 'utf8'), changed);
  await writeFile(join(f.data, '../.shiye-incomplete'), 'keep incomplete');
  await assert.rejects(acquireLibraryLock(f.data, { recoverClaim: changed }), { code: 'library_incomplete' });
  assert.equal(await readFile(f.lock, 'utf8'), changed);
  assert.equal(await readFile(f.database, 'utf8'), 'unchanged database fixture');
  assert.deepEqual((await readdir(f.data)).sort(), ['.shiye-service.lock', 'archive.sqlite']);
});

test('Windows recovery protects non-file locks and uncertain process permissions', { skip: !windows }, async t => {
  const f = await fixture(t); await mkdir(f.lock);
  await assert.rejects(acquireLibraryLock(f.data), { code: 'library_lock_unknown' });
  await rm(f.lock, { recursive: true });
  const claim = await deadClaim(); await writeFile(f.lock, claim);
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('permission fixture'), { code: 'EPERM' }); });
  await assert.rejects(acquireLibraryLock(f.data, { recoverClaim: claim }), error => error instanceof LibraryStartupError && error.code === 'library_in_use' && error.recoveryClaim === undefined);
  t.mock.restoreAll(); assert.equal(await readFile(f.lock, 'utf8'), claim);
});

test('unsupported Windows hard links fail visibly without leaving a claim or guard', { skip: !windows }, async t => {
  const f = await fixture(t);
  t.mock.method(fs.promises, 'link', async () => { throw Object.assign(new Error('filesystem fixture'), { code: 'ENOTSUP' }); });
  syncBuiltinESMExports();
  try { await assert.rejects(acquireLibraryLock(f.data), error => error instanceof LibraryStartupError && error.code === 'library_lock_unknown' && /硬链接/.test(error.message)); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(await readdir(f.data), ['archive.sqlite']);
  const release = await acquireLibraryLock(f.data); await release();
});

test('sidecar carries a one-shot recovery argument and only typed errors expose its claim', async () => {
  const source = (await readFile('desktop/service.mjs', 'utf8')).replace(/^import .+;\r?$/gm, '');
  const claim = '{"pid":123,"id":"原始 \\\"内容\\\""}';
  for (const typed of [true, false]) {
    const messages: { recoveryClaim?: string; code?: string }[] = [];
    const process = Object.assign(new EventEmitter(), { argv: ['sidecar.mjs', `--recover-lock=${claim}`], env: { SHIYE_LIBRARY_ROOT: 'fixture' }, connected: true, exitCode: 0,
      send: (message: object) => messages.push(message), disconnect: () => { process.connected = false; } });
    await vm.runInNewContext(`(async () => { ${source} })()`, { process, resolve: (...parts: string[]) => parts.join('/'), LibraryStartupError,
      acquireLibraryLock: async (_data: string, options: { recoverClaim: string }) => {
        assert.equal(options.recoverClaim, claim);
        if (typed) throw new LibraryStartupError('library_lock_stale', 'fixture stale', claim);
        throw Object.assign(new Error('private fixture failure'), { recoveryClaim: claim });
      } });
    assert.equal(process.exitCode, 1); assert.equal(process.connected, false);
    assert.equal(messages.length, 1); assert.equal(messages[0].recoveryClaim, typed ? claim : undefined);
    assert.equal(messages[0].code, typed ? 'library_lock_stale' : undefined);
  }
});

test('two Windows recoverers and one ordinary process allow only one owner', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), claim = await deadClaim(); await writeFile(f.lock, claim);
  const workers = await Promise.all([worker(t), worker(t), worker(t)]);
  for (const [index, value] of workers.entries()) value.start(f.data, index < 2 ? claim : undefined);
  const results = await Promise.all(workers.map(value => value.next('acquired', 'error')));
  assert.ok(results.filter(result => result.type === 'acquired').length <= 1, 'An ordinary stale check may win the guard first; no two processes may own the library.');
  assert.ok(results.filter(result => result.type === 'error').every(result => ['library_in_use', 'library_lock_stale'].includes(result.code!)));
  const owner = workers[results.findIndex(result => result.type === 'acquired')];
  if (owner) { owner.child.send({ type: 'release' }); await owner.exited; }
  else { const release = await acquireLibraryLock(f.data, { recoverClaim: claim }); await release(); }
  const archive = (await readdir(f.data)).find(file => file.startsWith('.shiye-service.lock.stale-'));
  assert.ok(archive); assert.equal(await readFile(join(f.data, archive), 'utf8'), claim);
  await assert.rejects(readFile(f.lock), { code: 'ENOENT' });
  assert.equal(await readFile(f.database, 'utf8'), 'unchanged database fixture');
});

test('Windows guard follows real directory aliases and is released when its process dies', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), owner = await worker(t); owner.start(f.data); await owner.next('acquired');
  const alias = join(f.root, 'alias'); await symlink(join(f.data, '..'), alias, 'junction');
  await assert.rejects(acquireLibraryLock(join(alias, 'DATA')), { code: 'library_in_use' });
  const other = join(f.root, 'another/data'), releaseOther = await acquireLibraryLock(other); await releaseOther();
  const claim = await readFile(f.lock, 'utf8'); owner.child.kill(); await owner.exited;
  const release = await acquireLibraryLock(join(alias, 'data'), { recoverClaim: claim }); await release();
  await assert.rejects(readFile(f.lock), { code: 'ENOENT' });
});

for (const pause of ['publish', 'archive']) test(`a crash during Windows ${pause} cannot leave an empty or permanent lock`, { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), claim = await deadClaim();
  if (pause === 'archive') await writeFile(f.lock, claim);
  const interrupted = await worker(t); interrupted.start(f.data, pause === 'archive' ? claim : undefined, pause);
  const message = await interrupted.next('paused');
  if (pause === 'publish') {
    const pending = JSON.parse(await readFile(message.path!, 'utf8')); assert.equal(pending.pid, interrupted.child.pid); assert.ok(pending.id);
    await assert.rejects(readFile(f.lock), { code: 'ENOENT' });
  }
  interrupted.child.kill(); await interrupted.exited;
  const release = await acquireLibraryLock(f.data); await release();
  assert.equal(await readFile(f.database, 'utf8'), 'unchanged database fixture');
  await assert.rejects(readFile(f.lock), { code: 'ENOENT' });
  if (pause === 'archive') {
    const archive = (await readdir(f.data)).find(file => file.startsWith('.shiye-service.lock.stale-'));
    assert.ok(archive); assert.equal(await readFile(join(f.data, archive), 'utf8'), claim);
  }
});

test('an older process winning the recovery gap keeps its lock unmodified', { skip: !windows, timeout: 30000 }, async t => {
  const f = await fixture(t), claim = await deadClaim(); await writeFile(f.lock, claim);
  const recovery = await worker(t); recovery.start(f.data, claim, 'publish'); await recovery.next('paused');
  const oldVersion = JSON.stringify({ pid: process.pid, id: 'legacy-owner' }); await writeFile(f.lock, oldVersion, { flag: 'wx' });
  recovery.child.send({ type: 'continue' });
  assert.equal((await recovery.next('error')).code, 'library_in_use'); await recovery.exited;
  assert.equal(await readFile(f.lock, 'utf8'), oldVersion);
  assert.equal(await readFile(f.database, 'utf8'), 'unchanged database fixture');
});
