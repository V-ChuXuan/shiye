import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { connect } from 'node:net';
import { join, resolve, sep } from 'node:path';
import vm from 'node:vm';
import { acquireLibraryLock } from '../server/startup.js';

const source = readFileSync('desktop/service.mjs', 'utf8').replace(/^import .+;\r?$/gm, '');
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
async function turn() { await new Promise(done => setImmediate(done)); }

for (const stage of ['lock', 'create', 'listen', 'closing'] as const) test(`sidecar shutdown during ${stage} keeps its lock until initialization and app close settle`, async () => {
  const acquired = deferred<() => Promise<void>>(), created = deferred<unknown>(), listened = deferred<void>(), closed = deferred<void>();
  const events: string[] = [], messages: unknown[] = [];
  const process = Object.assign(new EventEmitter(), { env: { SHIYE_LIBRARY_ROOT: 'fixture' }, exitCode: 0, connected: true,
    send: (message: unknown) => { messages.push(message); }, disconnect: () => { events.push('disconnect'); process.connected = false; } });
  const app = { close: async () => { events.push('close-start'); await closed.promise; events.push('close-end'); },
    listen: async () => { events.push('listen'); await listened.promise; }, server: Object.assign(new EventEmitter(), { address: () => ({ port: 12345 }) }) };
  const completion: Promise<void> = vm.runInNewContext(`(async () => { ${source} })()`, { process, resolve: (...parts: string[]) => parts.join('/'),
    acquireLibraryLock: async () => { events.push('acquire'); return acquired.promise; }, createApp: async () => { events.push('create'); return created.promise; },
    LibraryStartupError: class extends Error {} });
  const release = async () => { events.push('release'); };
  if (stage !== 'lock') { acquired.resolve(release); await turn(); }
  if (stage === 'listen' || stage === 'closing') { created.resolve(app); await turn(); }
  if (stage === 'closing') { listened.resolve(); await turn(); }
  process.emit('message', { type: 'shutdown' }); process.emit('message', { type: 'shutdown' }); await turn();
  assert.equal(events.includes('release'), false, 'Shutdown cannot release a lock while initialization or close is pending.');
  assert.equal(events.includes('disconnect'), false);
  if (stage === 'lock') {
    acquired.resolve(release); await completion; await turn();
    assert.equal(events.includes('create'), false, 'Shutdown before lock acquisition must not open SQLite.');
    assert.deepEqual(events, ['acquire', 'release', 'disconnect']); return;
  }
  created.resolve(app); listened.resolve(); await turn();
  assert.equal(events.includes('release'), false, 'App close must finish before releasing the library.');
  closed.resolve(); await completion; await turn();
  assert.equal(events.filter(event => event === 'release').length, 1);
  assert.equal(events.filter(event => event === 'disconnect').length, 1);
  if (events.includes('create')) assert.ok(events.indexOf('close-end') < events.indexOf('release'));
  assert.equal(messages.filter(message => (message as { type: string }).type === 'ready').length, stage === 'closing' ? 1 : 0);
});

