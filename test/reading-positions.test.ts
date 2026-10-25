import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server/app.js';
import type { Collector } from '../shared/types.js';

async function fixture(t: test.TestContext) {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'reading-position-test-'));
  const forbidden = async () => { throw new Error('Reading preferences must not request WeChat.'); };
  const source: Collector = { fetchArticle: forbidden, fetchImage: forbidden, fetchCover: forbidden, captureSession: forbidden, discoverPage: forbidden, hasSession: () => false, getGate: () => null, clearGate: () => {} };
  const open = (directory = root) => createApp({ dataDir: directory, source, schedulerEnabled: false, staticDir: join(root, 'no-client') });
  let app = await open();
  t.after(async () => { await app.close(); assert.ok(root.startsWith(`${parent}${sep}reading-position-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const account = app.archive.store.upsertAccount('ReadingPosition==', '阅读位置测试');
  const article = (index = 0) => app.archive.store.upsertArticle({ accountId: account.id, biz: account.biz, mid: String(index), title: `文章 ${index}`, url: `https://mp.weixin.qq.com/s?__biz=ReadingPosition==&mid=${index}&idx=1`, blocks: [{ type: 'text', text: '本地正文' }] });
  return { root, get app() { return app; }, article, open, restart: async () => { await app.close(); app = await open(); } };
}

test('reading positions merge each view and survive a new service port without changing articles or jobs', async t => {
  const f = await fixture(t), one = f.article(), two = f.article(1);
  const route = `/api/reading-positions/${one.id}`, db = f.app.archive.store.db;
  const before = db.prepare('SELECT key,value FROM runtime ORDER BY key').all();
  assert.deepEqual((await f.app.inject(route)).json(), { body: 0, gallery: 0 });
  assert.deepEqual(db.prepare('SELECT key,value FROM runtime ORDER BY key').all(), before, 'Reading a default position must not write.');
  assert.equal((await f.app.inject('/api/reading-positions/missing')).statusCode, 404);
  assert.deepEqual((await f.app.inject({ method: 'PUT', url: route, payload: { mode: 'body', top: 1234.5 } })).json(), { body: 1234.5, gallery: 0 });
  assert.deepEqual((await f.app.inject({ method: 'PUT', url: route, payload: { mode: 'gallery', top: 500 } })).json(), { body: 1234.5, gallery: 500 });
  assert.deepEqual((await f.app.inject(`/api/reading-positions/${two.id}`)).json(), { body: 0, gallery: 0 });
  await f.app.listen({ host: '127.0.0.1', port: 0 });
  const first = f.app.server.address(); assert.ok(first && typeof first !== 'string');
  const firstOrigin = `http://127.0.0.1:${first.port}`;
  assert.deepEqual(await (await fetch(`${firstOrigin}${route}`)).json(), { body: 1234.5, gallery: 500 });
  await f.restart(); await f.app.listen({ host: '127.0.0.1', port: 0 });
  const second = f.app.server.address(); assert.ok(second && typeof second !== 'string');
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${second.port}${route}`)).json(), { body: 1234.5, gallery: 500 });
  assert.deepEqual(f.app.archive.article(one.id), one); assert.deepEqual(f.app.archive.jobs(), []);
  const other = await f.open(join(f.root, 'other-library'));
  try { assert.equal((await other.inject(route)).statusCode, 404); assert.equal(other.archive.store.db.prepare("SELECT value FROM runtime WHERE key='reader_positions'").get(), undefined); }
  finally { await other.close(); }
});

test('reading position writes reject malformed values, unknown fields and foreign origins without writing', async t => {
  const f = await fixture(t), article = f.article(), route = `/api/reading-positions/${article.id}`;
  const invalid: unknown[] = [null, [], {}, { mode: 'body' }, { top: 10 }, { mode: 'other', top: 3 }, { mode: 'body', top: -1 },
    { mode: 'body', top: 10_000_001 }, { mode: 'body', top: '2' }, { mode: 'body', top: null }, { mode: 'gallery', top: true }, { mode: 'body', top: 1, title: 'private' }];
  for (const payload of invalid) {
    const response = await f.app.inject({ method: 'PUT', url: route, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
    assert.equal(response.statusCode, 400, JSON.stringify(payload));
  }
  for (const payload of ['{"mode":"body","top":1e999}', '{']) assert.equal((await f.app.inject({ method: 'PUT', url: route, headers: { 'content-type': 'application/json' }, payload })).statusCode, 400);
  for (const method of ['GET', 'PUT'] as const) assert.equal((await f.app.inject({ method, url: route, headers: { host: '127.0.0.1', origin: 'https://foreign.example' }, ...(method === 'PUT' ? { payload: { mode: 'body', top: 50 } } : {}) })).statusCode, 403);
  assert.equal((await f.app.inject({ method: 'PUT', url: '/api/reading-positions/missing', payload: { mode: 'body', top: 1 } })).statusCode, 404);
  assert.equal(f.app.archive.store.db.prepare("SELECT value FROM runtime WHERE key='reader_positions'").get(), undefined);
  assert.deepEqual((await f.app.inject({ method: 'PUT', url: route, payload: { mode: 'body', top: 10_000_000 } })).json(), { body: 10_000_000, gallery: 0 });
});

test('reading positions retain only 200 most recently touched articles and never store business content', async t => {
  const f = await fixture(t), articles = Array.from({ length: 201 }, (_, index) => f.article(index));
  const write = (index: number, top: number) => f.app.inject({ method: 'PUT', url: `/api/reading-positions/${articles[index].id}`, payload: { mode: 'body', top } });
  for (let index = 0; index < 200; index++) assert.equal((await write(index, index + 1)).statusCode, 200);
  await write(0, 999); await write(200, 201);
  const raw = (f.app.archive.store.db.prepare("SELECT value FROM runtime WHERE key='reader_positions'").get() as { value: string }).value;
  const saved = JSON.parse(raw);
  assert.equal(Object.keys(saved).length, 200); assert.equal(saved[articles[1].id], undefined);
  assert.deepEqual(saved[articles[0].id], { body: 999, gallery: 0 });
  assert.deepEqual((await f.app.inject(`/api/reading-positions/${articles[1].id}`)).json(), { body: 0, gallery: 0 });
  assert.ok(Object.values(saved).every(value => Object.keys(value as object).sort().join(',') === 'body,gallery'));
  assert.ok(!raw.includes('title') && !raw.includes('https:') && !raw.includes('本地正文'));
});

test('malformed stored preferences cannot expose unchecked values and GET does not repair or overwrite them', async t => {
  const f = await fixture(t), article = f.article(), route = `/api/reading-positions/${article.id}`, db = f.app.archive.store.db;
  for (const value of ['invalid JSON', 'null', '[]', JSON.stringify({ [article.id]: { body: -1, gallery: 4 } }), JSON.stringify({ [article.id]: { body: 0, gallery: '10' } }), ' '.repeat(100_001)]) {
    db.prepare('INSERT OR REPLACE INTO runtime(key,value) VALUES(?,?)').run('reader_positions', value);
    assert.deepEqual((await f.app.inject(route)).json(), { body: 0, gallery: 0 });
    assert.equal((db.prepare("SELECT value FROM runtime WHERE key='reader_positions'").get() as { value: string }).value, value);
  }
  db.prepare('INSERT OR REPLACE INTO runtime(key,value) VALUES(?,?)').run('reader_positions', `{"__proto__":{"body":8,"gallery":9},"${article.id}":{"body":12,"gallery":13,"title":"private"}}`);
  assert.deepEqual((await f.app.inject(route)).json(), { body: 12, gallery: 13 });
  assert.deepEqual((await f.app.inject({ method: 'PUT', url: route, payload: { mode: 'gallery', top: 90 } })).json(), { body: 12, gallery: 90 });
  const raw = (db.prepare("SELECT value FROM runtime WHERE key='reader_positions'").get() as { value: string }).value;
  assert.ok(!raw.includes('__proto__') && !raw.includes('title'));
});
