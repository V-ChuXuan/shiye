// Uses the actual portable application and disposable libraries; no source requests.
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
const evidence = resolve('data/safe-cancel-verification'); await mkdir(evidence, { recursive: true });
const packaged = JSON.parse(await readFile('data/desktop-verification/package-result.json', 'utf8'));
assert.equal(packaged.passed, true); assert.ok(existsSync(packaged.executable));
const fixture = await mkdtemp(join(evidence, 'desktop-cancel-')), library = join(fixture, '中文文库 空格'), profile = join(fixture, 'profile');
const backupSource = join(fixture, '完整备份'), image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const hash = value => createHash('sha256').update(value).digest('hex');
await mkdir(join(library, 'pictures/fixture'), { recursive: true });
const store = new Store(join(library, 'data')), account = store.upsertAccount('CancelSmoke==', '离线取消验收号');
const article = store.upsertArticle({ accountId: account.id, biz: account.biz, title: '原件应保持完整', url: 'https://mp.weixin.qq.com/s/cancel-fixture',
  status: 'complete', imageCount: 128, blocks: [{ type: 'text', text: '取消文库操作不会改动这篇文章。' }] });
for (let seq = 1; seq <= 128; seq++) {
  const file = `fixture/${String(seq).padStart(3, '0')}.gif`; await writeFile(join(library, 'pictures', file), image);
  store.saveAsset(article.id, { seq, src: `https://mmbiz.qpic.cn/cancel/${seq}/0`, status: 'complete', file,
    storageDirectory: join(library, 'pictures'), mime: 'image/gif', bytes: image.length, sha256: hash(image) });
}
store.close(); await backupLibrary(library, backupSource);
const snapshot = () => {
  const database = new Database(join(library, 'data/archive.sqlite'), { readonly: true });
  try { return JSON.stringify(['accounts', 'articles', 'assets', 'jobs'].map(table => database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())); }
  finally { database.close(); }
};
const original = snapshot(), manifest = hash(await readFile(join(backupSource, 'shiye-backup.json'))), checks = [], runs = [];
const lock = join(library, 'data/.shiye-service.lock');
async function until(check) {
  for (let attempt = 0; attempt < 150; attempt++) { if (await check()) return; await new Promise(done => setTimeout(done, 100)); }
  assert.fail('Portable cancellation did not reach the expected state.');
}
let application, normalBounds;
function sameBounds(actual, expected) {
  // Windows at fractional DPI quantizes the native frame once when recreating it.
  assert.equal(actual.x, expected.x); assert.equal(actual.y, expected.y);
  for (const key of ['width', 'height']) assert.ok(Math.abs(actual[key] - expected[key]) <= 8, `${key}: ${actual[key]} != ${expected[key]}`);
}
try {
  for (const [index, mode] of ['backup', 'restore', 'exit'].entries()) {
    const destination = join(fixture, `${mode}-destination`); await mkdir(destination);
    application = await electron.launch({ executablePath: packaged.executable,
      args: [`--library-root=${library}`, `--user-data-dir=${profile}`], timeout: 30000 });
    const page = await application.firstWindow(); await page.getByRole('heading', { name: '公众号', exact: true }).waitFor();
    const origin = new URL(page.url()).origin;
    const windowState = await application.evaluate(({ BrowserWindow, Menu }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { bounds: window.getNormalBounds(), maximized: window.isMaximized(), cancelEnabled: Menu.getApplicationMenu().getMenuItemById('library-cancel').enabled };
    });
    assert.equal(windowState.cancelEnabled, false);
    if (index) { sameBounds(windowState.bounds, normalBounds); assert.equal(windowState.maximized, index === 2); }
    await application.evaluate(({ BrowserWindow, Menu, dialog, app, session }, options) => {
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: new URL(details.url).hostname !== '127.0.0.1' }));
      const window = BrowserWindow.getAllWindows()[0], title = window.setTitle.bind(window), menu = Menu.getApplicationMenu();
      const choices = options.mode === 'restore' ? [options.backupSource, options.destination] : [options.destination];
      const probe = globalThis.__cancelProbe = { messages: [], triggered: false, sent: [], workerExit: null, kills: 0, enabledAtCancel: false };
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [choices.shift()] });
      dialog.showMessageBox = async (...args) => { const value = args.at(-1); probe.messages.push(value); return { response: value.message === '文库恢复已完成' ? 1 : 0 }; };
      window.setTitle = value => {
        title(value);
        if (probe.triggered || !value.includes('复制图片 0 /')) return;
        probe.triggered = true;
        const worker = process._getActiveHandles().find(handle => handle.spawnargs?.some(arg => /[\\/]desktop[\\/]library\.mjs$/.test(arg)) && handle.exitCode === null);
        if (!worker) throw new Error('Missing actual library worker.');
        const send = worker.send.bind(worker), kill = worker.kill.bind(worker);
        worker.send = (...args) => { probe.sent.push(args[0]); return send(...args); };
        worker.kill = (...args) => { probe.kills++; return kill(...args); };
        worker.once('exit', (code, signal) => { probe.workerExit = { code, signal }; });
        probe.enabledAtCancel = menu.getMenuItemById('library-cancel').enabled;
        if (options.mode === 'exit') app.quit(); else menu.getMenuItemById('library-cancel').click();
      };
      menu.getMenuItemById(options.mode === 'restore' ? 'library-restore' : 'library-backup').click();
    }, { mode, destination, backupSource });
    if (mode === 'exit') {
      const process = application.process();
      await until(() => process.exitCode !== null || process.signalCode !== null);
      assert.equal(process.exitCode, 0); assert.equal(process.signalCode, null);
      await until(() => !existsSync(lock));
      await assert.rejects(fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) }));
    } else {
      await until(async () => application.evaluate(() => globalThis.__cancelProbe.messages.some(message => message.message === '文库操作已取消')));
      const report = await application.evaluate(({ Menu }) => ({ ...globalThis.__cancelProbe,
        enabledAfter: Menu.getApplicationMenu().getMenuItemById('library-cancel').enabled }));
      assert.equal(report.triggered, true); assert.equal(report.enabledAtCancel, true); assert.equal(report.enabledAfter, false);
      assert.equal(report.sent.filter(message => message.type === 'cancel').length, 1);
      assert.deepEqual(report.workerExit, { code: 0, signal: null }); assert.equal(report.kills, 0);
      const restoredOrigin = new URL(page.url()).origin;
      assert.equal((await fetch(`${restoredOrigin}/api/health`)).status, 200); runs.push({ mode, ...report });
      normalBounds = await application.evaluate(({ BrowserWindow, screen }, maximize) => {
        const window = BrowserWindow.getAllWindows()[0], area = screen.getPrimaryDisplay().workArea;
        if (window.isMaximized()) window.unmaximize();
        window.setBounds({ x: area.x + 20, y: area.y + 20, width: Math.min(1050, area.width - 40), height: Math.min(750, area.height - 40) });
        const normal = window.getNormalBounds(); if (maximize) window.maximize(); return normal;
      }, mode === 'restore');
      if (mode === 'restore') await until(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMaximized()));
      const process = application.process(); await application.evaluate(({ app }) => app.quit());
      await until(() => process.exitCode !== null || process.signalCode !== null);
      assert.equal(process.exitCode, 0); await until(() => !existsSync(lock));
    }
    await application.close().catch(() => {}); application = undefined;
    const targets = await readdir(destination); assert.equal(targets.length, 1);
    assert.equal(existsSync(join(destination, targets[0], '.shiye-incomplete')), true);
    assert.equal(snapshot(), original);
    for (let seq = 1; seq <= 128; seq++) assert.deepEqual(await readFile(join(library, 'pictures/fixture', `${String(seq).padStart(3, '0')}.gif`)), image);
    assert.equal(hash(await readFile(join(backupSource, 'shiye-backup.json'))), manifest);
    checks.push(`${mode}: actual native cancellation safely retains source data and incomplete output`);
  }
  const saved = JSON.parse(await readFile(join(profile, 'window.json'), 'utf8'));
  sameBounds(saved.bounds, normalBounds); assert.equal(saved.maximized, true);
  checks.push('normal window bounds and maximized state survive two portable restarts independently of library binding');
  assert.equal(JSON.parse(await readFile(join(profile, 'library.json'), 'utf8')).root, library);
  await writeFile(join(evidence, 'desktop-cancel-result.json'), JSON.stringify({ passed: true, fixture, checks, runs, window: saved }, null, 2));
  console.log(JSON.stringify({ passed: true, fixture, checks, window: saved }));
} catch (error) {
  const diagnostics = application && await application.evaluate(() => globalThis.__cancelProbe).catch(() => null);
  await writeFile(join(evidence, 'desktop-cancel-failure.json'), JSON.stringify({ message: error.message, diagnostics }, null, 2)); throw error;
} finally {
  if (application) { await application.evaluate(({ app }) => app.quit()).catch(() => {}); await application.close().catch(() => {}); }
}
