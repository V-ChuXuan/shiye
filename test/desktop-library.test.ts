import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const source = readFileSync('desktop/main.cjs', 'utf8');
async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 50; attempt++) { if (check()) return; await new Promise(done => setImmediate(done)); }
  assert.fail('Desktop maintenance did not reach the expected state.');
}
function desktop(owned = true) {
  const root = resolve('data/desktop-library-fixture'), parent = resolve('data/desktop-library-destination');
  const messages: { message: string; detail?: string; buttons?: string[] }[] = [], writes: { root: string }[] = [], loads: string[] = [], folders: string[] = [];
  const opens = [parent], responses: number[] = [];
  const requests: { type: string; source: string; target: string }[] = [];
  const titles: string[] = [], progress: number[] = [];
  const messageProgress: { message: string; title?: string; progress?: number }[] = [];
  const state = { activeJobs: 0, failNextStart: false, holdNextStart: false, startupFailures: [] as string[], startupClaims: [] as (string | undefined)[], holdRecovery: false, holdQuit: false, holdComplete: false, quitRequests: 0 };
  const forkArgs: string[][] = [];
  const recoveryAnswers: ((answer: { response: number }) => void)[] = [];
  const quitAnswers: ((answer: { response: number }) => void)[] = [], completeAnswers: ((answer: { response: number }) => void)[] = [];
  const startupTimers: { timer: ReturnType<typeof setTimeout>; callback: () => void }[] = [];
  class Child extends EventEmitter {
    exitCode: number | null = null; signalCode = null; connected = true; stderr = new EventEmitter();
    sent: unknown[] = [];
    constructor(readonly library: string, readonly tool = false) { super(); }
    exit(code: number) { this.exitCode = code; this.connected = false; this.emit('exit', code, null); }
    send(message: { type: string; source: string; target: string }, callback?: (error?: Error) => void) {
      this.sent.push(message); callback?.();
      if (this.tool) requests.push(message);
      else queueMicrotask(() => this.exit(0));
    }
    kill() { this.exit(1); return true; }
  }
  const original = new Child(root), children: Child[] = [];
  const fakeElectron = {
    app: { setName() {}, requestSingleInstanceLock: () => false, quit() { state.quitRequests++; } },
    shell: { openPath: async (path: string) => { folders.push(path); return ''; } },
    dialog: {
      showMessageBox: async (_window: unknown, options: { message: string; detail?: string; buttons?: string[] }) => {
        messages.push(options); messageProgress.push({ message: options.message, title: titles.at(-1), progress: progress.at(-1) });
        if (state.holdRecovery && options.buttons?.[0] === '重新打开文库') return new Promise<{ response: number }>(done => recoveryAnswers.push(done));
        if (state.holdQuit && options.buttons?.[0] === '取消操作并退出') return new Promise<{ response: number }>(done => quitAnswers.push(done));
        if (state.holdComplete && options.message === '文库恢复已完成') return new Promise<{ response: number }>(done => completeAnswers.push(done));
        return { response: responses.shift() ?? 0 };
      },
      showOpenDialog: async () => ({ canceled: false, filePaths: [opens.shift() || parent] }),
    },
  };
  const context = vm.createContext({
    require: (name: string) => {
      if (name === 'electron') return fakeElectron;
      if (name === 'node:child_process') return { fork: (file: string, args: string[], options: { env: { SHIYE_LIBRARY_ROOT?: string } }) => {
        forkArgs.push(Array.from(args));
        const child = new Child(options.env.SHIYE_LIBRARY_ROOT || '', file.endsWith('library.mjs')); children.push(child);
        if (!child.tool) queueMicrotask(() => {
          if (state.holdNextStart) { state.holdNextStart = false; return; }
          const failure = state.startupFailures.shift();
          if (failure) child.emit('message', { type: 'error', code: failure, message: 'startup fixture', recoveryClaim: state.startupClaims.shift() });
          else if (state.failNextStart) { state.failNextStart = false; child.exit(1); }
          else child.emit('message', { type: 'ready', port: 12345 });
        });
        return child;
      } };
      if (name === 'node:fs') return { existsSync: () => true, lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }), writeFileSync: (_file: string, content: string) => writes.push(JSON.parse(content)) };
      if (name === './config.cjs') return { ...require('../desktop/config.cjs'), saveLibraryRoot: (_file: string, root: string) => writes.push({ root }) };
      return require(name);
    },
    process: { argv: [], env: {} }, setTimeout: (callback: () => void, delay: number) => {
      const timer = setTimeout(callback, delay);
      if (delay === 20000) startupTimers.push({ timer, callback });
      return timer;
    }, clearTimeout, AbortSignal,
    fetch: async (url: string) => ({ ok: !url.endsWith('/health'), json: async () => ({ activeJobs: state.activeJobs }) }),
    fixture: { root, original: owned ? original : undefined, loads, titles, progress },
  });
  vm.runInContext(source, context);
  vm.runInContext(`paths = libraryPaths(fixture.root); child = fixture.original; origin = 'http://127.0.0.1:12345'; backend = 'backend'; node = 'node.exe'; configPath = 'library.json'; window = { isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {}, setTitle: title => fixture.titles.push(title), setProgressBar: value => fixture.progress.push(value), loadURL: async url => fixture.loads.push(url) };`, context);
  const start = (operation: string): Promise<void> => vm.runInContext(`libraryOperation('${operation}')`, context);
  const tool = () => children.find(child => child.tool)!;
  const finish = (code = 0) => { tool().emit('message', { type: 'result', result: { directory: requests[0].target, images: 2, articles: 1 } }); tool().exit(code); };
  const timeout = () => { const held = startupTimers.at(-1)!; clearTimeout(held.timer); held.callback(); };
  const answerRecovery = (response: number) => { assert.ok(recoveryAnswers.length); recoveryAnswers.shift()!({ response }); };
  return { root, parent, messages, writes, loads, folders, opens, responses, requests, original, children, context, state, start, tool, finish, timeout, titles, progress, messageProgress, answerRecovery, recoveryAnswers, quitAnswers, completeAnswers, forkArgs };
}

