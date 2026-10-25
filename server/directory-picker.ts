import { execFile } from 'node:child_process';
import { resolve } from 'node:path';

export function chooseWindowsDirectory(initialDirectory: string, signal?: AbortSignal): Promise<string | null> {
  return new Promise((done, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-File', resolve('scripts/choose-directory.ps1'), '-InitialDirectory', initialDirectory],
      { windowsHide: true, timeout: 180_000, maxBuffer: 16 * 1024, signal }, (error, stdout) => {
        if (error) return reject(new Error('无法打开系统目录选择器，请直接填写路径'));
        try {
          const result = JSON.parse(stdout.trim()) as { path?: unknown };
          if (result.path === null) return done(null);
          if (typeof result.path !== 'string' || !result.path.trim()) throw new Error();
          done(result.path);
        } catch { reject(new Error('系统目录选择未完成，请直接填写路径')); }
      });
  });
}
