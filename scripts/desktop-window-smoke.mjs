// Runs only the portable application with a disposable library and window preferences.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { Store } from '../dist/server/store.js';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const evidence = resolve('data/safe-cancel-verification'); await mkdir(evidence, { recursive: true });
const packaged = JSON.parse(await readFile('data/desktop-verification/package-result.json', 'utf8'));
assert.equal(packaged.passed, true); assert.ok(existsSync(packaged.executable));
const fixture = await mkdtemp(join(evidence, 'desktop-window-')), library = join(fixture, '文库 中文'), profile = join(fixture, 'profile');
const store = new Store(join(library, 'data')); store.close();
const windowFile = join(profile, 'window.json'), libraryFile = join(profile, 'library.json'), lock = join(library, 'data/.shiye-service.lock');
let application, binding, normal;
const checks = [], states = [];
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) { if (await check()) return; await new Promise(done => setTimeout(done, 100)); }
  assert.fail('Portable window did not reach its expected state.');
}
async function launch() {
  application = await electron.launch({ executablePath: packaged.executable, args: [`--library-root=${library}`, `--user-data-dir=${profile}`], timeout: 30000 });
  const page = await application.firstWindow(); await page.getByRole('heading', { name: '公众号', exact: true }).waitFor();
  return application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return { bounds: window.getNormalBounds(), maximized: window.isMaximized(), areas: screen.getAllDisplays().map(display => display.workArea) };
  });
}
async function quit() {
  const process = application.process(); await application.evaluate(({ app }) => app.quit());
  await until(() => process.exitCode !== null || process.signalCode !== null);
  assert.equal(process.exitCode, 0); assert.equal(process.signalCode, null); await until(() => !existsSync(lock));
  await application.close().catch(() => {}); application = undefined;
  if (binding) assert.deepEqual(await readFile(libraryFile), binding, 'Window preferences cannot change the library binding.');
}
function visible(state) {
  assert.ok(state.areas.some(area => state.bounds.x >= area.x && state.bounds.y >= area.y &&
    state.bounds.x + state.bounds.width <= area.x + area.width && state.bounds.y + state.bounds.height <= area.y + area.height));
}
function sameBounds(actual, expected) {
  // Windows at fractional DPI quantizes the native frame once when recreating it.
  assert.equal(actual.x, expected.x); assert.equal(actual.y, expected.y);
  for (const key of ['width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) <= 8, `${key}: ${actual[key]} != ${expected[key]}`);
}
try {
  const initial = await launch(); visible(initial); binding = await readFile(libraryFile);
  normal = await application.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows()[0], area = screen.getPrimaryDisplay().workArea;
    window.setBounds({ x: area.x + 20, y: area.y + 20, width: Math.min(1000, area.width - 40), height: Math.min(700, area.height - 40) });
    return window.getNormalBounds();
  });
  await quit();
  const restored = await launch(); sameBounds(restored.bounds, normal); assert.equal(restored.maximized, false); states.push(restored);
  checks.push('actual normal window bounds survive a portable restart');
  await quit();
  const repeated = await launch(); assert.deepEqual(repeated.bounds, restored.bounds); states.push(repeated);
  checks.push('native frame rounding remains stable across another restart instead of accumulating');
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].maximize());
  await until(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()));
  await quit();
  const maximized = await launch(); sameBounds(maximized.bounds, normal); assert.equal(maximized.maximized, true); states.push(maximized);
  checks.push('maximized state restores separately from normal window bounds');
  await quit();
  await writeFile(windowFile, '{invalid preference');
  const malformed = await launch(); visible(malformed); assert.equal(malformed.maximized, false); states.push(malformed);
  checks.push('malformed independent window preferences fall back without blocking the bound library');
  await quit();
  await writeFile(windowFile, JSON.stringify({ bounds: { x: 100000, y: 100000, width: 20000, height: 20000 }, maximized: false }));
  const offscreen = await launch(); visible(offscreen); states.push(offscreen);
  checks.push('removed-display and oversized bounds recover entirely inside a current display work area');
  await quit();
  const report = { passed: true, fixture, checks, states, libraryBindingUnchanged: true };
  await writeFile(join(evidence, 'desktop-window-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  if (application) { await application.evaluate(({ app }) => app.quit()).catch(() => {}); await application.close().catch(() => {}); }
}
