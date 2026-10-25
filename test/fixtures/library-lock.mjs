import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { acquireLibraryLock } from '../../server/startup.ts';

let release;
process.on('message', async message => {
  if (message.type === 'release') {
    await release?.();
    process.disconnect();
  }
  if (message.type !== 'start') return;
  if (message.pause) {
    const method = message.pause === 'publish' ? 'link' : 'rename', original = fs.promises[method];
    fs.promises[method] = async (...args) => {
      if (message.pause === 'archive') await original(...args);
      process.send({ type: 'paused', method, path: args[0] });
      await new Promise(done => process.once('message', done));
      if (message.pause === 'publish') return original(...args);
    };
    syncBuiltinESMExports();
  }
  try {
    release = await acquireLibraryLock(message.data, { recoverClaim: message.recoverClaim });
    process.send({ type: 'acquired' });
  } catch (error) {
    process.send({ type: 'error', code: error.code, recoveryClaim: error.recoveryClaim, message: error.message });
    process.disconnect();
  }
});
process.send({ type: 'prepared' });