test('a real Node sidecar retains its real library lock while initialization is interrupted', { timeout: 15000 }, async t => {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'service-close-')), data = join(root, 'data'), bootstrap = join(root, 'sidecar.mjs');
  const lock = join(data, '.shiye-service.lock');
  const appModule = new URL('../server/app.ts', import.meta.url).href, startupModule = new URL('../server/startup.ts', import.meta.url).href;
  const wrapper = `import { createApp as originalCreateApp } from ${JSON.stringify(appModule)};
const denied = async () => { throw new Error('The sidecar fixture cannot request WeChat'); };
const createApp = async options => {
  const value = await originalCreateApp({ ...options, schedulerEnabled: false, source: { fetchArticle: denied, fetchImage: denied, fetchCover: denied, captureSession: denied, discoverPage: denied, hasSession: () => false, getGate: () => null, clearGate() {} } });
  process.send({ type: 'test-created' });
  await new Promise(done => { const resume = message => { if (message.type === 'test-continue') { process.removeListener('message', resume); done(); } }; process.on('message', resume); });
  return value;
};`;
  const actual = readFileSync('desktop/service.mjs', 'utf8')
    .replace("import { createApp } from '../dist/server/app.js';", wrapper)
    .replace("'../dist/server/startup.js'", JSON.stringify(startupModule));
  await writeFile(bootstrap, actual);
  const worker = fork(bootstrap, [], { cwd: resolve('.'), execArgv: ['--import', 'tsx'], env: { ...process.env, SHIYE_LIBRARY_ROOT: root }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise<number | null>((done, reject) => { worker.once('error', reject); worker.once('exit', done); });
  t.after(async () => {
    if (worker.exitCode === null && worker.signalCode === null) { worker.kill(); await exited; }
    assert.ok(root.startsWith(`${parent}${sep}service-close-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated sidecar did not create its application')), 10000);
    worker.on('message', message => { if ((message as { type: string }).type === 'test-created') { clearTimeout(timer); done(); } });
  });
  worker.send({ type: 'shutdown' }); await new Promise(done => setTimeout(done, 50));
  assert.equal(existsSync(lock), true, 'The real SQLite application remains open behind the held initialization promise.');
  await assert.rejects(acquireLibraryLock(data), /另一个拾页进程/);
  worker.send({ type: 'test-continue' }); assert.equal(await exited, 0);
  assert.equal(existsSync(lock), false);
  const release = await acquireLibraryLock(data); await release();
});

for (const scenario of ['partial-first', 'partial-next', 'active-body', 'active-pipeline'] as const) test(`sidecar shutdown closes unused HTTP connections and preserves active handlers: ${scenario}`, { timeout: 5000 }, async t => {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'service-http-close-')), data = join(root, 'data'), entry = join(root, 'sidecar.mjs');
  const lock = join(data, '.shiye-service.lock'), received: { type: string; bytes?: number }[] = [];
  const appModule = new URL('../server/app.ts', import.meta.url).href, startupModule = new URL('../server/startup.ts', import.meta.url).href;
  const wrapper = `import { createApp as originalCreateApp } from ${JSON.stringify(appModule)};
const denied = async () => { throw new Error('No WeChat in shutdown fixture'); };
const createApp = async options => {
  const app = await originalCreateApp({ ...options, schedulerEnabled: false, source: { fetchArticle: denied, fetchImage: denied, captureSession: denied, discoverPage: denied, hasSession: () => false, getGate: () => null, clearGate() {} } });
  app.server.on('connection', socket => socket.on('data', () => process.send({ type: 'test-bytes', bytes: socket.bytesRead })));
  app.server.on('request', () => process.send({ type: 'test-request' }));
  process.on('message', message => { if (message.type === 'shutdown') process.send({ type: 'test-stopping' }); });
  let ordinal = 0;
  app.get('/test-held', async () => {
    const index = ++ordinal; process.send({ type: 'test-held' });
    await new Promise(done => { const release = message => { if (message.type === 'test-release' && message.ordinal === index) { process.removeListener('message', release); done(); } }; process.on('message', release); });
    app.archive.store.upsertAccount('Fixture==', '已完成'); return { done: true };
  });
  app.post('/test-body', async request => {
    if (request.body.value !== 'safe') throw new Error('Incomplete request body');
    app.archive.store.upsertAccount('Body==', '已完成'); return { done: true };
  });
  return app;
};`;
  await writeFile(entry, readFileSync('desktop/service.mjs', 'utf8').replace("import { createApp } from '../dist/server/app.js';", wrapper).replace("'../dist/server/startup.js'", JSON.stringify(startupModule)));
  const worker = fork(entry, [], { cwd: resolve('.'), execArgv: ['--import', 'tsx'], env: { ...process.env, SHIYE_LIBRARY_ROOT: root }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const exited = new Promise<number | null>((done, reject) => { worker.once('error', reject); worker.once('exit', done); });
  const ready = new Promise<number>((done, reject) => worker.on('message', message => {
    const value = message as { type: string; port?: number; bytes?: number; message?: string }; received.push(value);
    if (value.type === 'ready') done(value.port!); if (value.type === 'error') reject(new Error(value.message));
  }));
  const port = await ready, socket = connect(port, '127.0.0.1'); let response = '';
  socket.on('data', bytes => { response += bytes.toString(); }); socket.on('error', () => {});
  t.after(async () => {
    if (worker.exitCode === null) t.diagnostic(JSON.stringify({ scenario, received, response }));
    socket.destroy(); if (worker.exitCode === null && worker.signalCode === null) { worker.kill(); await exited; }
    assert.ok(root.startsWith(`${parent}${sep}service-http-close-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await new Promise<void>(done => socket.once('connect', done));
  const waitFor = async (check: () => boolean) => { while (!check()) { t.signal.throwIfAborted(); await new Promise(done => setTimeout(done, 5)); } };
  if (scenario === 'partial-next') {
    socket.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await waitFor(() => response.includes('{"ok":true}'));
  }
  if (scenario === 'active-pipeline') {
    socket.write('GET /test-held HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nGET /test-held HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n');
    await waitFor(() => received.filter(message => message.type === 'test-held').length === 2);
    worker.send({ type: 'shutdown' }); await waitFor(() => received.some(message => message.type === 'test-stopping'));
    assert.equal(existsSync(lock), true); assert.equal(worker.exitCode, null); assert.equal(socket.destroyed, false);
    worker.send({ type: 'test-release', ordinal: 1 }); await waitFor(() => response.includes('{"done":true}'));
    assert.equal(existsSync(lock), true, 'The second pipelined handler must keep the database open.');
    assert.equal(worker.exitCode, null); assert.equal(socket.destroyed, false);
    worker.send({ type: 'test-release', ordinal: 2 });
  } else if (scenario === 'active-body') {
    const body = '{"value":"safe"}';
    socket.write(`POST /test-body HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body.slice(0, 5)}`);
    await waitFor(() => received.some(message => message.type === 'test-request'));
    worker.send({ type: 'shutdown' }); await waitFor(() => received.some(message => message.type === 'test-stopping'));
    assert.equal(existsSync(lock), true); assert.equal(socket.destroyed, false);
    socket.write(body.slice(5));
  } else {
    const previousBytes = received.filter(message => message.type === 'test-bytes').at(-1)?.bytes || 0;
    socket.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n');
    await waitFor(() => received.some(message => message.type === 'test-bytes' && Number(message.bytes) > previousBytes));
    worker.send({ type: 'shutdown' });
  }
  assert.equal(await exited, 0);
  assert.equal(existsSync(lock), false);
  if (scenario === 'active-pipeline') assert.equal((response.match(/\{"done":true\}/g) || []).length, 2, 'Both active handlers must finish before shutdown releases the database.');
  if (scenario === 'active-body') assert.ok(response.includes('{"done":true}'), 'A body already being received must finish before shutdown releases the database.');
});