test('unexpected owned-service exit waits for one native choice, then reopens the same library', async () => {
  const d = desktop(false); d.state.holdRecovery = true;
  await vm.runInContext('startService(backend, node)', d.context);
  const stopped = d.children[0]; stopped.exit(1);
  await until(() => d.messages.length === 1);
  assert.deepEqual(Array.from(d.messages[0].buttons || []), ['重新打开文库', '退出']);
  assert.equal(d.children.length, 1, 'Opening the recovery prompt must not restart automatically.');
  stopped.emit('exit', 1, null); await d.start('backup');
  assert.equal(d.messages.length, 1); assert.equal(d.requests.length, 0);
  d.answerRecovery(0);
  await until(() => d.loads.length === 1);
  assert.equal(d.children.length, 2); assert.equal(d.children[1].library, d.root);
  assert.equal(d.writes.length, 0); assert.equal(d.state.quitRequests, 1, 'Only the fixture initial single-instance rejection called quit.');
  assert.equal(d.titles.at(-1), '拾页'); assert.equal(d.progress.at(-1), -1);
});

test('recovery exit and stale native answers do not restart or stop a replacement service', async () => {
  const canceled = desktop(false); canceled.state.holdRecovery = true;
  await vm.runInContext('startService(backend, node)', canceled.context); canceled.children[0].exit(1);
  await until(() => canceled.messages.length === 1); canceled.answerRecovery(1);
  await until(() => canceled.state.quitRequests === 2);
  assert.equal(canceled.children.length, 1); assert.equal(canceled.loads.length, 0);
  const stale = desktop(false); stale.state.holdRecovery = true;
  await vm.runInContext('startService(backend, node)', stale.context); stale.children[0].exit(1);
  await until(() => stale.messages.length === 1);
  stale.context.replacement = stale.original; vm.runInContext('child = replacement', stale.context);
  stale.answerRecovery(0); await new Promise(done => setImmediate(done));
  assert.equal(stale.children.length, 1); assert.equal(stale.original.exitCode, null); assert.equal(stale.loads.length, 0);
});

