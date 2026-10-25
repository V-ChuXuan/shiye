import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url), source = readFileSync('desktop/main.cjs', 'utf8');
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 80; attempt++) { if (check()) return; await new Promise(done => setImmediate(done)); }
  assert.fail('Renderer recovery did not reach its expected state.');
}
function fixture() {
  const messages: { message: string; buttons: string[] }[] = [], answers: ((value: { response: number }) => void)[] = [];
  const loads: string[] = [], children: Child[] = [];
  const state = { quit: 0, initialized: false, crashes: 0, failLoad: false, destroyed: false };
  class Child extends EventEmitter {
    exitCode: number | null = null; signalCode = null; connected = true; stderr = new EventEmitter();
    send() { queueMicrotask(() => this.exit()); } kill() { this.exit(); }
    exit() { this.exitCode = 1; this.connected = false; this.emit('exit', 1); }
  }
  const contents = Object.assign(new EventEmitter(), {
    forcefullyCrashRenderer() { state.crashes++; contents.emit('render-process-gone', {}, { reason: 'killed' }); },
  });
  const window = { webContents: contents, isDestroyed: () => state.destroyed, isMinimized: () => false, show() {}, focus() {}, setTitle() {}, setProgressBar() {},
    async loadURL(url: string) { loads.push(url); if (state.failLoad) { state.failLoad = false; throw new Error('load fixture'); } contents.emit('did-finish-load'); },
  };
  let context: vm.Context;
  const electron = { app: { setName() {}, requestSingleInstanceLock: () => false, quit() { state.quit++; if (state.initialized) vm.runInContext('quitting = true', context); } },
    dialog: { showMessageBox: async (_window: unknown, options: { message: string; buttons: string[] }) => { messages.push(options); return new Promise<{ response: number }>(done => answers.push(done)); } } };
  context = vm.createContext({ require: (name: string) => {
    if (name === 'electron') return electron;
    if (name === 'node:child_process') return { fork: () => { const child = new Child(); children.push(child); queueMicrotask(() => child.emit('message', { type: 'ready', port: 12345 })); return child; } };
    if (name === 'node:fs') return { existsSync: () => true };
    if (name === './config.cjs') return { ...require('../desktop/config.cjs'), saveLibraryRoot() {} };
    return require(name);
  }, process: { argv: [], env: {} }, setTimeout, clearTimeout, AbortSignal,
  fetch: async () => ({ ok: false }), fixture: { root: resolve('data/renderer-fixture'), window, contents } });
  vm.runInContext(source, context);
  vm.runInContext(`paths = libraryPaths(fixture.root); window = fixture.window; origin = 'http://127.0.0.1:12345'; backend = 'backend'; node = 'node'; monitorRenderer(fixture.contents);`, context);
  state.initialized = true;
  const answer = (response: number) => { assert.ok(answers.length); answers.shift()!({ response }); };
  return { context, contents, state, messages, loads, children, answer };
}

test('renderer crash requires one explicit choice and reloads its controlled current page without restarting service', async () => {
  const f = fixture();
  f.contents.emit('did-navigate-in-page', {}, 'http://127.0.0.1:12345/#reader?id=local', true);
  f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
  await until(() => f.messages.length === 1);
  assert.deepEqual(Array.from(f.messages[0].buttons), ['重新加载界面', '退出']); assert.equal(f.loads.length, 0);
  f.contents.emit('unresponsive'); f.contents.emit('render-process-gone', {}, { reason: 'killed' });
  await vm.runInContext("libraryOperation('backup')", f.context); assert.equal(f.messages.length, 1);
  f.answer(0); await until(() => f.loads.length === 1);
  assert.equal(f.loads[0], 'http://127.0.0.1:12345/#reader?id=local'); assert.equal(f.children.length, 0); assert.equal(f.state.crashes, 0);
});

