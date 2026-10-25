import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const require = createRequire(import.meta.url);
const { readWindowState, saveWindowState } = require('../desktop/config.cjs');
async function fixture(t: test.TestContext) {
  const parent = resolve('data/safe-cancel-verification'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'window-test-'));
  t.after(async () => { assert.ok(root.startsWith(`${parent}${sep}window-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  return join(root, 'window.json');
}
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
test('window preferences retain normal bounds separately from maximized state without changing library binding', async t => {
  const file = await fixture(t), library = join(file, '..', 'library.json');
  await writeFile(library, 'original library binding');
  const bounds = { x: 100, y: 80, width: 1050, height: 750 };
  saveWindowState(file, bounds, true);
  assert.deepEqual(readWindowState(file, [primary]), { ...bounds, minWidth: 760, minHeight: 600, maximized: true });
  assert.equal(await readFile(library, 'utf8'), 'original library binding');
  saveWindowState(file, bounds, false); assert.equal(readWindowState(file, [primary]).maximized, false);
});
test('missing and malformed window preferences fall back to visible defaults', async t => {
  const file = await fixture(t), expected = { x: 270, y: 50, width: 1380, height: 940, minWidth: 760, minHeight: 600, maximized: false };
  assert.deepEqual(readWindowState(file, [primary]), expected);
  for (const value of ['broken', 'null', '{"bounds":{"x":0,"y":0,"width":-1,"height":400},"maximized":true}', '{"bounds":{"x":0,"y":0,"width":"900","height":600},"maximized":true}']) {
    await writeFile(file, value); assert.deepEqual(readWindowState(file, [primary]), expected);
  }
  assert.doesNotThrow(() => saveWindowState(join(file, 'missing'), expected, false));
});
test('window preferences clamp removed monitors, oversized windows and work areas below normal minimums', async t => {
  const file = await fixture(t);
  saveWindowState(file, { x: 2400, y: 80, width: 1500, height: 1000 }, true);
  const small = { x: 0, y: 0, width: 640, height: 480 };
  assert.deepEqual(readWindowState(file, [small]), { x: 0, y: 0, width: 640, height: 480, minWidth: 640, minHeight: 480, maximized: true });
  const second = { x: -1280, y: 0, width: 1280, height: 720 };
  saveWindowState(file, { x: -1200, y: 20, width: 1000, height: 650 }, false);
  assert.deepEqual(readWindowState(file, [primary, second]), { x: -1200, y: 20, width: 1000, height: 650, minWidth: 760, minHeight: 600, maximized: false });
});
