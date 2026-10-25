// Uses only a disposable library and a held offline collector in the packaged sidecar.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import { extractFile } from '@electron/asar';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); process.chdir(root);
const evidence = resolve('data/safe-cancel-verification'); await mkdir(evidence, { recursive: true });
const packaged = JSON.parse(await readFile('data/desktop-verification/package-result.json', 'utf8'));
assert.equal(packaged.passed, true); assert.ok(existsSync(packaged.executable));
const resources = join(dirname(packaged.executable), 'resources'), backend = join(resources, 'backend');
const runtime = join(resources, 'runtime/node.exe'); assert.ok(existsSync(runtime));
const fixture = await mkdtemp(join(evidence, 'identify-')), library = join(fixture, '文库 中文 空格');
const original = await readFile(join(backend, 'desktop/service.mjs'), 'utf8');
const wrapper = `import { createApp as originalCreateApp } from ${JSON.stringify(pathToFileURL(join(backend, 'dist/server/app.js')).href)};
const denied = async () => { throw new Error('No WeChat in identification shutdown smoke'); };
const createApp = options => originalCreateApp({ ...options, schedulerEnabled: false, source: {
  fetchArticle: (_url, signal) => { process.send({ type: 'test-identifying', hasSignal: !!signal }); return new Promise((_done, reject) => {
    signal?.addEventListener('abort', () => { process.send({ type: 'test-aborted' }); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
  }); }, fetchImage: denied, captureSession: denied, discoverPage: denied, hasSession: () => true, getGate: () => null, clearGate() {}
} });`;
assert.ok(original.includes("import { createApp } from '../dist/server/app.js';"));
const entry = join(fixture, 'sidecar.mjs');
await writeFile(entry, original.replace("import { createApp } from '../dist/server/app.js';", wrapper)
  .replace("'../dist/server/startup.js'", JSON.stringify(pathToFileURL(join(backend, 'dist/server/startup.js')).href)));
const shell = extractFile(join(resources, 'app.asar'), 'desktop/main.cjs').toString();
const begin = shell.indexOf('async function stopService('), end = shell.indexOf('\nconst ownsService', begin);
assert.ok(begin >= 0 && end > begin);
const worker = fork(entry, [], { execPath: runtime, execArgv: [], cwd: backend, env: { ...process.env, SHIYE_LIBRARY_ROOT: library }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
const messages = []; let forcedKill = false, stderr = '';
worker.stderr.on('data', bytes => { stderr += bytes; });
const kill = worker.kill.bind(worker); worker.kill = (...args) => { forcedKill = true; return kill(...args); };
const exited = new Promise((done, reject) => { worker.once('exit', (code, signal) => done({ code, signal })); worker.once('error', reject); });
const ready = new Promise((done, reject) => {
  const timeout = setTimeout(() => reject(new Error('Packaged sidecar did not start')), 10000);
  worker.on('message', message => { messages.push(message); if (message.type === 'ready') { clearTimeout(timeout); done(message.port); } });
  worker.once('exit', () => { clearTimeout(timeout); reject(new Error('Packaged sidecar exited before readiness')); });
});
try {
  const port = await ready;
  const response = fetch(`http://127.0.0.1:${port}/api/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://mp.weixin.qq.com/s?__biz=IdentifySmoke%3D%3D&mid=101&idx=1' }), signal: AbortSignal.timeout(20000) });
  void response.catch(() => {});
  for (let attempt = 0; attempt < 100 && !messages.some(message => message.type === 'test-identifying'); attempt++) await new Promise(done => setTimeout(done, 20));
  assert.equal(messages.find(message => message.type === 'test-identifying')?.hasSignal, true);
  const context = vm.createContext({ child: worker, setTimeout, clearTimeout });
  const started = Date.now(); await vm.runInContext(`(${shell.slice(begin, end)})()`, context);
  const elapsedMs = Date.now() - started, exit = await exited;
  assert.equal((await response).status, 422); assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(forcedKill, false); assert.ok(elapsedMs < 15000); assert.ok(messages.some(message => message.type === 'test-aborted'));
  assert.equal(existsSync(join(library, 'data/.shiye-service.lock')), false);
  const database = new Database(join(library, 'data/archive.sqlite'), { readonly: true });
  try { assert.equal(database.prepare('SELECT COUNT(*) AS count FROM accounts').get().count, 0); assert.equal(database.prepare('SELECT COUNT(*) AS count FROM articles').get().count, 0); }
  finally { database.close(); }
  const report = { passed: true, fixture, elapsedMs, exit, forcedKill, lockReleased: true, lateIngest: false,
    packagedSidecarSha256: createHash('sha256').update(original).digest('hex'), packagedMainSha256: createHash('sha256').update(shell).digest('hex') };
  await writeFile(join(evidence, 'identify-shutdown-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  await writeFile(join(evidence, 'identify-shutdown-failure.json'), JSON.stringify({ message: error.message, messages, stderr }, null, 2)); throw error;
} finally { if (worker.exitCode === null && worker.signalCode === null) { worker.kill(); await exited; } }
