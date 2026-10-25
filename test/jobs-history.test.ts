import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server/app.js';
import type { JobPage } from '../shared/types.js';

async function fixture(t: test.TestContext, completedCount = 5000) {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'jobs-history-'));
  const app = await createApp({ dataDir: root, schedulerEnabled: false, staticDir: join(root, 'no-client') });
  t.after(async () => { await app.close(); assert.ok(root.startsWith(`${parent}${sep}jobs-history-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const store = app.archive.store, account = store.upsertAccount('JobHistory==', '历史分页测试号');
  const insert = store.db.prepare('INSERT INTO jobs(id,account_id,data) VALUES(?,?,?)');
  store.db.transaction(() => {
    for (let index = 0; index < completedCount; index++) insert.run(`completed-${index}`, account.id, JSON.stringify({ id: `completed-${index}`, accountId: account.id, accountName: account.name,
      kind: 'archive', status: 'completed', total: 1, completed: 1, failed: 0, progress: 100, message: '已完成', createdAt: '2026-10-25', updatedAt: '2026-10-25',
      offset: 0, pages: 0, maxPages: 20, pageBudget: 20, autoDownload: false, discoveredIds: ['internal'], inspectedIds: ['internal'], pendingPage: { entries: [] } }));
  })();
  for (const status of ['queued', 'running', 'paused', 'waiting_session', 'blocked', 'partial', 'failed'] as const) {
    const job = store.createJob(account, 'archive'); store.saveJob({ ...job, status });
  }
  return { app, store, account };
}

test('completed history is bounded SQL pagination while open polling excludes history and legacy jobs stays compatible', async t => {
  const { app, store } = await fixture(t); const queries: string[] = [], original = store.db.prepare;
  t.mock.method(store.db, 'prepare', function (this: typeof store.db, sql: string) { queries.push(sql); return original.call(this, sql); });
  const open = (await app.inject('/api/jobs?scope=open')).json(); assert.equal(open.length, 7); assert.ok(open.every((job: { status: string }) => job.status !== 'completed'));
  assert.ok(queries.some(sql => /FROM jobs\b/i.test(sql) && /WHERE/.test(sql)), 'Open polling must filter before decoding job JSON.');
  queries.length = 0;
  const first = (await app.inject('/api/jobs/history')).json<JobPage>();
  assert.equal(first.total, 5000); assert.equal(first.page, 1); assert.equal(first.pageSize, 20); assert.equal(first.items.length, 20);
  assert.equal(first.items[0].id, 'completed-4999'); assert.equal(first.items.at(-1)?.id, 'completed-4980');
  assert.ok(queries.some(sql => /LIMIT/i.test(sql)), 'History must be bounded in SQL.');
  assert.equal(queries.some(sql => /^SELECT data FROM jobs ORDER BY/.test(sql)), false);
  for (const job of first.items) for (const key of ['offset', 'pages', 'maxPages', 'pageBudget', 'autoDownload', 'discoveredIds', 'inspectedIds', 'pendingPage']) assert.equal(key in job, false, key);
  const second = (await app.inject('/api/jobs/history?page=2')).json<JobPage>(); assert.equal(second.items[0].id, 'completed-4979');
  assert.equal(new Set([...first.items, ...second.items].map(job => job.id)).size, 40);
  const legacy = (await app.inject('/api/jobs')).json(); assert.ok(Array.isArray(legacy)); assert.equal(legacy.length, 5007);
  assert.equal((await app.inject('/api/summary')).json().completedJobsCount, 5000);
  const short = store.createJob((await app.archive.accounts())[0], 'archive'); store.saveJob({ ...short, status: 'completed' });
  assert.equal((await app.inject('/api/summary')).json().completedJobsCount, 5001, 'Tasks completed entirely between polls must change the lightweight signal.');
});

test('empty completed history retains the open list and reports an explicit empty page', async t => {
  const { app } = await fixture(t, 0);
  const response = await app.inject('/api/jobs/history');
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { items: [], total: 0, page: 1, pageSize: 20 });
  assert.equal((await app.inject('/api/jobs?scope=open')).json().length, 7);
  assert.equal((await app.inject('/api/summary')).json().completedJobsCount, 0);
});

test('history focus finds the stable page for an old completed task and leaves missing or open focus on the requested page', async t => {
  const { app } = await fixture(t);
  const focused = (await app.inject('/api/jobs/history?focus=completed-0')).json<JobPage>(); assert.equal(focused.page, 250); assert.equal(focused.items.at(-1)?.id, 'completed-0');
  const first = (await app.inject('/api/jobs?scope=open')).json()[0];
  for (const focus of ['missing', first.id]) {
    const result = (await app.inject(`/api/jobs/history?page=3&focus=${focus}`)).json<JobPage>(); assert.equal(result.page, 3); assert.equal(result.items[0].id, 'completed-4959');
  }
  const beyond = (await app.inject('/api/jobs/history?page=9999&pageSize=100')).json<JobPage>(); assert.equal(beyond.items.length, 0); assert.equal(beyond.total, 5000);
});

test('job query boundaries reject malformed, duplicated and unknown inputs without changing records', async t => {
  const { app, store } = await fixture(t); const before = store.jobs().length;
  for (const query of ['scope=', 'scope=completed', 'scope=open&scope=open', 'page=1', 'unknown=x']) assert.equal((await app.inject(`/api/jobs?${query}`)).statusCode, 400, query);
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=', 'page=1&page=2', 'page=9007199254740991',
    'pageSize=0', 'pageSize=101', 'pageSize=abc', 'pageSize=1&pageSize=2', 'focus=', `focus=${'x'.repeat(129)}`, 'focus=a&focus=b', 'scope=open', 'unknown=1']) {
    assert.equal((await app.inject(`/api/jobs/history?${query}`)).statusCode, 400, query);
  }
  assert.equal(store.jobs().length, before);
});
