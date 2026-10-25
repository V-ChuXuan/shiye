import { backupLibrary, restoreLibrary, LibraryBackupError } from '../dist/server/library-backup.js';

if (!process.connected || !process.send) process.exit(1);
const controller = new AbortController();
let running = false;
const disconnected = () => { controller.abort(); process.exitCode = 1; if (!running) process.exit(1); };
process.once('disconnect', disconnected);
process.on('message', message => { if (running && message?.type === 'cancel') controller.abort(); });
process.once('message', async message => {
  running = true;
  try {
    if (!message || !['backup', 'restore'].includes(message.type) || typeof message.source !== 'string' || typeof message.target !== 'string') throw new LibraryBackupError('文库操作参数无效');
    const onProgress = progress => { if (process.connected && !controller.signal.aborted) process.send?.({ type: 'progress', progress }, () => {}); };
    const result = await (message.type === 'backup' ? backupLibrary(message.source, message.target, controller.signal, onProgress) : restoreLibrary(message.source, message.target, controller.signal, onProgress));
    if (!process.connected) return;
    process.send?.({ type: 'result', result }, () => { process.removeListener('disconnect', disconnected); process.disconnect?.(); });
  } catch (error) {
    if (!process.connected) return;
    if (error?.name === 'AbortError') {
      process.send?.({ type: 'cancelled' }, () => { process.removeListener('disconnect', disconnected); process.disconnect?.(); });
      return;
    }
    process.send?.({ type: 'error', message: error instanceof LibraryBackupError ? error.message : '文库操作未完成，原文件已保留；请检查备份完整性、目标目录及其他拾页进程。' }, () => { process.removeListener('disconnect', disconnected); process.exitCode = 1; process.disconnect?.(); });
  }
});