test('a failed manual reopen allows another explicit choice and clears transient feedback', async () => {
  const d = desktop(false); d.state.holdRecovery = true;
  await vm.runInContext('startService(backend, node)', d.context); d.children[0].exit(1);
  await until(() => d.messages.length === 1); d.state.failNextStart = true; d.answerRecovery(0);
  await until(() => d.messages.length === 2);
  assert.equal(d.children.length, 2); assert.match(d.messages[1].detail || '', /启动失败/);
  assert.equal(d.messageProgress[1].title, '拾页'); assert.equal(d.messageProgress[1].progress, -1);
  d.answerRecovery(0); await until(() => d.loads.length === 1);
  assert.equal(d.children.length, 3); assert.equal(d.children[2].library, d.root);
  assert.equal(d.writes.length, 0);
});

test('quitting, maintenance and external ownership suppress native recovery', async () => {
  for (const flag of ['quitting', 'maintenance']) {
    const d = desktop(false); await vm.runInContext('startService(backend, node)', d.context);
    vm.runInContext(`${flag} = true`, d.context); d.children[0].exit(1);
    await new Promise(done => setImmediate(done)); assert.equal(d.messages.length, 0); assert.equal(d.children.length, 1);
  }
  const quitting = desktop(false); quitting.state.holdRecovery = true;
  await vm.runInContext('startService(backend, node)', quitting.context); quitting.children[0].exit(1);
  await until(() => quitting.messages.length === 1); vm.runInContext('quitting = true', quitting.context); quitting.answerRecovery(0);
  await new Promise(done => setImmediate(done)); assert.equal(quitting.children.length, 1);
  const external = desktop(false); external.original.exit(1); await new Promise(done => setImmediate(done));
  assert.equal(external.messages.length, 0); assert.equal(external.children.length, 0);
});

test('manual reopen preserves typed lock guidance and exits without a second generic failure', async () => {
  const d = desktop(false); d.state.holdRecovery = true;
  await vm.runInContext('startService(backend, node)', d.context); d.children[0].exit(1);
  await until(() => d.messages.length === 1);
  d.state.startupFailures.push('library_lock_unknown'); d.responses.push(2); d.answerRecovery(0);
  await until(() => d.state.quitRequests === 2);
  assert.equal(d.messages.length, 2); assert.deepEqual(Array.from(d.messages[1].buttons || []), ['打开文库目录', '重试', '退出']);
  assert.equal(d.writes.length, 0); assert.equal(d.loads.length, 0); assert.equal(d.children[1].exitCode, 0);
});

test('a reopened service that exits while its page is loading gets another explicit recovery choice', async () => {
  const d = desktop(false); d.state.holdRecovery = true;
  await vm.runInContext('startService(backend, node)', d.context);
  d.children[0].exit(1); await until(() => d.messages.length === 1);
  vm.runInContext('window.loadURL = async () => { child.exit(1); }', d.context);
  d.answerRecovery(0); await until(() => d.messages.length === 2);
  assert.equal(d.children.length, 2, 'A failed reopened service must wait for another click.');
  d.answerRecovery(1); await until(() => d.state.quitRequests === 2);
  assert.equal(vm.runInContext('recovering', d.context), false);
});

