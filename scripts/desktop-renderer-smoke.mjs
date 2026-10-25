// Runs the portable application's own renderer against an isolated, offline library.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { Store } from '../dist/server/store.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); process.chdir(root);
const evidence = resolve('data/library-polish-verification'); await mkdir(evidence, { recursive: true });
const packaged = JSON.parse(await readFile('data/desktop-verification/package-result.json', 'utf8'));
assert.equal(packaged.passed, true); assert.ok(existsSync(packaged.executable));
assert.equal(JSON.parse(await readFile('package.json', 'utf8')).version, '0.1.1');
const fixture = await mkdtemp(join(evidence, 'renderer-')), library = join(fixture, '文库 中文 空格');
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const imagePath = join(library, 'pictures/fixture/image.gif'), lockPath = join(library, 'data/.shiye-service.lock');
await mkdir(dirname(imagePath), { recursive: true }); await writeFile(imagePath, image);
const store = new Store(join(library, 'data'));
const account = store.upsertAccount('RendererSmoke==', '界面恢复验收号');
const article = store.upsertArticle({ accountId: account.id, biz: account.biz, title: '界面恢复本地文章',
  url: 'https://mp.weixin.qq.com/s/renderer-fixture', publishedAt: '2026-10-25', status: 'complete', imageCount: 1,
  blocks: [...Array.from({ length: 80 }, (_, index) => ({ type: 'text', text: `第${index + 1}段本地正文，界面恢复保持文库和阅读位置。` })), { type: 'image', seq: 1 }] });
store.saveAsset(article.id, { seq: 1, src: 'https://mmbiz.qpic.cn/renderer-fixture/0', status: 'complete',
  file: 'fixture/image.gif', storageDirectory: join(library, 'pictures'), mime: 'image/gif', bytes: image.length,
  sha256: createHash('sha256').update(image).digest('hex') });
