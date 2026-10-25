import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync('desktop/library.mjs', 'utf8').replace(/^import[^\n]+\n/, '');
async function settled() { for (let index = 0; index < 4; index++) await new Promise(done => setImmediate(done)); }
function worker(disconnect = false) {
  const packets: unknown[] = [], calls: string[] = [];
  class Process extends EventEmitter {
    connected = true; exitCode = 0;
    send(packet: unknown, done?: () => void) { packets.push(packet); done?.(); }
    disconnect() { this.connected = false; this.emit('disconnect'); }
    exit(code: number) { this.exitCode = code; }
  }
  const process = new Process();
  const progress = { phase: 'images', completed: 1, total: 2 };
  const operation = async (source: string, target: string, signal: AbortSignal, report: (value: unknown) => void) => {
    calls.push(source); report(progress);
    if (disconnect) { process.disconnect(); assert.equal(signal.aborted, true); report(progress); }
    return { directory: target, articles: 1, images: 2 };
  };
  vm.runInNewContext(source, { process, AbortController, Error, LibraryBackupError: Error, backupLibrary: operation, restoreLibrary: operation });
  return { process, packets, calls, progress };
}

test('library worker sends progress only for its single authorized operation, then its result', async () => {
  const w = worker();
  w.process.emit('message', { type: 'backup', source: 'source', target: 'target' }); await settled();
  w.process.emit('message', { type: 'restore', source: 'another', target: 'elsewhere' }); await settled();
  assert.deepEqual(w.calls, ['source']);
  assert.deepEqual(JSON.parse(JSON.stringify(w.packets)), [{ type: 'progress', progress: w.progress }, { type: 'result', result: { directory: 'target', articles: 1, images: 2 } }]);
  const invalid = worker(); invalid.process.emit('message', { type: 'remove', source: 'source', target: 'target' }); await settled();
  assert.deepEqual(invalid.calls, []); assert.equal((invalid.packets[0] as { type: string }).type, 'error'); assert.equal(invalid.process.exitCode, 1);
});

test('library worker aborts on parent disconnect and cannot send later progress or success', async () => {
  const w = worker(true); w.process.emit('message', { type: 'restore', source: 'source', target: 'target' }); await settled();
  assert.deepEqual(JSON.parse(JSON.stringify(w.packets)), [{ type: 'progress', progress: w.progress }]);
  assert.equal(w.process.exitCode, 1);
});
