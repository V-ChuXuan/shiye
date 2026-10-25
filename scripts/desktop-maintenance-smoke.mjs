// Stops only an isolated portable application's owned sidecar during a real restore.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { _electron as electron } from 'playwright-core';
import { Store } from '../dist/server/store.js';
import { backupLibrary } from '../dist/server/library-backup.js';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const evidence = resolve('data/maintenance-reliability-verification'); await mkdir(evidence, { recursive: true });
const packaged = JSON.parse(await readFile('data/desktop-verification/package-result.json', 'utf8'));
assert.equal(packaged.passed, true); assert.ok(existsSync(packaged.executable));
const fixture = await mkdtemp(join(evidence, 'desktop-maintenance-')), library = join(fixture, '原文库 中文'), backup = join(fixture, '完整备份');
const profile = join(fixture, 'profile'), destination = join(fixture, '恢复位置'), lock = join(library, 'data/.shiye-service.lock');
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(destination); await mkdir(join(library, 'pictures/fixture'), { recursive: true });
const store = new Store(join(library, 'data')), account = store.upsertAccount('Maintenance==', '维护恢复测试号');
const article = store.upsertArticle({ accountId: account.id, biz: account.biz, title: '维护后仍应可读', url: 'https://mp.weixin.qq.com/s/maintenance-fixture',
  status: 'complete', imageCount: 128, blocks: [{ type: 'text', text: '维护取消后，后台退出仍应提供明确恢复入口。' }] });
