import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createApp } from './app.js';
import { acquireLibraryLock, isPortAvailable } from './startup.js';

const port = Number(process.env.PORT || 4387);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT必须为有效端口');
const address = `http://127.0.0.1:${port}`;
function openBrowser() {
  if (process.argv.includes('--open')) {
    if (process.platform === 'win32') {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Start-Process '${address}'`], { windowsHide: true, stdio: 'ignore' });
      child.on('error', () => console.log('请在浏览器打开上述本地地址'));
    } else {
      const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [address], { stdio: 'ignore' });
      child.on('error', () => console.log('请在浏览器打开上述本地地址'));
    }
  }
}

if (!await isPortAvailable(port)) {
  let existing = false;
  try {
    const response = await fetch(`${address}/api/health`, { signal: AbortSignal.timeout(1500) });
    existing = response.ok && response.headers.get('X-Wechat-Archive') === '1';
  } catch { /* An occupied port is not necessarily this application. */ }
  if (existing) { console.log(`拾页已在运行：${address}`); openBrowser(); }
  else { console.error('本地端口已被其他程序占用，请设置PORT后重试'); process.exitCode = 1; }
} else {
const dataDir = resolve(process.env.WECHAT_ARCHIVE_DATA || 'data');
const releaseLibrary = await acquireLibraryLock(dataDir);
const app = await createApp({ dataDir, defaultImageDirectory: process.env.WECHAT_ARCHIVE_DATA ? join(dataDir, 'pictures') : resolve('pictures') }).catch(async error => { await releaseLibrary(); throw error; });
app.addHook('onClose', releaseLibrary);
try {
  await app.listen({ host: '127.0.0.1', port });
  console.log(`拾页已启动：${address}`);
  openBrowser();
} catch {
  console.error('本地服务启动失败，请检查端口占用和数据目录权限');
  await app.close(); process.exitCode = 1;
}
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => {
  if (closing) return; closing = true;
  void app.close().then(() => { process.exitCode = 0; });
});
}
