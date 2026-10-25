// Offline, disposable fixtures only; injected waits and process termination are not power-loss tests.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, watch, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { Store } from '../dist/server/store.js';
import { createApp } from '../dist/server/app.js';
import { backupLibrary, restoreLibrary } from '../dist/server/library-backup.js';
import { acquireLibraryLock } from '../dist/server/startup.js';

const entry = fileURLToPath(import.meta.url), root = resolve(dirname(entry), '..'); process.chdir(root);
const hash = value => createHash('sha256').update(value).digest('hex');
// Use the same validated image fixture as the backup regression tests.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const pause = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
const turn = milliseconds => new Promise(done => setTimeout(done, milliseconds));

if (process.argv[2] === '--worker') {
  const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  const onProgress = value => {
    if (value.phase !== config.phase || value.completed !== 1) return;
    writeFileSync(config.barrier, JSON.stringify({ pid: process.pid, phase: value.phase, completed: value.completed }));
    const deadline = Date.now() + 30000;
    while (!existsSync(config.release)) { if (Date.now() >= deadline) throw new Error('Disposable worker barrier timed out'); pause(25); }
  };
  try {
    const result = await (config.operation === 'backup' ? backupLibrary(config.source, config.target, undefined, onProgress) : restoreLibrary(config.source, config.target, undefined, onProgress));
    process.send?.({ type: 'result', result });
  } catch (error) { process.send?.({ type: 'error', message: error.message }); process.exitCode = 1; }
  process.disconnect?.();
} else {
  const evidence = resolve('data/maintenance-reliability-verification'); await mkdir(evidence, { recursive: true });
  const fixture = await mkdtemp(join(evidence, 'reliability-')), library = join(fixture, '一万篇文库'), backup = join(fixture, '完整备份');
  const deadline = Date.now() + 10 * 60 * 1000, metrics = [], children = new Set();
  let sourceRequests = 0;
  const forbidden = async () => { sourceRequests++; throw new Error('No WeChat or network in reliability drill'); };
  const source = { fetchArticle: forbidden, fetchImage: forbidden, captureSession: forbidden, discoverPage: forbidden, hasSession: () => false, getGate: () => null, clearGate() {} };
  const report = { passed: false, fixture, node: process.version, platform: process.platform, samples: { articles: 10000, completedJobs: 10000, images: 8, imageBytes: png.length * 8 }, metrics, interruptions: [], observations: [], limits: ['Small validated images do not measure large-image throughput.', 'Delays and barriers are controlled simulation, not a physical slow disk.', 'Terminating an owned child does not prove power-loss durability.', 'File watcher events do not identify the creating process.', 'No user library, WeChat, system settings, antivirus or journal mode is changed.'] };
  async function measure(name, action) {
    assert.ok(Date.now() < deadline, 'Ten-minute drill budget exceeded');
    const start = performance.now(), value = await action();
    metrics.push({ name, elapsedMs: Math.round((performance.now() - start) * 100) / 100, rssBytes: process.memoryUsage().rss, processPeakRssKiB: process.resourceUsage().maxRSS });
    return value;
  }
  function tables(path) {
    const db = new Database(join(path, 'data/archive.sqlite'), { readonly: true });
    try { return hash(JSON.stringify(['accounts', 'articles', 'aliases', 'assets', 'jobs', 'job_items', 'runtime'].map(name => db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()))); }
    finally { db.close(); }
  }
  async function pictures(path) {
    const result = {};
    for (let seq = 1; seq <= 8; seq++) result[seq] = hash(await readFile(join(path, 'pictures/作者/图片样本', `${seq}.png`)));
    return result;
  }
  async function until(check, milliseconds = 30000) {
    const end = Math.min(deadline, Date.now() + milliseconds);
    while (!await check()) { assert.ok(Date.now() < end, 'Disposable drill condition timed out'); await turn(20); }
  }
  async function observe(kind, round, action) {
    const directory = join(fixture, `observe-${kind}-${round}`); await mkdir(directory);
    const events = [], watcher = watch(directory, { recursive: true }, (event, file) => {
      if (events.length < 256 && /sqlite|\.tmp/i.test(String(file))) events.push({ event, file: String(file), time: Date.now() });
    });
    let outcome = 'ok';
    try { await action(directory); }
    catch (error) { outcome = `${error.code || error.name}: ${error.message}`; }
    finally { await turn(80); watcher.close(); }
    report.observations.push({ kind, round, outcome, temporaryFileEvents: events.filter(value => /\.tmp$/i.test(value.file)), events });
  }
  try {
    let first;
    await measure('seed-10000-articles-and-10000-completed-jobs', async () => {
      const store = new Store(join(library, 'data')), account = store.upsertAccount('ReliabilityDrill==', '作者');
      store.db.transaction(() => {
        for (let index = 0; index < 10000; index++) {
          const article = store.upsertArticle({ accountId: account.id, biz: account.biz, mid: String(index + 1), idx: '1',
            title: `本地文章 ${index + 1}`, url: `https://mp.weixin.qq.com/s/drill-${index + 1}`, publishedAt: '2026-10-25', status: 'complete',
            imageCount: index ? 0 : 8, textLength: 16, blocks: [{ type: 'text', text: '隔离文库用于可靠性演练。' }] });
          if (!index) first = article;
          const job = store.createJob(account, 'discover'); store.saveJob({ ...job, status: 'completed', progress: 100, message: '离线样本' });
        }
      })();
      await mkdir(join(library, 'pictures/作者/图片样本'), { recursive: true });
      for (let seq = 1; seq <= 8; seq++) {
        const file = `作者/图片样本/${seq}.png`; await writeFile(join(library, 'pictures', file), png);
        store.saveAsset(first.id, { seq, src: `https://mmbiz.qpic.cn/drill/${seq}/0`, status: 'complete', file,
          storageDirectory: join(library, 'pictures'), bytes: png.length, sha256: hash(png), mime: 'image/png' });
      }
      store.saveImageDirectory(join(library, 'pictures'));
      report.sqlite = store.db.prepare('SELECT sqlite_version() AS version').get().version;
      store.close();
    });
    const original = tables(library), originalImages = await pictures(library);
    await measure('startup-and-api-complete-catalogue-100-pages', async () => {
      const app = await createApp({ dataDir: join(library, 'data'), defaultImageDirectory: join(library, 'pictures'), schedulerEnabled: false, source });
      try {
        const store = app.archive.store;
        assert.equal(store.hasActiveJobs(), false); assert.equal(store.nextQueuedJob(), undefined);
        const ids = new Set();
        for (let page = 1; page <= 100; page++) {
          const response = await app.inject(`/api/articles/page?status=complete&page=${page}&pageSize=100`); assert.equal(response.statusCode, 200);
          const value = response.json(); assert.equal(value.total, 10000); assert.equal(value.items.length, 100);
          for (const article of value.items) ids.add(article.id);
        }
        assert.equal(ids.size, 10000); assert.equal(store.jobHistory(500, 20).items.length, 20);
        assert.equal((await app.inject(`/api/articles/${first.id}`)).json().blocks[0].text, '隔离文库用于可靠性演练。');
        assert.deepEqual((await app.inject(`/api/assets/${first.id}/1`)).rawPayload, png);
      } finally { await app.close(); }
    });
    assert.equal(tables(library), original); assert.deepEqual(await pictures(library), originalImages);
    await measure('backup-10000-articles-and-jobs', async () => assert.deepEqual(await backupLibrary(library, backup), { directory: backup, images: 8, articles: 10000 }));
    const backupDatabase = hash(await readFile(join(backup, 'database.sqlite'))), backupManifest = hash(await readFile(join(backup, 'shiye-backup.json')));
    const restored = join(fixture, '完整恢复');
    await measure('restore-10000-articles-and-jobs', async () => assert.deepEqual(await restoreLibrary(backup, restored), { directory: restored, images: 8, articles: 10000 }));
    await measure('restored-library-offline-read', async () => {
      const app = await createApp({ dataDir: join(restored, 'data'), defaultImageDirectory: join(restored, 'pictures'), schedulerEnabled: false, source });
      try {
        assert.equal(app.archive.store.articlePage().total, 10000); assert.equal(app.archive.store.jobHistory(1, 20).total, 10000);
        assert.equal((await app.inject(`/api/articles/${first.id}`)).statusCode, 200);
        for (let seq = 1; seq <= 8; seq++) assert.deepEqual((await app.inject(`/api/assets/${first.id}/${seq}`)).rawPayload, png);
        assert.ok(app.archive.store.accounts().every(account => account.connection === 'disconnected' && account.updatePolicy === 'manual'));
      } finally { await app.close(); }
    });
    await measure('simulated-slow-checkpoints-cancel', async () => {
      for (const operation of ['backup', 'restore']) {
        const controller = new AbortController(), target = join(fixture, `slow-cancel-${operation}`); let waits = 0;
        await assert.rejects((operation === 'backup' ? backupLibrary : restoreLibrary)(operation === 'backup' ? library : backup, target, controller.signal, value => {
          if (value.phase === 'images') { pause(40); waits++; if (value.completed === 2) controller.abort(); }
        }), { name: 'AbortError' });
        assert.equal(existsSync(join(target, '.shiye-incomplete')), true); assert.ok(waits >= 3);
        if (operation === 'backup') assert.equal(existsSync(join(library, 'data/.shiye-service.lock')), false);
        report.interruptions.push({ operation, mode: 'abort-after-two-images', simulatedWaitMs: 40 * waits, incompleteMarkerRetained: true });
      }
    });
    for (const operation of ['backup', 'restore']) for (const phase of ['images', 'publishing']) {
      await measure(`owned-child-termination-${operation}-${phase}`, async () => {
        const directory = join(fixture, `interrupt-${operation}-${phase}`); await mkdir(directory);
        const sourceLibrary = operation === 'backup' ? join(directory, '原文库') : undefined;
        if (sourceLibrary) await restoreLibrary(backup, sourceLibrary);
        const sourceRoot = sourceLibrary || backup, target = join(directory, '未完成目标'), barrier = join(directory, 'barrier.json'), release = join(directory, 'release');
        const before = sourceLibrary ? tables(sourceLibrary) : backupDatabase;
        const config = join(directory, 'worker.json'); await writeFile(config, JSON.stringify({ operation, source: sourceRoot, target, phase, barrier, release }));
        const child = fork(entry, ['--worker', config], { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }); children.add(child);
        let stderr = ''; child.stderr.on('data', value => { stderr += value; });
        const exited = new Promise(done => child.once('exit', (code, signal) => { children.delete(child); done({ code, signal }); }));
        await until(() => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Worker exited before barrier: ${stderr}`); return existsSync(barrier); });
        const reached = JSON.parse(await readFile(barrier, 'utf8')); assert.equal(reached.pid, child.pid); assert.equal(reached.phase, phase);
        assert.equal(existsSync(join(target, '.shiye-incomplete')), true);
        assert.ok(child.spawnargs.includes(entry) && child.spawnargs.includes(config), 'Only this fixture worker may be terminated');
        child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null); const exit = await exited;
        assert.equal(existsSync(join(target, '.shiye-incomplete')), true);
        if (sourceLibrary) {
          const lock = join(sourceLibrary, 'data/.shiye-service.lock'); assert.equal(existsSync(lock), true);
          await assert.rejects(acquireLibraryLock(join(sourceLibrary, 'data')), error => error.code === 'library_lock_stale');
          assert.equal(tables(sourceLibrary), before); assert.deepEqual(await pictures(sourceLibrary), originalImages);
          await assert.rejects(restoreLibrary(target, join(directory, '拒绝未完成备份')), /尚未完成/);
        } else {
          await assert.rejects(acquireLibraryLock(join(target, 'data')), error => error.code === 'library_incomplete');
          await assert.rejects(restoreLibrary(backup, target), /新的空文件夹/);
        }
        const fresh = join(directory, '新空目录恢复'); await restoreLibrary(backup, fresh);
        const readable = new Store(join(fresh, 'data'));
        try { assert.equal(readable.articlePage().total, 10000); assert.equal(readable.article(first.id).blocks[0].text, '隔离文库用于可靠性演练。'); }
        finally { readable.close(); }
        assert.deepEqual(await pictures(fresh), originalImages);
        report.interruptions.push({ operation, mode: 'owned-process-termination', checkpoint: reached, exit, incompleteMarkerRetained: true,
          sourceLockRetained: Boolean(sourceLibrary), protectedReentryRejected: true, freshEmptyRestoreReadable: true });
      });
    }
    const small = join(fixture, '观察源'), smallStore = new Store(join(small, 'data')); smallStore.close();
    const smallBackup = join(fixture, '观察完整备份'); await backupLibrary(small, smallBackup);
    await measure('bounded-sqlite-file-observations-nine-runs', async () => {
      for (let round = 1; round <= 3; round++) {
        await observe('sqlite-open-close', round, async directory => {
          const store = new Store(join(directory, 'data')); store.upsertAccount(`Observe${round}==`, '观察'); store.close();
        });
        await observe('backup', round, directory => backupLibrary(small, join(directory, 'backup')));
        await observe('restore', round, directory => restoreLibrary(smallBackup, join(directory, 'restored')));
      }
    });
    assert.equal(tables(library), original); assert.deepEqual(await pictures(library), originalImages);
    assert.equal(hash(await readFile(join(backup, 'database.sqlite'))), backupDatabase); assert.equal(hash(await readFile(join(backup, 'shiye-backup.json'))), backupManifest);
    assert.equal(sourceRequests, 0);
    report.sourceRequests = sourceRequests; report.sourceTablesAndImagesUnchanged = true; report.backupBytesUnchanged = true;
    report.temporaryFileConclusion = report.observations.some(value => value.temporaryFileEvents.length) ? 'Temporary-file names observed; fs.watch cannot attribute a creator PID.' : 'No .tmp names observed in the nine bounded cases; the historical source remains unknown.';
    report.processOwnerTracing = 'Creator process was not attributed; this drill installs no tracing tools.';
    report.passed = true;
    await writeFile(join(evidence, 'reliability-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ ...report, observations: report.observations.map(({ events, ...value }) => value) }));
  } catch (error) {
    report.failure = { message: error.message, code: error.code, stack: error.stack };
    await writeFile(join(evidence, 'reliability-failure.json'), JSON.stringify(report, null, 2)); throw error;
  } finally {
    for (const child of children) { child.kill(); await until(() => child.exitCode !== null || child.signalCode !== null, 5000).catch(() => {}); }
  }
}