test('unresponsive recovery allows waiting and a late answer cannot kill an already responsive renderer', async () => {
  const f = fixture(); f.contents.emit('unresponsive'); await until(() => f.messages.length === 1);
  assert.deepEqual(Array.from(f.messages[0].buttons), ['重新加载界面', '继续等待', '退出']);
  f.answer(1); await until(() => vm.runInContext('recovering', f.context) === false);
  assert.equal(f.loads.length, 0); assert.equal(f.state.crashes, 0);
  f.contents.emit('unresponsive'); await until(() => f.messages.length === 2);
  f.contents.emit('responsive'); f.answer(0); await until(() => vm.runInContext('recovering', f.context) === false);
  assert.equal(f.loads.length, 0); assert.equal(f.state.crashes, 0);
});

test('explicit reload of an unresponsive renderer suppresses its deliberate crash event', async () => {
  const f = fixture(); f.contents.emit('unresponsive'); await until(() => f.messages.length === 1);
  f.answer(0); await until(() => f.loads.length === 1);
  assert.equal(f.state.crashes, 1); assert.equal(f.messages.length, 1); assert.equal(f.children.length, 0);
});

test('a renderer that crashes while the wait choice is open is still offered crash recovery', async () => {
  const f = fixture(); f.contents.emit('unresponsive'); await until(() => f.messages.length === 1);
  f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); f.answer(1);
  await until(() => f.messages.length === 2);
  assert.deepEqual(Array.from(f.messages[1].buttons), ['重新加载界面', '退出']);
  assert.equal(f.loads.length, 0); assert.equal(f.children.length, 0);
  f.answer(0); await until(() => f.loads.length === 1);
});

test('renderer reload failure waits for another explicit choice, and exit remains available', async () => {
  const f = fixture(); f.state.failLoad = true; f.contents.emit('render-process-gone', {}, { reason: 'crashed' });
  await until(() => f.messages.length === 1); f.answer(0); await until(() => f.messages.length === 2);
  assert.equal(f.loads.length, 1); f.answer(1); await until(() => f.state.quit === 2);
  assert.equal(f.loads.length, 1); assert.equal(f.children.length, 0);
});

test('renderer recovery ignores stale roots, windows, services, quitting and unsafe navigation targets', async () => {
  for (const change of ["paths = libraryPaths(fixture.root + '-other')", 'window = {}', "origin = 'http://127.0.0.1:23456'", 'child = {}', 'quitting = true']) {
    const f = fixture(); f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); await until(() => f.messages.length === 1);
    vm.runInContext(change, f.context); f.answer(0); await until(() => vm.runInContext('recovering', f.context) === false);
    assert.equal(f.loads.length, 0); assert.equal(f.children.length, 0);
  }
  const f = fixture();
  for (const url of ['file:///C:/private', 'http://127.0.0.1:12345/api/settings', 'https://example.com/']) f.contents.emit('did-navigate-in-page', {}, url, true);
  f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); await until(() => f.messages.length === 1); f.answer(0);
  await until(() => f.loads.length === 1); assert.equal(f.loads[0], 'http://127.0.0.1:12345/#accounts');
});

test('a deferred renderer fault is offered once after maintenance ends', async () => {
  const f = fixture(); vm.runInContext('maintenance = true', f.context);
  f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); assert.equal(f.messages.length, 0);
  vm.runInContext('maintenance = false; void recoverRenderer?.()', f.context); await until(() => f.messages.length === 1);
  f.answer(0); await until(() => f.loads.length === 1);
});

test('sidecar death during the renderer prompt hands off to explicit service recovery without auto-fork', async () => {
  const f = fixture(); await vm.runInContext('startService(backend, node)', f.context);
  const child = f.children[0]; f.contents.emit('render-process-gone', {}, { reason: 'crashed' }); await until(() => f.messages.length === 1);
  child.exit(); assert.equal(f.messages.length, 1); f.answer(0); await until(() => f.messages.length === 2);
  assert.deepEqual(Array.from(f.messages[1].buttons), ['重新打开文库', '退出']); assert.equal(f.loads.length, 0); assert.equal(f.children.length, 1);
  f.answer(1); await until(() => f.state.quit === 2);
});