test('native library progress rejects malformed or late updates and clears before terminal messages', async () => {
  const d = desktop(); const operation = d.start('backup'); await until(() => d.requests.length === 1);
  assert.ok(d.titles.some(title => /备份/.test(title))); assert.ok(d.progress.includes(2));
  for (const progress of [{ phase: 'unknown', completed: 1, total: 2 }, { phase: 'images', completed: -1, total: 2 },
    { phase: 'images', completed: 3, total: 2 }, { phase: 'images', completed: 1.5, total: 2 }, { phase: 'images', completed: 0, total: Infinity },
    { phase: 'images', completed: 1, total: 2, path: 'must not be exposed' }]) {
    const count = d.titles.length; d.tool().emit('message', { type: 'progress', progress }); assert.equal(d.titles.length, count);
  }
  d.tool().emit('message', { type: 'progress', progress: { phase: 'images', completed: 1, total: 2 } });
  assert.match(d.titles.at(-1)!, /1 \/ 2/); assert.equal(d.progress.at(-1), 0.5);
  d.tool().emit('message', { type: 'progress', progress: { phase: 'publishing', completed: 2, total: 2 } });
  assert.ok(d.progress.at(-1)! < 1);
  d.finish(); await operation;
  assert.equal(d.titles.at(-1), '拾页'); assert.equal(d.progress.at(-1), -1);
  assert.deepEqual(d.messageProgress.find(item => item.message === '文库备份已完成'), { message: '文库备份已完成', title: '拾页', progress: -1 });
  const count = d.titles.length; d.tool().emit('message', { type: 'progress', progress: { phase: 'images', completed: 1, total: 2 } });
  assert.equal(d.titles.length, count);
  const canceled = desktop(); canceled.responses.push(1); await canceled.start('backup');
  assert.equal(canceled.titles.at(-1), '拾页'); assert.equal(canceled.progress.at(-1), -1);
  const failed = desktop(); const failure = failed.start('backup'); await until(() => failed.requests.length === 1); failed.finish(1); await failure;
  assert.equal(failed.titles.at(-1), '拾页'); assert.equal(failed.progress.at(-1), -1);
  assert.deepEqual(failed.messageProgress.find(item => item.message === '文库操作未完成'), { message: '文库操作未完成', title: '拾页', progress: -1 });
});

test('a result closes progress but cannot hide a worker error before its exit', async () => {
  const d = desktop(); const operation = d.start('backup'); await until(() => d.requests.length === 1);
  d.tool().emit('message', { type: 'result', result: { directory: d.requests[0].target, images: 2, articles: 1 } });
  const count = d.titles.length; d.tool().emit('message', { type: 'progress', progress: { phase: 'images', completed: 1, total: 2 } });
  assert.equal(d.titles.length, count);
  d.tool().emit('message', { type: 'error', message: 'late failure must remain visible' }); d.tool().exit(0); await operation;
  assert.equal(d.messages.some(item => item.message === '文库备份已完成'), false);
  assert.ok(d.messages.some(item => /late failure/.test(item.detail || '')));
  assert.equal(d.progress.at(-1), -1);
});

test('backup restart timeout stops its own child and ignores a late ready message', async () => {
  const d = desktop(); const operation = d.start('backup'); await until(() => d.requests.length === 1);
  d.state.holdNextStart = true; d.finish(); await until(() => d.children.some(child => !child.tool));
  const restart = d.children.find(child => !child.tool)!;
  d.timeout(); await operation;
  assert.notEqual(restart.exitCode, null, 'A rejected startup must not retain its service process.');
  restart.emit('message', { type: 'ready', port: 23456 }); await new Promise(done => setImmediate(done));
  assert.equal(d.loads.length, 0); assert.equal(vm.runInContext('maintenance', d.context), false);
  assert.ok(d.messages.some(item => /未能恢复服务/.test(item.message)));
});

test('a spawn error without an exit event settles on close and ignores late ready', async () => {
  const d = desktop(false); d.state.holdNextStart = true;
  const startup: Promise<string> = vm.runInContext('startService(backend, node)', d.context);
  const rejected = assert.rejects(startup, /无法启动随包运行环境/);
  await until(() => d.children.length === 1);
  const owned = d.children[0];
  owned.connected = false; owned.kill = () => false;
  owned.emit('error', new Error('spawn failed')); owned.emit('close', 1, null);
  await rejected;
  owned.emit('message', { type: 'ready', port: 23456 });
  assert.equal(vm.runInContext('child', d.context), undefined);
});

