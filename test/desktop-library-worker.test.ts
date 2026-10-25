import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync('desktop/library.mjs', 'utf8').replace(/^import .+;\r?$/gm, '');
async function turn() { await new Promise(done => setImmediate(done)); }
function fixture() {
  const messages: any[] = [];
  let signal: AbortSignal, complete!: (value: unknown) => void;
  const held = new Promise(done => { complete = done; });
  const process = Object.assign(new EventEmitter(), { connected: true, exitCode: 0,
    send(message: unknown, done: () => void) { messages.push(JSON.parse(JSON.stringify(message))); done(); },
    disconnect() { process.connected = false; process.emit('disconnect'); },
    exit(code: number) { process.exitCode = code; },
  });
  vm.runInNewContext(code, { process, AbortController, LibraryBackupError: class extends Error {},
    backupLibrary: async (_source: string, _target: string, value: AbortSignal) => {
      signal = value;
      return Promise.race([held, new Promise((_done, reject) => value.addEventListener('abort', () => reject(value.reason), { once: true }))]);
    },
  });
  return { process, messages, complete, signal: () => signal };
}
test('dedicated library worker cancellation reports only after the operation observes its abort signal', async () => {
  const f = fixture(); f.process.emit('message', { type: 'backup', source: 'source', target: 'target' });
  assert.equal(f.signal().aborted, false); f.process.emit('message', { type: 'cancel' });
  assert.equal(f.signal().aborted, true); assert.equal(f.messages.length, 0);
  await turn(); assert.deepEqual(f.messages, [{ type: 'cancelled' }]); assert.equal(f.process.exitCode, 0);
  assert.equal(f.process.connected, false);
});
test('a completed library worker result is not replaced by a late cancel request', async () => {
  const f = fixture(); f.process.emit('message', { type: 'backup', source: 'source', target: 'target' });
  f.complete({ directory: 'target', images: 0, articles: 0 }); await turn();
  f.process.emit('message', { type: 'cancel' }); await turn();
  assert.deepEqual(f.messages, [{ type: 'result', result: { directory: 'target', images: 0, articles: 0 } }]);
  assert.equal(f.process.exitCode, 0);
});
test('parent loss cancels library work without attempting an IPC success report', async () => {
  const f = fixture(); f.process.emit('message', { type: 'backup', source: 'source', target: 'target' });
  f.process.disconnect(); await turn();
  assert.equal(f.signal().aborted, true); assert.equal(f.process.exitCode, 1); assert.deepEqual(f.messages, []);
});
