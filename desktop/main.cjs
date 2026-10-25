const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, session, shell, screen } = require('electron');
const { fork } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { existsSync, lstatSync } = require('node:fs');
const { isAbsolute, join, resolve } = require('node:path');
const { argument, libraryPaths, existingLibrary, readLibraryRoot, saveLibraryRoot, readWindowState, saveWindowState, externalLink, mainPage } = require('./config.cjs');

const userData = argument(process.argv, 'user-data-dir');
if (userData) app.setPath('userData', resolve(userData));
app.setName('拾页');
let window, tray, child, paths, origin, backend, node, configPath, recoverRenderer, cancelWork, quitting = false, maintenance = false, recovering = false, exitAfterMaintenance = false, exitPrompt = false;
const libraryMenus = [];
function updateCancelMenu(enabled = Boolean(cancelWork)) {
  for (const menu of libraryMenus) menu.getMenuItemById('library-cancel').enabled = enabled;
}
const show = () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); } };
function openFolder(path) {
  try { if (typeof path === 'string' && isAbsolute(path) && lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()) void shell.openPath(path); } catch { /* A missing folder is not an executable or an external URL. */ }
}
async function stopService(owned = child) {
  if (!owned) return;
  if (owned.exitCode !== null || owned.signalCode !== null) { if (child === owned) child = undefined; return; }
  await new Promise(done => {
    const timer = setTimeout(() => owned.kill(), 15000);
    const stopped = () => { clearTimeout(timer); owned.removeListener('exit', stopped); owned.removeListener('close', stopped); done(); };
    owned.once('exit', stopped); owned.once('close', stopped);
    try { if (owned.connected) owned.send({ type: 'shutdown' }, error => { if (error) owned.kill(); }); else owned.kill(); }
    catch { owned.kill(); }
  });
  if (child === owned) child = undefined;
}
const ownsService = () => child && child.exitCode === null && child.signalCode === null;
function recoverPending() {
  if (quitting || maintenance || recovering || exitPrompt) return;
  if (child && (child.exitCode !== null || child.signalCode !== null)) void recoverService(child);
  else void recoverRenderer?.();
}
async function requireIdle() {
  const response = await fetch(`${origin}/api/summary`, { signal: AbortSignal.timeout(3000) });
  if (!response.ok || (await response.json()).activeJobs !== 0) throw new Error('请暂停进行中的任务后再操作文库。');
}
function libraryDisplay(title = '拾页', progress = -1) {
  if (window && !window.isDestroyed()) { window.setTitle(title); window.setProgressBar(progress); }
}
function libraryProgress(type, value) {
  const phases = { checking: '校验文件', database: '处理数据库', images: '复制图片', covers: '复制封面', publishing: '整理文库' };
  if (!value || Array.isArray(value) || Object.keys(value).length !== 3 || !Object.hasOwn(phases, value.phase) ||
    !Number.isSafeInteger(value.completed) || !Number.isSafeInteger(value.total) || value.completed < 0 || value.completed > value.total) return;
  libraryDisplay(`拾页 — ${type === 'backup' ? '备份' : '恢复'}：${phases[value.phase]}${value.total ? ` ${value.completed} / ${value.total}` : ''}`, value.total ? Math.min(0.99, value.completed / value.total) : 2);
}
function libraryWork(type, source, target) {
  return new Promise((done, reject) => {
    const worker = fork(join(backend, 'desktop/library.mjs'), [], { execPath: node, cwd: backend, env: { ...process.env }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let result, failure, cancelled = false, requested = false, active = true, terminal = false;
    const cancel = cancelWork = () => {
      if (!active || terminal || requested || !worker.connected) return;
      requested = true;
      updateCancelMenu(false);
      libraryDisplay('拾页 — 正在取消文库操作', 2);
      worker.send({ type: 'cancel' }, () => {});
    };
    updateCancelMenu();
    const clear = () => { active = false; if (cancelWork === cancel) { cancelWork = undefined; updateCancelMenu(); } };
    worker.stderr.on('data', () => {});
    worker.once('error', () => { clear(); reject(new Error('无法启动文库操作，请检查程序文件是否完整。')); });
    worker.on('message', message => {
      if (!active) return;
      if (message?.type === 'progress' && !terminal && !requested) libraryProgress(type, message.progress);
      if (message?.type === 'cancelled') { cancelled = true; terminal = true; }
      if (message?.type === 'error' && typeof message.message === 'string') { failure = message.message; terminal = true; }
      if (message?.type === 'result') {
        terminal = true;
        const value = message.result;
        if (value && value.directory === target && Number.isSafeInteger(value.images) && value.images >= 0 && Number.isSafeInteger(value.articles) && value.articles >= 0) result = value;
        else failure = '文库操作没有返回有效结果。';
      }
      if (terminal) updateCancelMenu(false);
    });
    worker.once('exit', code => {
      clear();
      if (code === 0 && result && !failure) done(result);
      else if (code === 0 && cancelled && !failure) reject(Object.assign(new Error('文库操作已取消，原文件已保留。'), { cancelled: true }));
      else reject(new Error(failure || '文库操作未完成，原文库保持不变。'));
    });
    worker.send({ type, source, target }, error => { if (error) { clear(); failure = '无法发送文库操作。'; worker.kill(); } });
  });
}
async function loadLibrary(root) {
  paths = libraryPaths(root);
  origin = await service(backend, node);
  await window.loadURL(`${origin}/#accounts`);
}
async function switchLibrary(root) {
  const original = paths.root;
  await requireIdle();
  await stopService();
  try {
    await loadLibrary(root);
    saveLibraryRoot(configPath, paths.root);
  } catch (error) {
    await stopService();
    await loadLibrary(original);
    saveLibraryRoot(configPath, original);
    throw error;
  }
}
async function libraryOperation(type) {
  if (maintenance || recovering || quitting || exitPrompt) return;
  maintenance = true;
  let completed;
  try {
    show();
    if (type === 'backup') {
      if (!ownsService()) throw new Error('当前文库由其他拾页服务管理，请退出该服务并重新打开拾页后再备份。');
      await requireIdle();
      const answer = await dialog.showMessageBox(window, { type: 'info', title: '备份文库', message: '备份期间将暂停本地服务，微信连接会断开。', detail: '完成后自动恢复当前文库；之后采集时需要重新连接微信。', buttons: ['选择备份位置', '取消'], defaultId: 0, cancelId: 1 });
      if (answer.response !== 0) return;
      const folder = await dialog.showOpenDialog(window, { title: '选择备份存放位置', properties: ['openDirectory'] });
      if (folder.canceled || !folder.filePaths[0]) return;
      const target = join(folder.filePaths[0], `拾页备份-${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/[ :]/g, '-')}-${randomUUID().slice(0, 8)}`);
      await requireIdle();
      const original = paths.root;
      libraryDisplay('拾页 — 正在准备备份', 2);
      await stopService();
      try { completed = await libraryWork('backup', original, target); }
      finally { if (!exitAfterMaintenance) { libraryDisplay('拾页 — 正在打开文库', 2); await loadLibrary(original); } }
      libraryDisplay();
      if (exitAfterMaintenance) return;
      await dialog.showMessageBox(window, { type: 'info', title: '备份文库', message: '文库备份已完成', detail: completed.directory, buttons: ['确定'] });
    } else if (type === 'restore') {
      const source = await dialog.showOpenDialog(window, { title: '选择文库备份', properties: ['openDirectory'] });
      if (source.canceled || !source.filePaths[0]) return;
      const folder = await dialog.showOpenDialog(window, { title: '选择新文库存放位置', properties: ['openDirectory'] });
      if (folder.canceled || !folder.filePaths[0]) return;
      const target = join(folder.filePaths[0], `拾页文库-${new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(/[ :]/g, '-')}-${randomUUID().slice(0, 8)}`);
      const answer = await dialog.showMessageBox(window, { type: 'question', title: '恢复文库', message: '将备份恢复到新的文库文件夹？', detail: `${target}\n当前文库和已有文件不会被覆盖。`, buttons: ['恢复到新文库', '取消'], defaultId: 0, cancelId: 1 });
      if (answer.response !== 0) return;
      libraryDisplay('拾页 — 正在准备恢复', 2);
      completed = await libraryWork('restore', source.filePaths[0], target);
      libraryDisplay();
      if (exitAfterMaintenance) return;
      const open = await dialog.showMessageBox(window, { type: 'info', title: '恢复文库', message: '文库恢复已完成', detail: `${completed.directory}\n打开新文库会断开当前微信连接，任务不会自动继续。`, buttons: ['打开新文库', '暂不打开'], defaultId: 0, cancelId: 1 });
      if (open.response === 0) { libraryDisplay('拾页 — 正在打开文库', 2); await switchLibrary(completed.directory); }
    }
  } catch (error) {
    libraryDisplay();
    if (exitAfterMaintenance) return;
    try {
      await dialog.showMessageBox(window, { type: error?.cancelled ? 'info' : 'error', title: type === 'backup' ? '备份文库' : '恢复文库', message: error?.cancelled ? '文库操作已取消' : completed ? '文库文件已生成，但未能恢复服务或打开文库。' : '文库操作未完成', detail: `${error instanceof Error ? error.message : '请检查目录和程序文件后重试。'}${completed ? `\n${completed.directory}` : ''}`, buttons: ['确定'] });
    } catch { /* The app window may already have been destroyed. */ }
  } finally {
    libraryDisplay(); maintenance = false;
    if (exitAfterMaintenance) { exitAfterMaintenance = false; app.quit(); }
    else recoverPending();
  }
}
async function requestQuit(event) {
  if (quitting) return;
  event.preventDefault();
  if (maintenance) {
    if (exitPrompt) return;
    const cancel = cancelWork;
    if (!cancel) { void dialog.showMessageBox(window, { type: 'info', title: '拾页', message: '正在处理文库，请完成后再退出。' }).catch(() => {}); return; }
    exitPrompt = true;
    let answer;
    try {
      answer = await dialog.showMessageBox(window, { type: 'question', title: '退出拾页', message: '取消当前文库操作并退出？', detail: '会等待正在处理的文件安全结束，原文件保持不变。', buttons: ['取消操作并退出', '继续等待'], defaultId: 1, cancelId: 1 });
      if (answer.response !== 0) return;
      if (!maintenance) { app.quit(); return; }
      exitAfterMaintenance = true; cancel();
    } catch { /* Keep the worker running if its exit question cannot be displayed. */ }
    finally { exitPrompt = false; if (answer?.response !== 0) recoverPending(); }
    return;
  }
  quitting = true;
  await stopService().finally(() => { tray?.destroy(); app.quit(); });
}
async function recoverService(owned) {
  if (child !== owned || quitting || maintenance || recovering || exitPrompt) return;
  recovering = true;
  const root = paths.root;
  let current = owned, detail = '重新打开当前文库后，需要重新连接微信；任务不会自动继续。';
  try {
    show();
    while (!quitting && paths.root === root && child === current) {
      libraryDisplay();
      const answer = await dialog.showMessageBox(window, { type: 'error', title: '拾页', message: '本地服务已停止', detail,
        buttons: ['重新打开文库', '退出'], defaultId: 0, cancelId: 1 });
      if (quitting || paths.root !== root || child !== current) return;
      if (answer.response !== 0) { app.quit(); return; }
      try {
        await stopService(current);
        current = undefined;
        if (quitting) return;
        libraryDisplay('拾页 — 正在打开文库', 2);
        await loadLibrary(root);
        current = child;
        if (current && (current.exitCode !== null || current.signalCode !== null)) continue;
        return;
      } catch (error) {
        if (error?.reported) { app.quit(); return; }
        await stopService();
        current = child;
        detail = error instanceof Error ? error.message : '无法重新打开文库，请检查程序文件和文库位置。';
      }
    }
  } catch { if (!quitting) app.quit(); }
  finally { libraryDisplay(); recovering = false; void recoverRenderer?.(); }
}
function monitorRenderer(contents) {
  let state = 'ready', page = `${origin}/#accounts`;
  const remember = url => { if (mainPage(url, origin)) page = url; };
  contents.on('did-navigate', (_event, url) => remember(url));
  contents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) remember(url); });
  contents.on('did-finish-load', () => { state = 'ready'; });
  contents.on('responsive', () => { if (state === 'unresponsive') state = 'ready'; });
  const recover = async () => {
    if (state === 'ready' || contents !== window?.webContents || window.isDestroyed() || quitting || maintenance || recovering || exitPrompt) return;
    const owner = window, root = paths.root, serviceOrigin = origin, owned = child;
    const current = () => window === owner && !owner.isDestroyed() && paths.root === root && origin === serviceOrigin && child === owned && !quitting;
    const serviceGone = () => owned && (owned.exitCode !== null || owned.signalCode !== null);
    recovering = true;
    let failed = false;
    try {
      show();
      while (current()) {
        const waiting = !failed && state === 'unresponsive';
        const answer = await dialog.showMessageBox(owner, { type: 'warning', title: '拾页', message: failed ? '界面未能重新加载' : waiting ? '界面暂时没有响应' : '界面已停止',
          detail: '重新加载当前界面，后台任务会保留。', buttons: waiting ? ['重新加载界面', '继续等待', '退出'] : ['重新加载界面', '退出'], defaultId: 0, cancelId: 1 });
        if (!current()) return;
        if (answer.response === (waiting ? 2 : 1)) { app.quit(); return; }
        if (!failed && state === 'ready') return;
        if (waiting && answer.response === 1) {
          if (state !== 'unresponsive') continue;
          state = 'ready'; return;
        }
        if (serviceGone()) return;
        try {
          if (state === 'unresponsive') contents.forcefullyCrashRenderer();
          await owner.loadURL(mainPage(page, serviceOrigin) ? page : `${serviceOrigin}/#accounts`);
          if (state !== 'ready') continue;
          return;
        } catch { state = 'crashed'; failed = true; }
      }
    } catch { if (!quitting) app.quit(); }
    finally {
      recovering = false;
      // A service exit suppressed by this prompt still needs its own explicit recovery.
      if (current() && serviceGone()) void recoverService(owned);
    }
  };
  recoverRenderer = recover;
  contents.on('render-process-gone', () => { state = 'crashed'; void recover(); });
  contents.on('unresponsive', () => { if (state !== 'crashed') state = 'unresponsive'; void recover(); });
}
function secure(contents) {
  const openExternal = async url => {
    if (!externalLink(url)) return;
    try { await shell.openExternal(url); } catch {
      try { await dialog.showMessageBox(window, { type: 'error', title: '拾页', message: '无法打开系统浏览器，请稍后重试。' }); } catch { /* The window may have closed while opening the browser. */ }
    }
  };
  contents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: 'deny' };
  });
  const navigate = (event, url) => { if (!mainPage(url, origin)) { event.preventDefault(); void openExternal(url); } };
  contents.on('will-navigate', navigate);
  contents.on('will-redirect', navigate);
}
async function service(backend, node) {
  const guidance = {
    library_lock_stale: ['上次拾页没有正常退出', '请确认所有拾页程序和采集服务均已退出，再打开下方目录，只删除 .shiye-service.lock 文件，然后点击“重试”。不要删除数据库或图片。'],
    library_in_use: ['这份文库正在使用中', '请先退出正在使用这份文库的另一个拾页程序或采集服务，再点击“重试”。不要删除锁文件。'],
    library_lock_unknown: ['无法确认文库是否空闲', '锁文件无法识别或读取。请先退出其他拾页程序，保留锁文件、数据库和图片；确认文库未被使用后再重试。'],
    library_incomplete: ['这份文库尚未恢复完成', '请从完整备份重新恢复到新的文库。不要删除 .shiye-incomplete 标记，也不要直接打开其中的数据库。'],
  };
  for (;;) {
    try { return await startService(backend, node); }
    catch (error) {
      if (!Object.hasOwn(guidance, error?.code)) throw error;
      await stopService();
      const [message, detail] = guidance[error.code];
      const directory = error.code === 'library_incomplete' ? paths.root : paths.data;
      for (;;) {
        const options = { type: 'warning', title: '打开文库', message, detail: `${detail}\n\n${directory}`, buttons: ['打开文库目录', '重试', '退出'], defaultId: 1, cancelId: 2 };
        const answer = await (window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options));
        if (answer.response === 1) break;
        if (answer.response === 0) openFolder(directory);
        else throw Object.assign(new Error('文库尚未打开'), { reported: true });
      }
    }
  }
}
async function startService(backend, node) {
  try {
    const response = await fetch('http://127.0.0.1:4387/api/health', { signal: AbortSignal.timeout(1200) });
    if (response.ok && response.headers.get('X-Wechat-Archive') === '1') {
      const settings = await (await fetch('http://127.0.0.1:4387/api/settings', { signal: AbortSignal.timeout(1200) })).json();
      if (typeof settings.dataDirectory === 'string' && resolve(settings.dataDirectory).toLowerCase() === paths.data.toLowerCase()) { child = undefined; return 'http://127.0.0.1:4387'; }
    }
  } catch { /* An absent or unrelated service is not owned by this application. */ }
  if (!existsSync(node) || !existsSync(join(backend, 'dist/server/app.js'))) throw new Error('程序运行文件缺失，请重新解压完整应用文件夹');
  return new Promise((done, reject) => {
    const owned = child = fork(join(backend, 'desktop/service.mjs'), [], { execPath: node, cwd: backend, env: { ...process.env, SHIYE_LIBRARY_ROOT: paths.root }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let ready = false, settled = false;
    owned.stderr.on('data', () => {});
    const fail = async error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      await stopService(owned); reject(error);
    };
    const timer = setTimeout(() => void fail(new Error('本地服务启动超时，请检查文库位置')), 20000);
    owned.once('error', () => { void fail(new Error('无法启动随包运行环境')); });
    owned.once('exit', () => {
      clearTimeout(timer);
      if (!ready) void fail(new Error('本地服务启动失败，请确认文库没有被其他进程占用'));
      else void recoverService(owned);
    });
    owned.on('message', message => {
      if (settled) return;
      if (message?.type === 'ready' && Number.isInteger(message.port) && message.port > 0 && message.port < 65536) {
        if (quitting) { void fail(new Error('拾页正在退出')); return; }
        settled = true; ready = true; clearTimeout(timer); done(`http://127.0.0.1:${message.port}`);
      }
      if (message?.type === 'error') void fail(Object.assign(new Error(message.message), { code: message.code }));
    });
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.on('activate', show);
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => { void requestQuit(event); });
  void app.whenReady().then(async () => {
    configPath = join(app.getPath('userData'), 'library.json');
    let remembered, configIssue;
    const explicit = argument(process.argv, 'library-root');
    try { remembered = readLibraryRoot(configPath); }
    catch (error) {
      configIssue = error;
      if (!explicit) {
        const answer = await dialog.showMessageBox({ type: 'warning', title: '打开文库', message: '无法打开已记住的文库', detail: `${error.message}\n原文库记录会保留，不会改用空文库。`, buttons: ['选择已有文库', '退出'], defaultId: 0, cancelId: 1 });
        if (answer.response !== 0) throw Object.assign(new Error('未选择文库'), { reported: true });
        const folder = await dialog.showOpenDialog({ title: '选择已有拾页文库', properties: ['openDirectory'] });
        if (folder.canceled || !folder.filePaths[0]) throw Object.assign(new Error('未选择文库'), { reported: true });
        remembered = existingLibrary(folder.filePaths[0]);
      }
    }
    paths = libraryPaths(explicit || remembered || (app.isPackaged ? join(app.getPath('userData'), 'library') : resolve(__dirname, '..')));
    backend = app.isPackaged ? join(process.resourcesPath, 'backend') : resolve(__dirname, '..');
    node = app.isPackaged ? join(process.resourcesPath, 'runtime/node.exe') : join(backend, 'data/desktop-verification/runtime/node.exe');
    origin = await service(backend, node);
    saveLibraryRoot(configPath, paths.root, configIssue);
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    session.defaultSession.on('will-download', event => event.preventDefault());
    const icon = nativeImage.createFromPath(join(backend, 'dist/client/brand/shiye-mark.png'));
    const windowFile = join(app.getPath('userData'), 'window.json');
    const primary = screen.getPrimaryDisplay(), workAreas = [primary.workArea, ...screen.getAllDisplays().filter(display => display.id !== primary.id).map(display => display.workArea)];
    const { maximized, ...bounds } = readWindowState(windowFile, workAreas);
    window = new BrowserWindow({ title: '拾页', ...bounds, icon, autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    if (maximized) window.maximize();
    secure(window.webContents);
    monitorRenderer(window.webContents);
    window.on('close', event => { saveWindowState(windowFile, window.getNormalBounds(), window.isMaximized()); if (!quitting) { event.preventDefault(); if (maintenance) show(); else window.hide(); } });
    tray = new Tray(icon.resize({ width: 32, height: 32 })); tray.setToolTip('拾页');
    const libraryMenu = () => [{ id: 'library-backup', label: '备份文库…', click: () => void libraryOperation('backup') }, { id: 'library-restore', label: '恢复文库…', click: () => void libraryOperation('restore') }, { id: 'library-cancel', label: '取消文库操作', enabled: false, click: () => cancelWork?.() }];
    const trayMenu = Menu.buildFromTemplate([{ label: '打开拾页', click: show }, { label: '打开图片文件夹', click: async () => { const response = await fetch(`${origin}/api/settings`).catch(() => null); const settings = await response?.json().catch(() => null); openFolder(settings?.imageDirectory); } }, { label: '打开文库文件夹', click: () => openFolder(paths.root) }, ...libraryMenu(), { type: 'separator' }, { label: '退出拾页', click: () => app.quit() }]);
    libraryMenus.push(trayMenu); tray.setContextMenu(trayMenu);
    tray.on('click', show); tray.on('double-click', show);
    const appMenu = Menu.buildFromTemplate([{ label: '拾页', submenu: [{ label: '显示窗口', click: show }, ...libraryMenu(), { type: 'separator' }, { label: '退出拾页', role: 'quit' }] }, { label: '编辑', submenu: [{ role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }]);
    libraryMenus.push(appMenu); Menu.setApplicationMenu(appMenu);
    await window.loadURL(`${origin}/#accounts`);
  }).catch(async error => { await stopService(); if (!error?.reported) dialog.showErrorBox('拾页无法启动', error instanceof Error ? error.message : '请重新打开应用'); app.quit(); });
}