test('startup failure cleanup never stops a newer service assigned to the global slot', async () => {
  const d = desktop(false); d.state.holdNextStart = true;
  const startup: Promise<string> = vm.runInContext('startService(backend, node)', d.context);
  const rejected = assert.rejects(startup, /无法启动随包运行环境/);
  await until(() => d.children.length === 1);
  const owned = d.children[0]; d.context.replacement = d.original;
  vm.runInContext('child = replacement', d.context);
  owned.emit('error', new Error('old startup failed')); await rejected;
  assert.notEqual(owned.exitCode, null);
  assert.equal(d.original.exitCode, null);
  assert.equal(vm.runInContext('child === replacement', d.context), true);
});

test('desktop stale-lock recovery opens only its bound directory and forwards an explicit exact claim once', async () => {
  const claim = JSON.stringify({ pid: 1234, id: 'stale fixture' });
  const d = desktop(false); d.state.startupFailures.push('library_lock_stale'); d.state.startupClaims.push(claim); d.responses.push(1, 0);
  const origin = await vm.runInContext('service(backend, node)', d.context);
  assert.equal(origin, 'http://127.0.0.1:12345');
  assert.deepEqual(d.folders, [resolve(d.root, 'data')]);
  assert.equal(d.children.length, 2);
  assert.equal(d.children[0].exitCode, 0, 'Retry waits for its failed sidecar to stop.');
  assert.ok(d.messages.every(item => item.buttons?.join('|') === '恢复并打开|打开文库目录|退出'));
  assert.match(d.messages[0].detail || '', /再次确认/);
  assert.deepEqual(d.forkArgs, [[], [`--recover-lock=${claim}`]]);
  assert.ok(d.messages.every(item => !/删除.*\.shiye-service\.lock/.test(item.detail || '')));
  assert.equal(d.writes.length, 0); assert.equal(d.loads.length, 0);
});

test('a changed recovery claim requires a new choice and never reuses the previous authorization', async () => {
  const first = JSON.stringify({ pid: 1234, id: 'first' }), second = JSON.stringify({ pid: 1235, id: 'second' });
  const d = desktop(false); d.state.startupFailures.push('library_lock_stale', 'library_lock_stale');
  d.state.startupClaims.push(first, second); d.responses.push(0, 2);
  await assert.rejects(vm.runInContext('service(backend, node)', d.context));
  assert.deepEqual(d.forkArgs, [[], [`--recover-lock=${first}`]]);
  assert.equal(d.messages.length, 2); assert.equal(d.loads.length, 0);
  for (const claim of [undefined, '', 'x'.repeat(1025)]) {
    const unknown = desktop(false); unknown.state.startupFailures.push('library_lock_stale'); unknown.state.startupClaims.push(claim); unknown.responses.push(2);
    await assert.rejects(vm.runInContext('service(backend, node)', unknown.context));
    assert.equal(unknown.messages[0].buttons?.join('|'), '打开文库目录|重试|退出');
    assert.deepEqual(unknown.forkArgs, [[]]);
  }
});

test('desktop typed lock guidance preserves live, unknown and incomplete libraries on exit', async () => {
  for (const code of ['library_in_use', 'library_lock_unknown', 'library_incomplete']) {
    const d = desktop(false); d.state.startupFailures.push(code); d.responses.push(2);
    await assert.rejects(vm.runInContext('service(backend, node)', d.context), (error: unknown) => Boolean(error && (error as { reported?: boolean }).reported));
    assert.equal(d.children.length, 1); assert.equal(d.children[0].exitCode, 0);
    assert.equal(d.folders.length, 0); assert.equal(d.writes.length, 0); assert.equal(d.loads.length, 0);
    assert.ok(!/只删除/.test(d.messages[0].detail || ''), 'Startup guidance must not ask users to delete lock files.');
    if (code === 'library_incomplete') assert.match(d.messages[0].detail || '', /不要删除.*shiye-incomplete/);
  }
  const ordinary = desktop(false); ordinary.state.startupFailures.push('not_a_library_error');
  await assert.rejects(vm.runInContext('service(backend, node)', ordinary.context), /startup fixture/);
  assert.equal(ordinary.messages.length, 0, 'Unrecognized failures must keep the ordinary startup-error path.');
});

