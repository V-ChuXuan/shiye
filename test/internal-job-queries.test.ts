import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Collector } from '../shared/types.js';
import { ArchiveService } from '../server/service.js';
import { Store } from '../server/store.js';

async function directory(t: test.TestContext) {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'internal-jobs-'));
  t.after(async () => { assert.ok(root.startsWith(`${parent}${sep}internal-jobs-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  return root;
}
function history(store: Store, accountId: string) {
  const insert = store.db.prepare('INSERT INTO jobs(id,account_id,data) VALUES(?,?,?)');
  store.db.transaction(() => {
    for (let index = 0; index < 5000; index++) insert.run(`history-${index}`, accountId, JSON.stringify({ id: `history-${index}`, accountId,
      status: 'completed', historyMarker: true, pendingPage: { entries: ['retained internal history'] } }, null, 2));
  })();
}
function observeHistoryDecodes(t: test.TestContext) {
  let decoded = 0; const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (text: string, ...rest: unknown[]) => {
    if (text.includes('"historyMarker"')) decoded++;
    return Reflect.apply(parse, JSON, [text, ...rest]);
  });
  return () => decoded;
}

test('startup only decodes interrupted jobs and preserves inactive history bytes and task-item recovery', async t => {
  const root = await directory(t), seed = new Store(root);
  const account = seed.upsertAccount('InternalStartup==', '启动任务测试');
  history(seed, account.id);
  const article = seed.upsertArticle({ accountId: account.id, biz: account.biz, title: '原有文章', url: 'https://mp.weixin.qq.com/s/internal-startup' });
  const running = seed.createJob(account, 'archive', [article.id]); seed.saveJob({ ...running, status: 'running' });
  const queued = seed.createJob(account, 'archive', [article.id]);
  for (const job of [running, queued]) seed.setJobItem(job.id, 0, 'running');
  for (const status of ['paused', 'waiting_session', 'blocked', 'partial', 'failed'] as const) {
    const job = seed.createJob(account, 'discover'); seed.saveJob({ ...job, status });
  }
  seed.saveAccount({ ...account, connection: 'connected' });
  const inactive = seed.db.prepare("SELECT id,data FROM jobs WHERE json_extract(data,'$.status') NOT IN ('running','queued') ORDER BY rowid").all();
  seed.close();
  const decodes = observeHistoryDecodes(t);
  const reopened = new Store(root);
  try {
    assert.equal(decodes(), 0, 'Startup must not deserialize the 5000 completed jobs.');
    for (const job of [running, queued]) {
      assert.equal(reopened.job(job.id)?.status, 'paused');
      assert.equal(reopened.job(job.id)?.message, '服务曾中断，请确认后继续任务');
      assert.equal(reopened.jobItems(job.id)[0].status, 'pending');
    }
    assert.equal(reopened.account(account.id)?.connection, 'disconnected');
    assert.deepEqual(reopened.db.prepare('SELECT id,data FROM jobs WHERE id NOT IN (?,?) ORDER BY rowid').all(running.id, queued.id), inactive);
  } finally { reopened.close(); }
});

test('active existence scopes and next queued FIFO do not hydrate completed history', async t => {
  const root = await directory(t), store = new Store(root);
  try {
    const first = store.upsertAccount('InternalFirst==', '第一个号'), second = store.upsertAccount('InternalSecond==', '第二个号');
    history(store, first.id);
    for (const status of ['paused', 'waiting_session', 'blocked', 'partial', 'failed'] as const) {
      const job = store.createJob(first, 'discover'); store.saveJob({ ...job, status });
    }
    const decodes = observeHistoryDecodes(t), queries: string[] = [], prepare = store.db.prepare;
    t.mock.method(store.db, 'prepare', function (this: typeof store.db, sql: string) { queries.push(sql); return prepare.call(this, sql); });
    assert.equal(store.hasActiveJobs(), false); assert.equal(store.nextQueuedJob(), undefined);
    const oldest = store.createJob(first, 'discover'), newer = store.createJob(second, 'archive');
    const running = store.createJob(second, 'archive'); store.saveJob({ ...running, status: 'running' });
    store.saveJob({ ...oldest, message: 'Updated after newer jobs without changing FIFO' });
    assert.equal(store.hasActiveJobs(), true);
    assert.equal(store.hasActiveJobs(first.id, 'discover'), true);
    assert.equal(store.hasActiveJobs(first.id, 'archive'), false);
    assert.equal(store.hasActiveJobs(second.id, 'discover'), false);
    assert.equal(store.hasActiveJobs(undefined, 'archive'), true);
    assert.equal(store.hasActiveJobs("missing' OR 1=1 --"), false);
    assert.equal(store.nextQueuedJob()?.id, oldest.id);
    store.saveJob({ ...oldest, status: 'paused' });
    assert.equal(store.nextQueuedJob()?.id, newer.id);
    store.saveJob({ ...newer, status: 'completed' });
    assert.equal(store.nextQueuedJob(), undefined); assert.equal(store.hasActiveJobs(second.id), true);
    store.saveJob({ ...running, status: 'failed' }); assert.equal(store.hasActiveJobs(), false);
    assert.equal(decodes(), 0);
    assert.ok(queries.some(sql => /SELECT EXISTS/i.test(sql)));
    assert.ok(queries.some(sql => /FROM jobs/i.test(sql) && /ORDER BY rowid ASC LIMIT 1/i.test(sql)));
    assert.equal(queries.some(sql => /^SELECT data FROM jobs ORDER BY/i.test(sql)), false);
  } finally { store.close(); }
});

test('service guards, scheduler and worker use narrow queries while legacy jobs stays complete', async t => {
  const root = await directory(t), forbidden = async () => { throw new Error('No source request allowed.'); };
  const source: Collector = { fetchArticle: forbidden, fetchImage: forbidden, discoverPage: forbidden, captureSession: forbidden,
    hasSession: () => true, getGate: () => null, clearGate() {} };
  const service = new ArchiveService(root, source, false), store = service.store;
  try {
    const account = store.upsertAccount('InternalService==', '服务查询测试'); history(store, account.id);
    const article = store.upsertArticle({ accountId: account.id, biz: account.biz, title: '本地文本文章', url: 'https://mp.weixin.qq.com/s/internal-service',
      status: 'complete', imageCount: 0, blocks: [{ type: 'text', text: '不请求来源' }] });
    const fullJobs = t.mock.method(store, 'jobs', () => { throw new Error('Full history query is forbidden for internal decisions.'); });
    const active = store.createJob(account, 'discover');
    assert.throws(() => service.createDiscoveryJob(account.id), /已有清单刷新任务/);
    assert.throws(() => service.updateSettings({ imageDirectory: service.settings().imageDirectory }), /更改保存位置/);
    assert.throws(() => service.refreshProfile(account.id), /更新头像/);
    await assert.rejects(service.beginImport(), /当前操作完成/);
    store.saveAccount({ ...account, updatePolicy: 'discover', nextCheckAt: '2000-01-01T00:00:00Z' });
    (service as unknown as { schedule(): void }).schedule();
    assert.equal(store.account(account.id)?.nextCheckAt, '2000-01-01T00:00:00Z', 'An active account is skipped without advancing its schedule.');
    service.pause(active.id);
    await service.beginImport(); service.endImport();
    await service.updateSettings({ imageDirectory: service.settings().imageDirectory });
    const run = service.createArchiveJob(account.id, [article.id]); await service.idle();
    assert.equal(store.job(run.id)?.status, 'completed');
    assert.equal(fullJobs.mock.callCount(), 0, 'Every internal full-history caller must be migrated.');
    t.mock.restoreAll(); assert.equal(service.jobs().length, 5002, 'Legacy full-array jobs API remains compatible.');
  } finally { await service.close(); }
});
