import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Store } from '../server/store.js';

async function fixture(t: test.TestContext, completeCount: number) {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'store-startup-'));
  const store = new Store(root);
  t.after(async () => { if (store.db.open) store.close(); assert.ok(root.startsWith(`${parent}${sep}store-startup-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const account = store.upsertAccount('StartupFixture==', '启动恢复测试');
  const insert = store.db.prepare('INSERT INTO articles(id,account_id,data) VALUES(?,?,?)');
  const article = (id: string, status: string) => ({ id, accountId: account.id, biz: account.biz, title: id,
    url: 'https://mp.weixin.qq.com/s/startup-fixture', publishedAt: '2026-10-25', status, imageCount: 1, savedImageCount: 777,
    textLength: 6, blocks: [{ type: 'text', text: '正文保持原样' }], assets: [], extra: { unchanged: true } });
  store.db.transaction(() => {
    for (let index = 0; index < completeCount; index++) insert.run(`complete-${index}`, account.id, JSON.stringify(article(`complete-${index}`, 'complete'), null, 2));
  })();
  return { root, store, account, insert, article };
}

test('startup recovers interrupted states without changing completed article JSON or stored assets', async t => {
  const f = await fixture(t, 1000), db = f.store.db;
  f.insert.run('interrupted', f.account.id, JSON.stringify({ ...f.article('interrupted', 'downloading'), error: 'old error' }));
  f.insert.run('partial', f.account.id, JSON.stringify({ ...f.article('partial', 'partial'), error: 'keep this error' }, null, 2));
  const asset = { seq: 1, src: 'https://mmbiz.qpic.cn/startup/0', status: 'complete' as const, file: 'existing/image.png', storageDirectory: 'registered-root', bytes: 10, sha256: 'a'.repeat(64) };
  f.store.saveAsset('interrupted', asset);
  const running = f.store.createJob(f.account, 'archive', ['interrupted']); f.store.saveJob({ ...running, status: 'running' });
  const queued = f.store.createJob(f.account, 'archive', ['interrupted']);
  const completed = f.store.createJob(f.account, 'archive', ['complete-0']); f.store.saveJob({ ...completed, status: 'completed' });
  f.store.setJobItem(running.id, 0, 'running'); f.store.setJobItem(queued.id, 0, 'running'); f.store.setJobItem(completed.id, 0, 'complete');
  f.store.saveAccount({ ...f.account, connection: 'connected' });
  const articlesBefore = db.prepare("SELECT id,data FROM articles WHERE json_extract(data,'$.status')<>'downloading' ORDER BY id").all();
  const interruptedBefore = f.store.article('interrupted')!;
  const assetsBefore = db.prepare('SELECT * FROM assets').all();
  const completedBefore = db.prepare('SELECT data FROM jobs WHERE id=?').get(completed.id);
  f.store.close();
  const reopened = new Store(f.root);
  try {
    assert.deepEqual(reopened.db.prepare("SELECT id,data FROM articles WHERE id<>'interrupted' ORDER BY id").all(), articlesBefore);
    assert.deepEqual(reopened.article('interrupted'), { ...interruptedBefore, status: 'partial', error: '采集中断，可继续补全' });
    assert.deepEqual(reopened.db.prepare('SELECT * FROM assets').all(), assetsBefore);
    for (const job of [running, queued]) {
      assert.equal(reopened.job(job.id)?.status, 'paused');
      assert.equal(reopened.job(job.id)?.message, '服务曾中断，请确认后继续任务');
      assert.equal(reopened.jobItems(job.id)[0].status, 'pending');
    }
    assert.deepEqual(reopened.db.prepare('SELECT data FROM jobs WHERE id=?').get(completed.id), completedBefore);
    assert.equal(reopened.jobItems(completed.id)[0].status, 'complete');
    assert.equal(reopened.account(f.account.id)?.connection, 'disconnected');
  } finally { reopened.close(); }
});

test('completed article volume does not add startup detail or asset queries', async t => {
  const queries: string[] = [], prepare = Database.prototype.prepare;
  t.mock.method(Database.prototype, 'prepare', function (this: Database.Database, sql: string) {
    queries.push(sql); return prepare.call(this, sql);
  });
  const measure = async (completeCount: number) => {
    const f = await fixture(t, completeCount); f.store.close(); queries.length = 0;
    const reopened = new Store(f.root);
    const startup = [...queries]; reopened.close(); return startup;
  };
  const empty = await measure(0), populated = await measure(1000);
  t.diagnostic(`startup SQL preparations: empty=${empty.length}, 1000 complete articles=${populated.length}`);
  assert.equal(populated.length, empty.length, 'Completed records must not cause per-article startup queries.');
  assert.ok(populated.length <= 6, `Expected bounded startup statements, got ${populated.length}.`);
  assert.equal(populated.filter(sql => /FROM\s+assets\b/i.test(sql)).length, 0, 'Startup state recovery must not hydrate asset records.');
  assert.equal(populated.filter(sql => /SELECT\s+(?:id|data)\s+FROM\s+articles\b/i.test(sql) && !/WHERE/i.test(sql)).length, 0, 'Do not read the full article library to recover a status.');
});