test('desktop backup waits for worker exit and restarts only its original service', async () => {
  const d = desktop(); const operation = d.start('backup');
  await until(() => d.requests.length === 1);
  assert.equal(d.original.exitCode, 0);
  assert.equal(d.requests[0].source, d.root);
  assert.equal(d.requests[0].type, 'backup');
  d.tool().emit('message', { type: 'result', result: { directory: d.requests[0].target, images: 2, articles: 1 } });
  await new Promise(done => setImmediate(done));
  assert.equal(d.loads.length, 0, 'A result message is not a completed worker.');
  assert.equal(vm.runInContext('maintenance', d.context), true);
  await d.start('backup');
  assert.equal(d.requests.length, 1, 'A second menu click cannot start another maintenance worker.');
  d.tool().exit(0); await operation;
  assert.equal(d.children.filter(child => !child.tool)[0].library, d.root);
  assert.equal(d.loads.length, 1); assert.equal(d.writes.length, 0);
  assert.ok(d.messages.some(item => item.message === '文库备份已完成'));
});

test('desktop backup rejects external ownership and restarts after worker failure', async () => {
  const external = desktop(false); await external.start('backup');
  assert.equal(external.children.length, 0); assert.equal(external.opens.length, 1);
  assert.ok(external.messages.some(item => /其他.*服务/.test(item.detail || item.message)));
  const d = desktop(); const operation = d.start('backup'); await until(() => d.requests.length === 1);
  d.finish(1); await operation;
  assert.equal(d.children.filter(child => !child.tool)[0].library, d.root);
  assert.equal(d.loads.length, 1);
  assert.equal(d.messages.some(item => item.message === '文库备份已完成'), false);
  assert.equal(vm.runInContext('maintenance', d.context), false);
});

test('desktop restore requires an explicit open decision before changing libraries', async () => {
  const d = desktop(); d.responses.push(0, 1);
  const operation = d.start('restore'); await until(() => d.requests.length === 1);
  assert.equal(d.requests[0].type, 'restore');
  assert.notEqual(d.requests[0].source, d.requests[0].target);
  d.finish(); await operation;
  assert.equal(d.original.exitCode, null); assert.equal(d.writes.length, 0); assert.equal(d.loads.length, 0);
  const opened = desktop(); const opening = opened.start('restore'); await until(() => opened.requests.length === 1);
  opened.finish(); await opening;
  assert.equal(opened.original.exitCode, 0);
  assert.equal(opened.writes.at(-1)?.root, opened.requests[0].target);
  assert.equal(opened.children.filter(child => !child.tool)[0].library, opened.requests[0].target);
  assert.equal(opened.loads.length, 1);
});

test('desktop restore rolls back a failed service switch and backup rejects active tasks', async () => {
  const busy = desktop(); busy.state.activeJobs = 1; await busy.start('backup');
  assert.equal(busy.children.length, 0); assert.equal(busy.original.exitCode, null);
  const d = desktop(); const operation = d.start('restore'); await until(() => d.requests.length === 1);
  d.state.failNextStart = true; d.finish(); await operation;
  assert.equal(d.children.filter(child => !child.tool).length, 2);
  assert.equal(d.writes.at(-1)?.root, d.root);
  assert.equal(vm.runInContext('paths.root', d.context), d.root);
  assert.equal(d.loads.length, 1);
  assert.ok(d.messages.some(item => /文件已生成/.test(item.message)));
  assert.equal(vm.runInContext('maintenance', d.context), false);
});