const job = store.createJob(account, 'archive', [article.id]); store.saveJob({ ...job, status: 'paused' }); store.close();
let application;
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) { if (await check()) return; await new Promise(done => setTimeout(done, 100)); }
  assert.fail('Portable renderer recovery did not reach its expected state.');
}
try {
  application = await electron.launch({ executablePath: packaged.executable,
    args: [`--library-root=${library}`, `--user-data-dir=${join(fixture, 'profile')}`], timeout: 30000 });
  const page = await application.firstWindow();
  await application.evaluate(({ session }) => {
    globalThis.__rendererNetwork = [];
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = new URL(details.url).hostname === '127.0.0.1';
      globalThis.__rendererNetwork.push({ url: details.url, allowed }); callback({ cancel: !allowed });
    });
  });
  await page.getByRole('heading', { name: '公众号', exact: true }).waitFor();
  const origin = new URL(page.url()).origin, target = `${origin}/#reader?id=${article.id}`;
  const get = async path => { const response = await fetch(`${origin}/api/${path}`); assert.ok(response.ok, path); return response.json(); };
  assert.equal((await get('about')).version, '0.1.1');
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), '0.1.1');
  assert.equal((await fetch(`${origin}/api/reading-positions/${article.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'body', top: 321 }) })).status, 200);
  await page.evaluate(id => { location.hash = `reader?id=${id}`; }, article.id);
  await page.locator('.reader-sheet h1').filter({ hasText: article.title }).waitFor();
  await page.waitForFunction(() => Math.abs(document.querySelector('.reader-scroll').scrollTop - 321) <= 2);
  const lock = await readFile(lockPath), jobs = await get('jobs'), positions = await get(`reading-positions/${article.id}`);
  const before = await application.evaluate(({ BrowserWindow, dialog, app }, output) => {
    const window = BrowserWindow.getAllWindows()[0];
    const sidecars = () => process._getActiveHandles().filter(handle => typeof handle.send === 'function' &&
      handle.spawnargs?.some(arg => /[\\/]desktop[\\/]service\.mjs$/.test(arg)) && handle.exitCode === null);
    const owned = sidecars(); if (owned.length !== 1) throw new Error('Expected one isolated sidecar.');
    globalThis.__rendererProbe = { messages: [], answer: null, loads: 0, errors: [], events: [], sidecars };
    dialog.showMessageBox = async (...args) => {
      globalThis.__rendererProbe.messages.push(args.at(-1));
      return new Promise(done => { globalThis.__rendererProbe.answer = response => done({ response }); });
    };
    dialog.showErrorBox = (title, message) => globalThis.__rendererProbe.errors.push({ title, message });
    window.webContents.on('did-finish-load', () => { globalThis.__rendererProbe.loads++; });
    for (const event of ['did-start-navigation', 'did-navigate', 'did-navigate-in-page', 'did-fail-load', 'render-process-gone']) {
      window.webContents.on(event, (_event, ...details) => globalThis.__rendererProbe.events.push({ event, details }));
    }
    const load = window.loadURL.bind(window);
    window.loadURL = async (...args) => {
      globalThis.__rendererProbe.events.push({ event: 'loadURL', url: args[0] });
      try { const result = await load(...args); globalThis.__rendererProbe.events.push({ event: 'loadURL-resolved' }); return result; }
      catch (error) { globalThis.__rendererProbe.events.push({ event: 'loadURL-rejected', message: error.message }); throw error; }
    };
    const save = () => process.getBuiltinModule('node:fs').writeFileSync(output, JSON.stringify({ events: globalThis.__rendererProbe.events, messages: globalThis.__rendererProbe.messages }));
    for (const event of ['before-quit', 'will-quit']) app.on(event, () => { globalThis.__rendererProbe.events.push({ event, time: Date.now() }); save(); });
    for (const method of ['send', 'kill']) {
      const original = owned[0][method].bind(owned[0]);
      owned[0][method] = (...args) => { globalThis.__rendererProbe.events.push({ event: `child-${method}`, time: Date.now(), message: args[0] }); save(); return original(...args); };
    }
    owned[0].on('exit', (code, signal) => { globalThis.__rendererProbe.events.push({ event: 'child-exit', time: Date.now(), code, signal }); save(); });
    return { window: window.id, renderer: window.webContents.getOSProcessId(), backend: owned[0].pid };
  }, join(fixture, 'main-events.json'));
  const crash = async () => application.evaluate(({ BrowserWindow }) => { setTimeout(() => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(), 10); });
  await crash();
  await until(async () => application.evaluate(() => globalThis.__rendererProbe.messages.length === 1));
  assert.deepEqual(await application.evaluate(() => globalThis.__rendererProbe.messages[0].buttons), ['重新加载界面', '退出']);
  assert.equal(await application.evaluate(() => globalThis.__rendererProbe.loads), 0, 'A renderer crash must wait for an explicit native choice.');
  assert.equal((await get('health')).ok, true);
  assert.deepEqual(await readFile(lockPath), lock); assert.deepEqual(await get('jobs'), jobs);
  await application.evaluate(() => globalThis.__rendererProbe.answer(0));
  await until(async () => application.evaluate(() => globalThis.__rendererProbe.loads === 1));
  // Playwright keeps the old Page marked crashed; inspect the replacement renderer through Electron.
  const readerState = async () => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`({
    title: document.querySelector('.reader-sheet h1')?.textContent,
    top: document.querySelector('.reader-scroll')?.scrollTop,
    url: location.href
  })`));
  await until(async () => { const current = await readerState(); return current.title === article.title && Math.abs(current.top - 321) <= 2; });
  const recoveredReader = await readerState(); assert.equal(recoveredReader.url, target);
  const capture = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'));
  await writeFile(join(evidence, 'desktop-renderer-recovered.png'), Buffer.from(capture, 'base64'));
  const after = await application.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows(), window = windows[0], owned = globalThis.__rendererProbe.sidecars();
    return { count: windows.length, window: window.id, renderer: window.webContents.getOSProcessId(), backend: owned[0]?.pid, sidecars: owned.length };
  });
  assert.equal(after.count, 1); assert.equal(after.window, before.window); assert.equal(after.backend, before.backend);
  assert.equal(after.sidecars, 1); assert.notEqual(after.renderer, before.renderer);
  assert.deepEqual(await get('jobs'), jobs); assert.deepEqual(await get(`reading-positions/${article.id}`), positions);
  assert.deepEqual(await readFile(lockPath), lock); assert.deepEqual(await readFile(imagePath), image);
  assert.deepEqual(await application.evaluate(() => globalThis.__rendererProbe.errors), []);
  await crash(); await until(async () => application.evaluate(() => globalThis.__rendererProbe.messages.length === 2));
  const closed = application.waitForEvent('close');
  await application.evaluate(() => { setTimeout(() => globalThis.__rendererProbe.answer(1), 10); });
  await closed; application = null;
  const closedAt = Date.now();
  await until(async () => !existsSync(lockPath));
  const shutdown = JSON.parse(await readFile(join(fixture, 'main-events.json'), 'utf8')).events;
  const serviceExit = shutdown.find(event => event.event === 'child-exit');
  assert.equal(serviceExit?.code, 0); assert.equal(serviceExit.signal, null);
  assert.equal(shutdown.some(event => event.event === 'child-kill'), false, 'Explicit exit must finish the owned service without the kill fallback.');
  await assert.rejects(fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }));
  const report = { passed: true, version: '0.1.1', fixture, executable: packaged.executable, before, after, recoveredReader,
    shutdown: { serviceExit, lockReleaseAfterAppCloseMs: Date.now() - closedAt, forcedKill: false },
    checks: ['actual renderer crash waits for native choice without reloading or restarting backend',
      'explicit reload preserves same window, local reader URL and saved scroll position with a new renderer process',
      'backend PID, paused jobs, lock bytes and local image remain unchanged', 'native exit stops owned service and releases its lock',
      'API and Electron report version 0.1.1'] };
  await writeFile(join(evidence, 'desktop-renderer-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  const diagnostics = application && await application.evaluate(({ BrowserWindow }) => {
    const probe = globalThis.__rendererProbe, windows = BrowserWindow.getAllWindows();
    return { messages: probe?.messages, loads: probe?.loads, events: probe?.events, errors: probe?.errors,
      windows: windows.map(window => ({ id: window.id, url: window.webContents.getURL(), renderer: window.webContents.getOSProcessId(), crashed: window.webContents.isCrashed() })),
      sidecars: probe?.sidecars().map(child => child.pid), network: globalThis.__rendererNetwork };
  }).catch(() => null);
  await writeFile(join(evidence, 'desktop-renderer-failure.json'), JSON.stringify({ message: error.message, diagnostics }, null, 2));
  throw error;
} finally {
  if (application) {
    await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 10); }).catch(() => {});
    await application.close().catch(() => {});
  }
}
