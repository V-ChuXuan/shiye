import assert from 'node:assert/strict';
import test from 'node:test';
import { fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Collector, ParsedArticle } from '../shared/types.js';
import { createApp } from '../server/app.js';
import { ArchiveService } from '../server/service.js';
import { Store } from '../server/store.js';

const BIZ = 'IdentifyFixture==', ARTICLE_URL = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(BIZ)}&mid=101&idx=1`;
const parsed: ParsedArticle = { biz: BIZ, mid: '101', idx: '1', title: '未完成的来源识别', account: '识别测试号', url: ARTICLE_URL,
  publishedAt: '2026-10-25', blocks: [{ type: 'text', text: '关闭后不得保存' }], images: [], textLength: 7 };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const turn = () => new Promise(done => setImmediate(done));
async function root(t: test.TestContext) {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const directory = await mkdtemp(join(parent, 'identify-close-'));
  t.after(async () => { assert.ok(directory.startsWith(`${parent}${sep}identify-close-`)); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
  return directory;
}
function source(fetchArticle: Collector['fetchArticle']): Collector {
  const denied = async (): Promise<never> => { throw new Error('No source request in shutdown fixture'); };
  return { fetchArticle, fetchImage: denied, captureSession: denied, discoverPage: denied, hasSession: () => true, getGate: () => null, clearGate() {} };
}

test('direct close cancels every identification and waits for late source settlement without ingesting', { timeout: 5000 }, async t => {
  const directory = await root(t), held = deferred(), signals: (AbortSignal | undefined)[] = [];
  const service = new ArchiveService(join(directory, 'data'), source(async (_url, signal) => { signals.push(signal); await held.promise; return parsed; }), false);
  const first = assert.rejects(service.addAccount({ url: ARTICLE_URL })), second = assert.rejects(service.addAccount({ url: ARTICLE_URL }));
  while (signals.length !== 2) await turn();
  const closing = service.close();
  try {
    await turn();
    assert.ok(signals.every(signal => signal?.aborted), 'All identification requests must receive the service shutdown signal.');
    assert.equal(service.store.db.open, true, 'A late source must settle before closing the database.');
    await assert.rejects(service.addAccount({ biz: BIZ, name: '关闭中' }), /关闭服务/);
  } finally { held.resolve(); await Promise.all([first, second, closing]); }
  await service.close(); assert.equal(service.store.db.open, false);
  const reopened = new Store(join(directory, 'data'));
  try { assert.equal(reopened.accounts().length, 0); assert.equal((reopened.db.prepare('SELECT COUNT(*) AS count FROM articles').get() as { count: number }).count, 0); }
  finally { reopened.close(); }
});

test('HTTP preClose aborts identification before waiting for the active account request', { timeout: 5000 }, async t => {
  const directory = await root(t), entered = deferred(), release = deferred(); let signal: AbortSignal | undefined;
  const app = await createApp({ dataDir: join(directory, 'data'), schedulerEnabled: false, source: source(async (_url, value) => {
    signal = value; entered.resolve();
    await Promise.race([release.promise, new Promise<void>((_done, reject) => value?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }))]);
    return parsed;
  }) });
  const response = app.inject({ method: 'POST', url: '/api/accounts', payload: { url: ARTICLE_URL } });
  await entered.promise; const closing = app.close().then(() => {});
  try { await turn(); assert.equal(signal?.aborted, true); assert.equal((await response).statusCode, 422); await closing; }
  finally { release.resolve(); await response; await closing; }
  assert.equal(app.archive.store.db.open, false);
});

test('real sidecar exits normally during account identification and releases its library lock', { timeout: 7000 }, async t => {
  const directory = await root(t), entry = join(directory, 'sidecar.mjs'), lock = join(directory, 'data/.shiye-service.lock');
  const appModule = new URL('../server/app.ts', import.meta.url).href, startupModule = new URL('../server/startup.ts', import.meta.url).href;
  const wrapper = `import { createApp as originalCreateApp } from ${JSON.stringify(appModule)};
const denied = async () => { throw new Error('No source request in shutdown fixture'); };
const createApp = options => originalCreateApp({ ...options, schedulerEnabled: false, source: {
  fetchArticle: (_url, signal) => { process.send({ type: 'test-identifying', hasSignal: !!signal }); return new Promise((_done, reject) => {
    signal?.addEventListener('abort', () => { process.send({ type: 'test-aborted' }); reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
  }); }, fetchImage: denied, captureSession: denied, discoverPage: denied, hasSession: () => true, getGate: () => null, clearGate() {}
} });`;
  await writeFile(entry, readFileSync('desktop/service.mjs', 'utf8').replace("import { createApp } from '../dist/server/app.js';", wrapper).replace("'../dist/server/startup.js'", JSON.stringify(startupModule)));
  const worker = fork(entry, [], { cwd: resolve('.'), execArgv: ['--import', 'tsx'], env: { ...process.env, SHIYE_LIBRARY_ROOT: directory }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const messages: { type: string; hasSignal?: boolean }[] = [];
  const exited = new Promise<number | null>((done, reject) => { worker.once('exit', done); worker.once('error', reject); });
  const ready = new Promise<number>(done => worker.on('message', message => { const value = message as { type: string; port?: number }; messages.push(value); if (value.type === 'ready') done(value.port!); }));
  t.after(async () => { if (worker.exitCode === null && worker.signalCode === null) { worker.kill(); await exited; } });
  const port = await ready;
  const response = fetch(`http://127.0.0.1:${port}/api/accounts`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: ARTICLE_URL }) });
  void response.catch(() => {});
  try {
    while (!messages.some(message => message.type === 'test-identifying')) { t.signal.throwIfAborted(); await turn(); }
    assert.equal(messages.find(message => message.type === 'test-identifying')!.hasSignal, true);
    worker.send({ type: 'shutdown' });
    assert.equal((await response).status, 422); assert.equal(await exited, 0); assert.equal(worker.signalCode, null);
    assert.ok(messages.some(message => message.type === 'test-aborted')); assert.equal(existsSync(lock), false);
  } finally { if (worker.exitCode === null && worker.signalCode === null) { worker.kill(); await exited; } }
  const reopened = new Store(join(directory, 'data'));
  try { assert.equal(reopened.accounts().length, 0); } finally { reopened.close(); }
});