test('native cancellation waits for the worker and restores only the owned backup service', async () => {
  for (const operation of ['backup', 'restore']) {
    const d = desktop(); const pending = d.start(operation); await until(() => d.requests.length === 1);
    vm.runInContext('cancelWork(); cancelWork();', d.context);
    assert.equal(d.tool().sent.filter((message: any) => message.type === 'cancel').length, 1);
    assert.equal(vm.runInContext('maintenance', d.context), true);
    assert.equal(d.children.filter(child => !child.tool).length, 0);
    d.tool().emit('message', { type: 'cancelled' });
    assert.equal(vm.runInContext('maintenance', d.context), true, 'Cancellation is not complete before worker exit.');
    d.tool().exit(0); await pending;
    assert.equal(d.children.filter(child => !child.tool).length, operation === 'backup' ? 1 : 0);
    assert.equal(vm.runInContext('maintenance', d.context), false);
    assert.ok(d.messages.some(message => message.message === '文库操作已取消'));
    assert.equal(d.writes.length, 0);
    assert.equal(vm.runInContext('cancelWork', d.context), undefined);
  }
});

test('cancellation and published results keep the worker final outcome in either message order', async () => {
  for (const cancelFirst of [true, false]) {
    const d = desktop(); const pending = d.start('backup'); await until(() => d.requests.length === 1);
    if (cancelFirst) vm.runInContext('cancelWork()', d.context);
    d.tool().emit('message', { type: 'result', result: { directory: d.requests[0].target, images: 2, articles: 1 } });
    vm.runInContext('cancelWork()', d.context);
    assert.equal(d.tool().sent.filter((message: any) => message.type === 'cancel').length, cancelFirst ? 1 : 0);
    d.tool().exit(0); await pending;
    assert.ok(d.messages.some(message => message.message === '文库备份已完成'));
    assert.equal(d.messages.some(message => message.message === '文库操作已取消'), false);
  }
});

test('cancel and exit waits for library work without reopening a sidecar or terminating an external service', async () => {
  for (const operation of ['backup', 'restore']) {
    const d = desktop(operation === 'backup'); const pending = d.start(operation); await until(() => d.requests.length === 1);
    let prevented = false;
    d.context.quitEvent = { preventDefault() { prevented = true; } };
    await vm.runInContext('requestQuit(quitEvent)', d.context);
    assert.equal(prevented, true);
    assert.deepEqual(Array.from(d.messages.at(-1)?.buttons || []), ['取消操作并退出', '继续等待']);
    assert.equal(d.state.quitRequests, 1);
    assert.equal(d.tool().sent.filter((message: any) => message.type === 'cancel').length, 1);
    d.tool().emit('message', { type: 'cancelled' }); d.tool().exit(0); await pending;
    assert.equal(d.children.filter(child => !child.tool).length, 0);
    assert.equal(d.state.quitRequests, 2);
    if (operation === 'restore') assert.equal(d.original.exitCode, null);
  }
});

test('waiting instead of cancelling keeps the library worker active', async () => {
  const d = desktop(); const pending = d.start('backup'); await until(() => d.requests.length === 1);
  d.responses.push(1); d.context.quitEvent = { preventDefault() {} };
  await vm.runInContext('requestQuit(quitEvent)', d.context);
  assert.equal(d.tool().sent.filter((message: any) => message.type === 'cancel').length, 0);
  assert.equal(d.state.quitRequests, 1);
  d.finish(); await pending;
  assert.equal(d.loads.length, 1);
});

test('an exit answer after worker success still exits after maintenance settles without converting success to cancellation', async () => {
  const d = desktop(false); d.state.holdQuit = true; d.state.holdComplete = true;
  const operation = d.start('restore'); await until(() => d.requests.length === 1);
  d.context.quitEvent = { preventDefault() {} };
  const question = vm.runInContext('requestQuit(quitEvent)', d.context);
  await until(() => d.quitAnswers.length === 1);
  d.finish(); await until(() => d.completeAnswers.length === 1);
  assert.equal(vm.runInContext('cancelWork', d.context), undefined);
  assert.equal(vm.runInContext('maintenance', d.context), true);
  d.quitAnswers.shift()!({ response: 0 }); await question;
  d.completeAnswers.shift()!({ response: 1 }); await operation;
  assert.equal(d.state.quitRequests, 2);
  assert.equal(d.tool().sent.filter((message: any) => message.type === 'cancel').length, 0);
  assert.equal(d.original.exitCode, null);
  assert.ok(d.messages.some(message => message.message === '文库恢复已完成'));
  assert.equal(d.messages.some(message => message.message === '文库操作已取消'), false);
});

