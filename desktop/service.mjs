import { resolve } from 'node:path';
import { createApp } from '../dist/server/app.js';
import { acquireLibraryLock, LibraryStartupError } from '../dist/server/startup.js';

let app, release, closing = false, closed;
const connections = new Map();
function close() {
  closing = true;
  return closed ||= (async () => {
    await initialized.catch(() => {});
    try {
      const completion = app?.close();
      for (const [socket, active] of connections) if (!active) socket.destroy();
      await completion;
    } finally {
      await release?.();
      if (process.connected) process.disconnect();
    }
  })();
}
const shutdown = () => { void close().catch(() => { process.exitCode = 1; }); };
process.on('message', message => { if (message?.type === 'shutdown') shutdown(); });
process.on('disconnect', shutdown);
const initialized = (async () => {
  const dataDir = resolve(process.env.SHIYE_LIBRARY_ROOT, 'data');
  const recoverClaim = process.argv?.find(value => value.startsWith('--recover-lock='))?.slice('--recover-lock='.length);
  release = await acquireLibraryLock(dataDir, { recoverClaim });
  if (closing) return;
  app = await createApp({ dataDir, defaultImageDirectory: resolve(process.env.SHIYE_LIBRARY_ROOT, 'pictures'), staticDir: resolve('dist/client') });
  app.server.on('connection', socket => {
    connections.set(socket, 0);
    socket.once('close', () => connections.delete(socket));
    if (closing) socket.destroy();
  });
  app.server.prependListener('request', (request, response) => {
    const socket = request.socket;
    connections.set(socket, (connections.get(socket) || 0) + 1);
    let finished = false;
    const idle = () => {
      if (finished) return;
      finished = true;
      const active = Math.max(0, (connections.get(socket) || 1) - 1);
      if (!socket.destroyed) connections.set(socket, active);
      // Partial headers and newly idle keep-alive sockets otherwise delay server.close().
      if (closing && !active) socket.destroy();
    };
    response.once('finish', idle); response.once('close', idle);
  });
  if (closing) return;
  await app.listen({ host: '127.0.0.1', port: 0 });
  if (!closing && process.connected) process.send({ type: 'ready', port: app.server.address().port }, () => {});
})();
try { await initialized; }
catch (error) {
  if (!closing) {
    if (process.connected) process.send({ type: 'error', ...(error instanceof LibraryStartupError ? { code: error.code, message: error.message, ...(error.recoveryClaim ? { recoveryClaim: error.recoveryClaim } : {}) } : { message: '本地服务无法启动，请检查文库位置或程序文件是否完整' }) }, () => {});
    process.exitCode = 1;
  }
  await close();
}
