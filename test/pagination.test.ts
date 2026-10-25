import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server/app.js';

async function fixture(t: test.TestContext) {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'pagination-test-'));
  const app = await createApp({ dataDir: root, schedulerEnabled: false, staticDir: join(root, 'no-client') });
  t.after(async () => { await app.close(); assert.ok(root.startsWith(`${parent}${sep}pagination-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const store = app.archive.store, first = store.upsertAccount('FirstAccount==', '第一个号'), second = store.upsertAccount('SecondAccount==', '第二个号');
  const article = store.db.prepare('INSERT INTO articles(id,account_id,data) VALUES(?,?,?)');
  const asset = store.db.prepare('INSERT INTO assets(article_id,seq,data) VALUES(?,?,?)');
  store.db.transaction(() => {
    for (let index = 0; index < 3005; index++) {
      const id = `entry-${index}`, account = index % 2 ? second : first;
      article.run(id, account.id, JSON.stringify({ id, accountId: account.id, biz: account.biz, title: `文章 ${index} Alpha`,
        url: `https://mp.weixin.qq.com/s?__biz=${account.biz}&mid=${index}&idx=1`, publishedAt: index < 1000 ? '2026-10-23 12:00' : '2026-10-24 12:00',
        status: index % 3 ? 'discovered' : 'complete', savedImageCount: 999, imageCount: 2, textLength: 2,
        coverSource: index === 3004 ? 'https://mmbiz.qpic.cn/fixture/cover/640' : undefined,
        blocks: [{ type: 'text', text: '不应作为文章摘要返回'.repeat(100) }], assets: [] }));
      if (index % 3 === 0) {
        asset.run(id, 1, JSON.stringify({ seq: 1, src: 'https://mmbiz.qpic.cn/body/0', status: 'failed' }));
        asset.run(id, 2, JSON.stringify({ seq: 2, src: 'https://mmbiz.qpic.cn/body/0', status: 'complete', file: 'private/image.png', storageDirectory: 'private-root' }));
      }
    }
  })();
  return { app, first, second };
}

test('article pages aggregate only the requested summaries with stable order and constant query count', async t => {
  const { app } = await fixture(t), store = app.archive.store;
  const prepare = t.mock.method(store.db, 'prepare');
  const articleRead = t.mock.method(store, 'article', () => { throw Error('A page must not expand article details'); });
  const response = await app.inject('/api/articles/page');
  assert.equal(response.statusCode, 200);
  const page = response.json();
  assert.equal(page.total, 3005); assert.equal(page.page, 1); assert.equal(page.pageSize, 50); assert.equal(page.items.length, 50);
  assert.equal(page.items[0].id, 'entry-3004'); assert.equal(page.items.at(-1).id, 'entry-2955');
  assert.equal(page.items[0].coverUrl, '/api/covers/entry-3004'); assert.equal(page.items[0].savedImageCount, 0);
  const complete = page.items.find((item: { id: string }) => item.id === 'entry-3003');
  assert.equal(complete.savedImageCount, 1); assert.equal(complete.coverUrl, '/api/assets/entry-3003/2');
  assert.ok(page.items.every((item: object) => !('blocks' in item) && !('assets' in item)));
  assert.ok(!response.body.includes('private-root') && !response.body.includes('private/image.png'));
  assert.equal(articleRead.mock.callCount(), 0); assert.ok(prepare.mock.callCount() <= 2, `Expected count + page, got ${prepare.mock.callCount()}`);
  const next = (await app.inject('/api/articles/page?page=2&pageSize=50')).json();
  assert.equal(next.items[0].id, 'entry-2954'); assert.equal(new Set([...page.items, ...next.items].map(item => item.id)).size, 100);
  const last = (await app.inject('/api/articles/page?page=31&pageSize=100')).json();
  assert.equal(last.items.length, 5); assert.equal(last.items.at(-1).id, 'entry-0');
  assert.deepEqual((await app.inject('/api/articles/page?page=100')).json(), { items: [], total: 3005, page: 100, pageSize: 50 });
});

test('page filters preserve literal search, dates, account and status while legacy arrays remain compatible', async t => {
  const { app, first, second } = await fixture(t), store = app.archive.store;
  const title = 'Literal 100%_ 中文 ÄLPHA';
  const extra = store.upsertArticle({ accountId: first.id, biz: first.biz, mid: '9999', title, url: 'https://mp.weixin.qq.com/s?__biz=FirstAccount==&mid=9999&idx=1', publishedAt: '2026-10-24 23:59', status: 'partial' });
  const filters = new URLSearchParams({ q: '100%_ 中文 älpha', since: '2026-10-24', until: '2026-10-24', accountId: first.id, status: 'partial' });
  const page = (await app.inject(`/api/articles/page?${filters}`)).json();
  assert.equal(page.total, 1); assert.deepEqual(page.items.map((item: { id: string }) => item.id), [extra.id]);
  assert.equal((await app.inject(`/api/articles/page?${filters}&page=2`)).json().items.length, 0);
  filters.set('accountId', second.id); assert.equal((await app.inject(`/api/articles/page?${filters}`)).json().total, 0);
  assert.equal((await app.inject('/api/articles/page?q=%27%20OR%201%3D1--')).json().total, 0);
  const legacy = (await app.inject(`/api/articles?accountId=${first.id}&status=partial`)).json();
  assert.ok(Array.isArray(legacy)); assert.deepEqual(legacy.map((item: { id: string }) => item.id), [extra.id]);
});

test('page API rejects malformed pagination and filters instead of silently widening the result', async t => {
  const { app } = await fixture(t);
  for (const query of ['page=0', 'page=-1', 'page=1.5', 'page=1e2', 'page=', 'page=1&page=2', 'page=9007199254740991',
    'pageSize=0', 'pageSize=101', 'pageSize=abc', 'pageSize=1&pageSize=2', 'q=a&q=b', 'q[x]=a', 'status=unknown',
    'since=2026-02-30', 'since=2026-10-25&until=2026-10-24', 'until=tomorrow', `q=${'a'.repeat(501)}`]) {
    assert.equal((await app.inject(`/api/articles/page?${query}`)).statusCode, 400, query);
  }
  const empty = (await app.inject('/api/articles/page?q=not-present')).json();
  assert.deepEqual(empty, { items: [], total: 0, page: 1, pageSize: 50 });
});