for (let seq = 1; seq <= 128; seq++) {
  const file = `fixture/${String(seq).padStart(3, '0')}.gif`; await writeFile(join(library, 'pictures', file), image);
  store.saveAsset(article.id, { seq, src: `https://mmbiz.qpic.cn/maintenance/${seq}/0`, status: 'complete', file,
    storageDirectory: join(library, 'pictures'), mime: 'image/gif', bytes: image.length, sha256: hash(image) });
}
store.close(); await backupLibrary(library, backup);
const snapshot = () => {
  const db = new Database(join(library, 'data/archive.sqlite'), { readonly: true });
  try { return JSON.stringify(['accounts', 'articles', 'assets', 'jobs'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())); }
  finally { db.close(); }
};
const original = snapshot(), originalManifest = hash(await readFile(join(backup, 'shiye-backup.json')));
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) { if (await check()) return; await new Promise(done => setTimeout(done, 100)); }
  assert.fail('Portable maintenance recovery did not reach the expected state.');
}
let application;
try {
  application = await electron.launch({ executablePath: packaged.executable,
    args: [`--library-root=${library}`, `--user-data-dir=${profile}`], timeout: 30000 });
  const page = await application.firstWindow(); await page.getByRole('heading', { name: '公众号', exact: true }).waitFor();
  const origin = new URL(page.url()).origin;
  await application.evaluate(({ BrowserWindow, Menu, dialog, session }, options) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: new URL(details.url).hostname !== '127.0.0.1' }));
    const window = BrowserWindow.getAllWindows()[0], title = window.setTitle.bind(window), menu = Menu.getApplicationMenu();
    const sidecars = () => process._getActiveHandles().filter(handle => handle.spawnargs?.some(arg => /[\\/]desktop[\\/]service\.mjs$/.test(arg)) && handle.exitCode === null && handle.signalCode === null);
    const owned = sidecars(); if (owned.length !== 1) throw new Error('Expected one owned disposable sidecar.');
    const probe = globalThis.__maintenanceProbe = { messages: [], originalPid: owned[0].pid, sidecarExit: null, workerExit: null, kills: 0,
      stoppedDuringRestore: false, cancelRequests: 0, sidecars, answer: null };
    const choices = [options.backup, options.destination];
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [choices.shift()] });
    dialog.showMessageBox = async (...args) => {
      const value = args.at(-1); probe.messages.push(value);
      if (value.message === '本地服务已停止') return new Promise(done => { probe.answer = response => done({ response }); });
      return { response: value.message === '文库恢复已完成' ? 1 : 0 };
    };
    window.setTitle = value => {
      title(value);
      if (probe.stoppedDuringRestore || !value.includes('复制图片 0 /')) return;
      probe.stoppedDuringRestore = true;
      const worker = process._getActiveHandles().find(handle => handle.spawnargs?.some(arg => /[\\/]desktop[\\/]library\.mjs$/.test(arg)) && handle.exitCode === null);
      if (!worker) throw new Error('Restore worker is missing.');
      const kill = worker.kill.bind(worker), send = worker.send.bind(worker);
      worker.kill = (...args) => { probe.kills++; return kill(...args); };
      worker.send = (...args) => { if (args[0]?.type === 'cancel') probe.cancelRequests++; return send(...args); };
      worker.once('exit', (code, signal) => { probe.workerExit = { code, signal }; });
      owned[0].once('exit', (code, signal) => {
        probe.sidecarExit = { code, signal };
        menu.getMenuItemById('library-cancel').click();
      });
      owned[0].send({ type: 'shutdown' });
    };
    menu.getMenuItemById('library-restore').click();
  }, { backup, destination });
  await until(() => application.evaluate(() => typeof globalThis.__maintenanceProbe.answer === 'function'));
  const before = await application.evaluate(({ BrowserWindow, Menu }) => {
    const probe = globalThis.__maintenanceProbe;
    return { messages: probe.messages, stoppedDuringRestore: probe.stoppedDuringRestore, sidecarExit: probe.sidecarExit, workerExit: probe.workerExit,
      kills: probe.kills, cancelRequests: probe.cancelRequests, sidecars: probe.sidecars().length, windows: BrowserWindow.getAllWindows().length,
      cancelEnabled: Menu.getApplicationMenu().getMenuItemById('library-cancel').enabled };
  });
  assert.equal(before.stoppedDuringRestore, true); assert.deepEqual(before.sidecarExit, { code: 0, signal: null });
  assert.deepEqual(before.workerExit, { code: 0, signal: null }); assert.equal(before.kills, 0); assert.equal(before.cancelRequests, 1);
  assert.equal(before.sidecars, 0); assert.equal(before.windows, 1); assert.equal(before.cancelEnabled, false);
  assert.equal(before.messages.filter(message => message.message === '本地服务已停止').length, 1);
  assert.ok(before.messages.some(message => message.message === '文库操作已取消'));
  assert.equal(existsSync(lock), false, 'The stopped sidecar released its lock; the fixture must never delete it.');
  assert.equal(snapshot(), original); await assert.rejects(fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }));
  await application.evaluate(() => globalThis.__maintenanceProbe.answer(0));
  await until(async () => {
    const state = await application.evaluate(({ BrowserWindow }) => ({ url: BrowserWindow.getAllWindows()[0].webContents.getURL(), pids: globalThis.__maintenanceProbe.sidecars().map(child => child.pid) }));
    if (state.pids.length !== 1 || state.pids[0] === await application.evaluate(() => globalThis.__maintenanceProbe.originalPid)) return false;
    return (await fetch(`${new URL(state.url).origin}/api/health`).catch(() => null))?.ok;
  });
  const current = new URL((await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL()))).origin;
  assert.equal((await (await fetch(`${current}/api/articles/${article.id}`)).json()).title, article.title);
  assert.equal(snapshot(), original); assert.equal(hash(await readFile(join(backup, 'shiye-backup.json'))), originalManifest);
  for (let seq = 1; seq <= 128; seq++) assert.deepEqual(await readFile(join(library, 'pictures/fixture', `${String(seq).padStart(3, '0')}.gif`)), image);
  const targets = await readdir(destination); assert.equal(targets.length, 1); assert.equal(existsSync(join(destination, targets[0], '.shiye-incomplete')), true);
  assert.equal(JSON.parse(await readFile(join(profile, 'library.json'), 'utf8')).root, library);
  const process = application.process(); await application.evaluate(({ app }) => app.quit());
  await until(() => process.exitCode !== null || process.signalCode !== null); assert.equal(process.exitCode, 0); assert.equal(process.signalCode, null);
  await until(() => !existsSync(lock)); await application.close().catch(() => {}); application = undefined;
  const report = { passed: true, fixture, fault: 'owned sidecar received shutdown during restore; code0 release, not an abrupt kill', before,
    checks: ['restore cancellation replays one deferred service recovery choice after maintenance', 'no automatic service restart or lock deletion',
      'explicit reopen restores the same library in one window with a new backend', 'source tables, 128 images, backup and library binding remain unchanged',
      'incomplete restore remains marked and final application exit releases the reopened service lock'] };
  await writeFile(join(evidence, 'desktop-maintenance-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) {
  const diagnostics = application && await application.evaluate(() => { const probe = globalThis.__maintenanceProbe; return probe && {
    messages: probe.messages, stoppedDuringRestore: probe.stoppedDuringRestore, sidecarExit: probe.sidecarExit, workerExit: probe.workerExit,
    kills: probe.kills, cancelRequests: probe.cancelRequests, sidecars: probe.sidecars().map(child => child.pid) }; }).catch(() => null);
  await writeFile(join(evidence, 'desktop-maintenance-failure.json'), JSON.stringify({ message: error.message, diagnostics }, null, 2)); throw error;
} finally {
  if (application) { await application.evaluate(({ app }) => app.quit()).catch(() => {}); await application.close().catch(() => {}); }
}