test('restore maintenance replays an owned service exit after cancellation, failure or keeping the current library', async () => {
  for (const outcome of ['cancelled', 'failed', 'kept']) {
    const d = desktop(false); d.state.holdRecovery = true;
    await vm.runInContext('startService(backend, node)', d.context);
    d.context.contents = new EventEmitter();
    vm.runInContext('window.webContents = contents; monitorRenderer(contents)', d.context);
    const operation = d.start('restore'); await until(() => d.requests.length === 1);
    d.children[0].exit(1);
    assert.equal(d.messages.some(message => message.message === '本地服务已停止'), false);
    if (outcome === 'cancelled') { d.tool().emit('message', { type: 'cancelled' }); d.tool().exit(0); }
    else { if (outcome === 'kept') d.responses.push(1); d.finish(outcome === 'failed' ? 1 : 0); }
    await operation;
    await until(() => d.recoveryAnswers.length === 1);
    assert.equal(d.children.length, 2, 'A deferred exit still waits for an explicit reopen choice.');
    assert.equal(d.messages.filter(message => message.message === '本地服务已停止').length, 1);
    d.answerRecovery(0); await until(() => d.loads.length === 1);
    assert.equal(d.children[2].library, d.root); assert.equal(d.writes.length, 0);
  }
});

test('restore recovery never acts on a replaced service or an externally managed library', async () => {
  const switched = desktop(false); switched.state.holdRecovery = true;
  await vm.runInContext('startService(backend, node)', switched.context);
  const operation = switched.start('restore'); await until(() => switched.requests.length === 1);
  switched.children[0].exit(1); switched.finish(); await operation;
  assert.equal(switched.writes.at(-1)?.root, switched.requests[0].target);
  assert.equal(switched.messages.some(message => message.message === '本地服务已停止'), false);
  const external = desktop(false); const pending = external.start('restore'); await until(() => external.requests.length === 1);
  external.original.exit(1); external.tool().emit('message', { type: 'cancelled' }); external.tool().exit(0); await pending;
  assert.equal(external.messages.some(message => message.message === '本地服务已停止'), false);
  assert.equal(external.children.length, 1);
});

test('maintenance and exit questions replay service recovery only after choosing to keep waiting', async () => {
  for (const maintenanceFirst of [true, false]) for (const exit of [true, false]) {
    const d = desktop(false); d.state.holdRecovery = true; d.state.holdQuit = true;
    await vm.runInContext('startService(backend, node)', d.context);
    const operation = d.start('restore'); await until(() => d.requests.length === 1);
    d.context.quitEvent = { preventDefault() {} };
    const question = vm.runInContext('requestQuit(quitEvent)', d.context); await until(() => d.quitAnswers.length === 1);
    d.children[0].exit(1);
    if (maintenanceFirst) {
      d.tool().emit('message', { type: 'cancelled' }); d.tool().exit(0); await operation;
      assert.equal(d.messages.some(message => message.message === '本地服务已停止'), false, 'Do not stack recovery over an unanswered exit question.');
    }
    d.quitAnswers.shift()!({ response: exit ? 0 : 1 }); await question;
    if (!maintenanceFirst) { d.tool().emit('message', { type: 'cancelled' }); d.tool().exit(0); await operation; }
    if (exit) {
      assert.equal(d.messages.some(message => message.message === '本地服务已停止'), false);
      assert.equal(d.state.quitRequests, 2);
    } else {
      await until(() => d.recoveryAnswers.length === 1); d.answerRecovery(0); await until(() => d.loads.length === 1);
      assert.equal(d.children[2].library, d.root);
    }
  }
});
