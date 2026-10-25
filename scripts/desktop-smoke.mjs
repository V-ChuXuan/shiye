// Runs the real portable application against disposable libraries, without WeChat.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { createApp } from '../dist/server/app.js';
import { Store } from '../dist/server/store.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const evidence = resolve('data/desktop-verification');
await mkdir(evidence, { recursive: true });
const report = JSON.parse(await readFile(join(evidence, 'package-result.json'), 'utf8'));
assert.equal(report.passed, true);
assert.ok(existsSync(report.executable));
const fixture = await mkdtemp(join(evidence, 'smoke-'));
const library = join(fixture, '文库 空格');
const userData = join(fixture, 'profile');
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
await mkdir(join(library, 'pictures/fixture'), { recursive: true });
await writeFile(join(library, 'pictures/fixture/image.gif'), image);
const store = new Store(join(library, 'data'));
const account = store.upsertAccount('desktop-fixture', '桌面离线验收号');
const article = store.upsertArticle({ accountId: account.id, biz: account.biz, title: '桌面离线验收文章',
  url: 'https://mp.weixin.qq.com/s/desktop-fixture', publishedAt: '2026-01-01', status: 'complete', imageCount: 1,
  blocks: [{ type: 'text', text: '桌面离线正文。' }, { type: 'image', seq: 1 }] });
store.saveAsset(article.id, { seq: 1, src: 'https://mmbiz.qpic.cn/desktop-fixture/0', status: 'complete',
  file: 'fixture/image.gif', storageDirectory: join(library, 'pictures'), mime: 'image/gif', bytes: image.length,
  sha256: createHash('sha256').update(image).digest('hex') });
