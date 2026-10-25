// Exercises only the portable application's own disposable sidecar; never a user service.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { _electron as electron } from 'playwright-core';
import { Store } from '../dist/server/store.js';

const evidence = resolve('data/image-jobs-verification');
await mkdir(evidence, { recursive: true });
const packaged = JSON.parse(await readFile('data/desktop-verification/package-result.json', 'utf8'));
assert.equal(packaged.passed, true);
const fixture = await mkdtemp(join(evidence, 'desktop-retry-'));
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const checks = [];
let application;
const wait = milliseconds => new Promise(done => setTimeout(done, milliseconds));
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await wait(100); }
  assert.fail('Portable recovery did not reach the expected state.');
}
try {
  for (const mode of ['retry', 'stale']) {
    const library = join(fixture, mode, '文库'), profile = join(fixture, mode, 'profile');
    await mkdir(join(library, 'pictures/fixture'), { recursive: true });
    const imagePath = join(library, 'pictures/fixture/image.gif');
    await writeFile(imagePath, image);
    const store = new Store(join(library, 'data'));
    const account = store.upsertAccount(`recovery-${mode}`, '恢复验收公众号');
    const article = store.upsertArticle({ accountId: account.id, biz: account.biz, title: '恢复验收文章',
      url: `https://mp.weixin.qq.com/s/recovery-${mode}`, publishedAt: '2026-01-01', status: 'complete', imageCount: 1,
      blocks: [{ type: 'text', text: '保留阅读位置。' }, { type: 'image', seq: 1 }] });
    store.saveAsset(article.id, { seq: 1, src: 'https://mmbiz.qpic.cn/fixture/0', status: 'complete', file: 'fixture/image.gif',
      storageDirectory: join(library, 'pictures'), mime: 'image/gif', bytes: image.length, sha256: createHash('sha256').update(image).digest('hex') });
    const job = store.createJob(account, 'archive', [article.id]);
    store.saveJob({ ...job, status: 'paused' }); store.close();
    application = await electron.launch({ executablePath: packaged.executable,
      args: [`--user-data-dir=${profile}`, `--library-root=${library}`], timeout: 30000 });
    const page = await application.firstWindow();
    await page.getByRole('heading', { name: '公众号', exact: true }).waitFor();
    const originalOrigin = new URL(page.url()).origin;
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    assert.equal((await fetch(`${originalOrigin}/api/reading-positions/${article.id}`, { method: 'PUT',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'body', top: 321 }) })).status, 200);
    await application.evaluate(({ dialog }) => {
      globalThis.__recoveryProbe = { messages: [], errors: [], answer: null };
      dialog.showMessageBox = async (...args) => {
        globalThis.__recoveryProbe.messages.push(args.at(-1));
        return new Promise(done => { globalThis.__recoveryProbe.answer = response => done({ response }); });
      };
      dialog.showErrorBox = (title, message) => globalThis.__recoveryProbe.errors.push({ title, message });
    });
    // These are ChildProcess handles created by this very Electron process, with the exact sidecar file.
    await application.evaluate(({ app }, crash) => {
      const owned = process._getActiveHandles().filter(handle => typeof handle.send === 'function' &&
        handle.spawnargs?.some(arg => /[\\/]desktop[\\/]service\.mjs$/.test(arg)) && handle.exitCode === null);
      if (owned.length !== 1) throw new Error('Expected exactly one owned fixture sidecar.');
      globalThis.__recoveryProbe.ownedPid = owned[0].pid;
      if (crash) owned[0].kill(); else owned[0].send({ type: 'shutdown' });
    }, mode === 'stale');
    await until(async () => await application.evaluate(() => globalThis.__recoveryProbe.messages.length === 1));
    assert.deepEqual(await application.evaluate(() => globalThis.__recoveryProbe.messages[0].buttons), ['重新打开文库', '退出']);
    await assert.rejects(fetch(`${originalOrigin}/api/health`, { signal: AbortSignal.timeout(1000) }));
    const lockPath = join(library, 'data/.shiye-service.lock');
    if (mode === 'retry') {
      assert.equal(existsSync(lockPath), false);
      await wait(250);
      assert.equal(await application.evaluate(() => process._getActiveHandles().filter(handle =>
        typeof handle.send === 'function' && handle.spawnargs?.some(arg => /[\\/]desktop[\\/]service\.mjs$/.test(arg)) && handle.exitCode === null).length), 0);
      await application.evaluate(() => globalThis.__recoveryProbe.answer(0));
      await until(async () => {
        try { return (await fetch(`${new URL(page.url()).origin}/api/health`)).ok; } catch { return false; }
      });
      await page.getByRole('heading', { name: '公众号', exact: true }).waitFor();
      const origin = new URL(page.url()).origin;
      assert.equal(resolve((await (await fetch(`${origin}/api/settings`)).json()).dataDirectory), join(library, 'data'));
      assert.deepEqual(await (await fetch(`${origin}/api/reading-positions/${article.id}`)).json(), { body: 321, gallery: 0 });
      assert.equal((await (await fetch(`${origin}/api/jobs`)).json()).find(item => item.id === job.id).status, 'paused');
      assert.equal((await (await fetch(`${origin}/api/accounts`)).json())[0].connection, 'disconnected');
      assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
      assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle()), '拾页');
      checks.push('real packaged sidecar waits for a native choice, then reopens same library in one window with paused jobs and reading position intact');
      await application.evaluate(() => {
        const owned = process._getActiveHandles().find(handle => typeof handle.send === 'function' &&
          handle.spawnargs?.some(arg => /[\\/]desktop[\\/]service\.mjs$/.test(arg)) && handle.exitCode === null);
        if (!owned) throw new Error('Reopened sidecar missing.');
        owned.send({ type: 'shutdown' });
      });
      await until(async () => await application.evaluate(() => globalThis.__recoveryProbe.messages.length === 2));
    } else {
      const lock = await readFile(lockPath), database = await readFile(join(library, 'data/archive.sqlite'));
      await application.evaluate(() => globalThis.__recoveryProbe.answer(0));
      await until(async () => await application.evaluate(() => globalThis.__recoveryProbe.messages.length === 2));
      const guidance = await application.evaluate(() => globalThis.__recoveryProbe.messages[1]);
      assert.deepEqual(guidance.buttons, ['打开文库目录', '重试', '退出']);
      assert.match(guidance.message, /没有正常退出/);
      assert.deepEqual(await readFile(lockPath), lock);
      assert.deepEqual(await readFile(join(library, 'data/archive.sqlite')), database);
      checks.push('abrupt exit retains stale lock; explicit reopen reaches typed guidance without changing database or deleting lock');
    }
    assert.deepEqual(await readFile(imagePath), image);
    assert.deepEqual(await application.evaluate(() => globalThis.__recoveryProbe.errors), []);
    const closed = application.waitForEvent('close');
    await application.evaluate(response => { setTimeout(() => globalThis.__recoveryProbe.answer(response), 10); }, mode === 'stale' ? 2 : 1);
    await closed; application = null;
    if (mode === 'retry') assert.equal(existsSync(lockPath), false);
    checks.push(`${mode}: native exit ends application without a maintenance deadlock`);
  }
  await writeFile(join(evidence, 'desktop-recovery-result.json'), JSON.stringify({ passed: true, checks, fixture, executable: packaged.executable }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  if (application) {
    await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 10); }).catch(() => {});
    await application.close().catch(() => {});
  }
}