store.close();
let application, external, port;
const checks = [];
const wait = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await wait(100);
  }
  assert.fail('Desktop lifecycle did not reach the expected state.');
}
try {
  application = await electron.launch({ executablePath: report.executable,
    args: [`--user-data-dir=${userData}`, `--library-root=${library}`], timeout: 30000 });
  const page = await application.firstWindow();
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' ? route.continue() : route.abort();
  });
  await page.getByRole('heading', { name: '公众号', exact: true }).waitFor();
  port = new URL(page.url()).origin;
  const settings = await (await fetch(`${port}/api/settings`)).json();
  assert.equal(resolve(settings.dataDirectory), join(library, 'data'));
  assert.equal(resolve(settings.imageDirectory), join(library, 'pictures'));
  assert.ok(existsSync(join(library, 'data/archive.sqlite')));
  assert.equal((await fetch(`${port}/api/health`)).headers.get('X-Wechat-Archive'), '1');
  const security = await application.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox };
  });
  assert.deepEqual(security, { nodeIntegration: false, contextIsolation: true, sandbox: true });
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  checks.push('packaged executable starts Unicode library with bundled Node and native SQLite', 'renderer sandbox and context isolation');
  await page.getByRole('button', { name: '文章目录', exact: true }).click();
  await page.getByRole('heading', { name: '文章目录', exact: true }).waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  checks.push('packaged frontend navigation and settings API');
  for (const [mode, top] of [['body', 4321], ['gallery', 123]]) {
    const saved = await fetch(`${port}/api/reading-positions/${article.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, top }) });
    assert.equal(saved.status, 200);
  }
  assert.deepEqual(await (await fetch(`${port}/api/reading-positions/${article.id}`)).json(), { body: 4321, gallery: 123 });
  await application.evaluate(({ shell, dialog }) => {
    const probe = globalThis.__desktopProbe = { calls: [], errors: [], unhandled: [], failNext: false };
    shell.openExternal = async url => { probe.calls.push(url); if (probe.failNext) { probe.failNext = false; throw new Error('fixture browser failure'); } };
    dialog.showMessageBox = async (_window, options) => { probe.errors.push(options); return { response: 0 }; };
    process.on('unhandledRejection', () => probe.unhandled.push('unhandled rejection'));
  });
  const assetUrl = `${port}/api/assets/${article.id}/1`;
  const assetResponse = await fetch(assetUrl);
  assert.equal(assetResponse.status, 200);
  assert.match(assetResponse.headers.get('content-type'), /^image\/gif/);
  const forbiddenUrls = [assetUrl, `${port}/api/settings`, 'file:///C:/Windows/win.ini', 'data:text/html,<h1>blocked</h1>',
    'javascript:window.__popupScriptRan=true', 'https://example.com/', 'https://mp.weixin.qq.com.evil/s/x',
    'https://user:pass@mp.weixin.qq.com/s/x', 'https://mp.weixin.qq.com:8443/s/x', 'https://mp.weixin.qq.com/mp/profile_ext',
    'https://github.com/other/repo', 'https://github.com/shadcn-ui/ui/issues', 'https://github.com/shadcn-ui/ui?next=evil'];
  for (const url of forbiddenUrls) await page.evaluate(url => { window.open(url); }, url);
  await wait(200);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  assert.deepEqual(await application.evaluate(() => globalThis.__desktopProbe.calls), []);
  assert.equal(await page.evaluate(() => window.__popupScriptRan), undefined);
  checks.push('valid local asset, API, file, data, script and non-allowlisted popups denied without shell calls');
  const settingsUrl = page.url();
  for (const url of [assetUrl, `${port}/api/settings`, `${port}/api/covers/${article.id}`, `${port}/unrecognized`,
    'file:///C:/Windows/win.ini', 'data:text/html,<h1>blocked</h1>', 'https://example.com/']) {
    await page.evaluate(url => { location.assign(url); }, url);
    await wait(100);
    assert.equal(page.url(), settingsUrl, `Top-level navigation escaped the UI: ${url}`);
    assert.equal(await page.evaluate(() => document.querySelector('h1')?.textContent), '设置');
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isLoadingMainFrame()), false);
  }
  assert.deepEqual(await application.evaluate(() => globalThis.__desktopProbe.calls), []);
  checks.push('same-origin assets, covers, settings and unknown paths cannot replace the main UI');
  // Playwright can retain a pending-navigation marker after Electron cancels it.
  await page.reload();
  await page.getByRole('button', { name: '阅读室', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(article.title) }).click();
  await page.getByRole('link', { name: '查看原文', exact: true }).click();
  await eventually(async () => (await application.evaluate(() => globalThis.__desktopProbe.calls)).length === 1);
  await page.getByRole('button', { name: '关于', exact: true }).click();
  await page.getByText('开源致谢', { exact: true }).click();
  const creditLinks = page.locator('.about-credits a');
  const credits = await creditLinks.evaluateAll(links => links.map(link => link.href));
  assert.deepEqual(credits, ['https://github.com/shadcn-ui/ui', 'https://github.com/lucide-icons/lucide', 'https://github.com/pmndrs/zustand',
    'https://github.com/motiondivision/motion', 'https://github.com/bvaughn/react-resizable-panels']);
  for (let index = 0; index < credits.length; index++) await creditLinks.nth(index).click();
  await eventually(async () => (await application.evaluate(() => globalThis.__desktopProbe.calls)).length === 6);
  assert.deepEqual(await application.evaluate(() => globalThis.__desktopProbe.calls), [article.url, ...credits]);
  const aboutUrl = page.url();
  await page.evaluate(url => { location.assign(url); }, article.url);
  await eventually(async () => (await application.evaluate(() => globalThis.__desktopProbe.calls)).length === 7);
  assert.equal(page.url(), aboutUrl);
  await page.reload();
  await page.getByText('开源致谢', { exact: true }).click();
  await application.evaluate(() => { globalThis.__desktopProbe.failNext = true; });
  await creditLinks.first().click();
  await eventually(async () => (await application.evaluate(() => globalThis.__desktopProbe.errors)).length === 1);
  await wait(100);
  assert.deepEqual(await application.evaluate(() => globalThis.__desktopProbe.calls), [article.url, ...credits, article.url, credits[0]]);
  const browserErrors = await application.evaluate(() => globalThis.__desktopProbe.errors);
  assert.equal(browserErrors[0].type, 'error');
  assert.match(browserErrors[0].message, /无法打开系统浏览器/);
  assert.deepEqual(await application.evaluate(() => globalThis.__desktopProbe.unhandled), []);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  checks.push('actual original and all five credit links reach stubbed system browser only; browser failure is visible without unhandled rejection');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false);
  await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items[0].submenu.items[0].click());
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
  checks.push('window close keeps tray service alive and menu restores window');
  const duplicate = spawn(report.executable, [`--user-data-dir=${userData}`, `--library-root=${library}`], { windowsHide: true, stdio: 'ignore' });
  const duplicateExit = await new Promise((done, reject) => {
    const timer = setTimeout(() => { duplicate.kill(); reject(new Error('Duplicate desktop did not exit')); }, 10000);
    duplicate.once('error', reject);
    duplicate.once('exit', code => { clearTimeout(timer); done(code); });
  });
  assert.equal(duplicateExit, 0);
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  checks.push('second launch exits without duplicate window or backend');
  await page.screenshot({ path: join(evidence, 'desktop-settings.png') });
  const closed = application.waitForEvent('close');
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 10); });
  await closed; application = null;
  await eventually(async () => !existsSync(join(library, 'data/.shiye-service.lock')));
  await assert.rejects(fetch(`${port}/api/health`, { signal: AbortSignal.timeout(1000) }));
  checks.push('explicit quit releases owned service, port and library lock');
  application = await electron.launch({ executablePath: report.executable,
    args: [`--user-data-dir=${userData}`], timeout: 30000 });
  const reopened = await application.firstWindow();
  await reopened.getByRole('heading', { name: '公众号', exact: true }).waitFor();
  const remembered = await (await fetch(`${new URL(reopened.url()).origin}/api/settings`)).json();
  assert.equal(resolve(remembered.dataDirectory), join(library, 'data'));
  checks.push('restart remembers selected library');
  assert.deepEqual(await (await fetch(`${new URL(reopened.url()).origin}/api/reading-positions/${article.id}`)).json(), { body: 4321, gallery: 123 });
  checks.push('body and gallery reading positions persist within the library across desktop service restarts and random origins');
  const finished = application.waitForEvent('close');
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 10); });
  await finished; application = null;
  // Bootstrap only the native choices before loading the packaged main; its sidecar and config code stay real.
  const resources = join(dirname(report.executable), 'resources'), packagedMain = join(resources, 'app.asar/desktop/main.cjs');
  for (const recovery of ['quit', 'cancel-picker', 'select']) {
    const profile = join(fixture, `config-${recovery}`), configFile = join(profile, 'library.json');
    const recoveryReport = join(fixture, `config-${recovery}.json`), bootstrap = join(fixture, `config-${recovery}.cjs`);
    const damaged = '{ damaged binding 中文';
    await mkdir(profile, { recursive: true }); await writeFile(configFile, damaged);
    await writeFile(bootstrap, `const electron=require('electron'),fs=require('node:fs');
Object.defineProperty(electron.app,'isPackaged',{value:true});Object.defineProperty(process,'resourcesPath',{value:${JSON.stringify(resources)}});
const report={messages:[],pickers:[],errors:[],opened:null};const save=()=>fs.writeFileSync(${JSON.stringify(recoveryReport)},JSON.stringify(report));
electron.dialog.showMessageBox=async(...args)=>{report.messages.push(args.at(-1));save();return {response:${recovery === 'quit' ? 1 : 0}}};
electron.dialog.showOpenDialog=async(...args)=>{report.pickers.push(args.at(-1));save();return {canceled:${recovery !== 'select'},filePaths:${JSON.stringify(recovery === 'select' ? [library] : [])}}};
electron.dialog.showErrorBox=(title,message)=>{report.errors.push({title,message});save()};
electron.app.on('browser-window-created',(_event,window)=>window.webContents.once('did-finish-load',async()=>{try{report.opened=await(await fetch(new URL('/api/settings',window.webContents.getURL()))).json();save()}finally{electron.app.quit()}}));
require(${JSON.stringify(packagedMain)});`);
    const recoveryProcess = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [bootstrap, `--user-data-dir=${profile}`], { windowsHide: true, stdio: 'ignore' });
    await new Promise((done, reject) => {
      const timer = setTimeout(() => { recoveryProcess.kill(); reject(new Error('Config recovery did not exit')); }, 30000);
      recoveryProcess.once('error', reject);
      recoveryProcess.once('exit', code => { clearTimeout(timer); assert.equal(code, 0); done(); });
    });
    const result = JSON.parse(await readFile(recoveryReport, 'utf8'));
    assert.deepEqual(result.messages[0].buttons, ['选择已有文库', '退出']); assert.deepEqual(result.errors, []);
    assert.equal(result.pickers.length, recovery === 'quit' ? 0 : 1);
    assert.equal(existsSync(join(profile, 'library')), false, 'Recovery must never silently create a default library.');
    const backups = (await readdir(profile)).filter(file => file.startsWith('library.json.invalid-'));
    if (recovery === 'select') {
      assert.equal(resolve(result.opened.dataDirectory), join(library, 'data'));
      assert.equal(JSON.parse(await readFile(configFile, 'utf8')).root, library);
      assert.equal(backups.length, 1); assert.equal(await readFile(join(profile, backups[0]), 'utf8'), damaged);
      await eventually(async () => !existsSync(join(library, 'data/.shiye-service.lock')));
    } else {
      assert.equal(result.opened, null); assert.equal(await readFile(configFile, 'utf8'), damaged); assert.equal(backups.length, 0);
    }
  }
  checks.push('packaged main and bundled sidecar recover damaged binding only after explicit existing-library choice; quit and picker cancellation preserve bytes without creating a default library');
  const reuseLibrary = join(fixture, 'existing-library');
  const forbidden = async () => { throw new Error('Desktop fixtures cannot request WeChat.'); };
  external = await createApp({ dataDir: join(reuseLibrary, 'data'), defaultImageDirectory: join(reuseLibrary, 'pictures'), schedulerEnabled: false,
    source: { fetchArticle: forbidden, fetchImage: forbidden, fetchCover: forbidden, captureSession: forbidden, discoverPage: forbidden, hasSession: () => false, getGate: () => null, clearGate: () => {} } });
  await external.listen({ host: '127.0.0.1', port: 4387 });
  application = await electron.launch({ executablePath: report.executable,
    args: [`--user-data-dir=${join(fixture, 'reuse-profile')}`, `--library-root=${reuseLibrary}`], timeout: 30000 });
  const reused = await application.firstWindow();
  await reused.getByRole('heading', { name: '公众号', exact: true }).waitFor();
  assert.equal(new URL(reused.url()).origin, 'http://127.0.0.1:4387');
  const reuseClosed = application.waitForEvent('close');
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 10); });
  await reuseClosed; application = null;
  assert.equal((await fetch('http://127.0.0.1:4387/api/health')).ok, true);
  checks.push('matching existing service reused and remains alive after desktop quit');
  await external.close(); external = null;
  for (const missing of ['runtime/node.exe', 'dist/server/app.js']) {
    const failureFile = join(fixture, `${missing.startsWith('runtime') ? 'runtime' : 'backend'}-failure.json`);
    const bootstrap = join(fixture, 'failure.cjs');
    await writeFile(bootstrap, `const electron=require('electron'),fs=require('node:fs');const original=fs.existsSync;fs.existsSync=function(p){return String(p).replaceAll('\\\\','/').endsWith(${JSON.stringify(missing)})?false:original(p)};electron.dialog.showErrorBox=(title,message)=>fs.writeFileSync(${JSON.stringify(failureFile)},JSON.stringify({title,message}));require(${JSON.stringify(join(root, 'desktop/main.cjs'))});`);
    const failure = spawn(join(root, 'node_modules/electron/dist/electron.exe'),
      [bootstrap, `--user-data-dir=${join(fixture, `failure-${missing.startsWith('runtime')}`)}`, `--library-root=${join(fixture, 'missing-library')}`], { windowsHide: true, stdio: 'ignore' });
    await new Promise((done, reject) => {
      const timer = setTimeout(() => { failure.kill(); reject(new Error('Failed startup did not exit')); }, 15000);
      failure.once('error', reject);
      failure.once('exit', code => { clearTimeout(timer); assert.equal(code, 0); done(); });
    });
    const message = JSON.parse(await readFile(failureFile, 'utf8'));
    assert.match(message.message, /运行文件缺失/);
  }
  checks.push('missing runtime and backend surface safe startup error and exit');
  const dead = spawn(process.execPath, ['-e', ''], { windowsHide: true, stdio: 'ignore' });
  await new Promise((done, reject) => { dead.once('error', reject); dead.once('exit', done); });
  for (const kind of ['stale', 'live', 'unknown', 'incomplete']) {
    const recoveryLibrary = join(fixture, `recovery-${kind}`), recoveryData = join(recoveryLibrary, 'data');
    await mkdir(recoveryData, { recursive: true });
    const untouched = Buffer.from(`Database must not be opened for ${kind}`);
    await writeFile(join(recoveryData, 'archive.sqlite'), untouched);
    const lock = kind === 'unknown' ? 'unrecognized lock' : JSON.stringify({ pid: kind === 'live' ? process.pid : dead.pid, id: 'fixture' });
    await writeFile(join(recoveryData, '.shiye-service.lock'), lock);
    if (kind === 'incomplete') await writeFile(join(recoveryLibrary, '.shiye-incomplete'), 'restoring');
    const recoveryFile = join(fixture, `${kind}-guidance.json`), bootstrap = join(fixture, `guidance-${kind}.cjs`);
    await writeFile(bootstrap, `const electron=require('electron'),fs=require('node:fs');const report={messages:[],folders:[],errors:[]},responses=${JSON.stringify(kind === 'stale' ? [1, 2] : [2])};const save=()=>fs.writeFileSync(${JSON.stringify(recoveryFile)},JSON.stringify(report));electron.dialog.showMessageBox=async(...args)=>{report.messages.push(args.at(-1));save();return {response:responses.shift()??2}};electron.shell.openPath=async path=>{report.folders.push(path);save();return ''};electron.dialog.showErrorBox=(title,message)=>{report.errors.push({title,message});save()};require(${JSON.stringify(join(root, 'desktop/main.cjs'))});`);
    const recovery = spawn(join(root, 'node_modules/electron/dist/electron.exe'), [bootstrap,
      `--user-data-dir=${join(fixture, `guidance-profile-${kind}`)}`, `--library-root=${recoveryLibrary}`], { windowsHide: true, stdio: 'ignore' });
    await new Promise((done, reject) => {
      const timer = setTimeout(() => { recovery.kill(); reject(new Error('Recovery guidance did not exit')); }, 20000);
      recovery.once('error', reject);
      recovery.once('exit', code => { clearTimeout(timer); assert.equal(code, 0); done(); });
    });
    const guidance = JSON.parse(await readFile(recoveryFile, 'utf8'));
    assert.equal(guidance.messages.length, kind === 'stale' ? 2 : 1);
    assert.deepEqual(guidance.errors, [], 'Handled recovery exits without a second generic failure box.');
    assert.deepEqual(guidance.messages[0].buttons, kind === 'stale' ? ['恢复并打开', '打开文库目录', '退出'] : ['打开文库目录', '重试', '退出']);
    assert.deepEqual(guidance.folders, kind === 'stale' ? [recoveryData] : []);
    assert.deepEqual(await readFile(join(recoveryData, 'archive.sqlite')), untouched);
    assert.equal(await readFile(join(recoveryData, '.shiye-service.lock'), 'utf8'), lock);
    if (kind === 'stale') assert.match(guidance.messages[0].message, /没有正常退出/);
    if (kind === 'live') assert.match(guidance.messages[0].message, /正在使用/);
    if (kind === 'unknown') assert.match(guidance.messages[0].message, /无法确认/);
    if (kind === 'incomplete') {
      assert.match(guidance.messages[0].message, /尚未恢复完成/);
      assert.equal(await readFile(join(recoveryLibrary, '.shiye-incomplete'), 'utf8'), 'restoring');
    }
  }
  checks.push('real sidecar typed startup guidance handles stale, live, unknown and incomplete libraries; opening the bound folder and exiting preserve lock and database');
  await writeFile(join(evidence, 'desktop-result.json'), JSON.stringify({ passed: true, checks, fixture, executable: report.executable }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} catch (error) {
  if (application) await application.windows()[0]?.screenshot({ path: join(evidence, 'desktop-failure.png') }).catch(() => {});
  throw error;
} finally {
  if (application) {
    await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 10); }).catch(() => {});
    await application.close().catch(() => {});
  }
  await external?.close();
}
