import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server/app.js';
import type { Collector, DiscoveredArticle, ParsedArticle } from '../shared/types.js';

const BIZ = 'CountedAccount==';
const url = (mid: number) => `https://mp.weixin.qq.com/s?__biz=${BIZ}&mid=${mid}&idx=1`;
const entry = (mid: number): DiscoveredArticle => ({ url: `${url(mid)}&key=PRIVATE&uin=PRIVATE`, title: `文章${mid}`, publishedAt: '2026-10-24', coverUrl: 'https://mmbiz.qpic.cn/cover/640?token=PRIVATE', biz: BIZ, mid: String(mid), idx: '1' });
async function fixture(t: test.TestContext) {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'discovery-count-test-'));
  const requests: number[] = [], articles: string[] = [];
  let gate: string | null = null, failure = false;
  const source: Collector = {
    fetchArticle: async input => { articles.push(input); return { biz: BIZ, mid: new URL(input).searchParams.get('mid')!, idx: '1', account: '计数号', url: input, title: '文章', publishedAt: '2026-10-24', blocks: [{ type: 'text', text: '正文' }], images: [], textLength: 2 } satisfies ParsedArticle; },
    fetchImage: async () => { throw Error('No body image expected'); }, captureSession: async () => { gate = null; }, hasSession: () => true, getGate: () => gate, clearGate: () => { gate = null; },
    discoverPage: async (_biz, offset) => { requests.push(offset); if (failure) throw { code: 'verification', blocked: true }; return offset === 0 ? { entries: [entry(1), entry(1), entry(2), entry(3), entry(4), entry(5)], nextOffset: 10, canContinue: true } : { entries: [entry(5), entry(6), entry(7)], nextOffset: 20, canContinue: false }; },
  };
  let app = await createApp({ dataDir: root, source, schedulerEnabled: false, staticDir: join(root, 'no-client') });
  const account = app.archive.store.upsertAccount(BIZ, '计数号');
  t.after(async () => { await app.close(); assert.ok(root.startsWith(`${parent}${sep}discovery-count-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return { get app() { return app; }, account, requests, articles, block() { gate = 'verification'; }, fail() { failure = true; },
    page(fetch: Collector['discoverPage']) { source.discoverPage = fetch; },
    async restart() { await app.close(); app = await createApp({ dataDir: root, source, schedulerEnabled: false, staticDir: join(root, 'no-client') }); } };
}

test('article limits stop precisely inside a multi-article page and resume its sanitized tail across restart', async t => {
  const f = await fixture(t), response = await f.app.inject({ method: 'POST', url: `/api/accounts/${f.account.id}/discover`, payload: { maxPages: 20, maxArticles: 2 } });
  assert.equal(response.statusCode, 201); const id = response.json().id; await f.app.archive.idle();
  let job = f.app.archive.store.job(id)!;
  assert.equal(f.app.archive.store.articles().length, 2); assert.equal(job.status, 'paused'); assert.equal(job.coverage?.stopReason, 'article_limit'); assert.equal(job.completed, 2);
  assert.deepEqual(f.requests, [0]); assert.ok(!JSON.stringify(job).includes('PRIVATE'));
  for (const field of ['pendingPage', 'inspectedIds', 'articleBudget', 'maxArticles']) assert.ok(!(field in f.app.archive.jobs()[0]), field);
  await f.restart(); f.app.archive.resume(id); await f.app.archive.idle();
  job = f.app.archive.store.job(id)!;
  assert.equal(job.completed, 4); assert.equal(f.app.archive.store.articles().length, 4); assert.deepEqual(f.requests, [0]);
  f.app.archive.resume(id); await f.app.archive.idle(); job = f.app.archive.store.job(id)!;
  assert.equal(job.completed, 6); assert.equal(job.coverage?.complete, false); assert.equal(job.coverage?.stopReason, 'article_limit'); assert.deepEqual(f.requests, [0, 10]);
  f.app.archive.resume(id); await f.app.archive.idle(); job = f.app.archive.store.job(id)!;
  assert.equal(job.completed, 7); assert.equal(job.status, 'completed'); assert.equal(job.coverage?.complete, true); assert.equal(job.coverage?.stopReason, 'reached_end');
  assert.equal(f.app.archive.store.articles().length, 7); assert.deepEqual(f.requests, [0, 10]);
});

test('existing articles count toward the requested inspection limit and page-only callers retain their behavior', async t => {
  const f = await fixture(t);
  for (let mid = 1; mid <= 7; mid++) f.app.archive.store.upsertArticle({ accountId: f.account.id, biz: BIZ, mid: String(mid), url: url(mid), title: `已有${mid}` });
  const response = await f.app.inject({ method: 'POST', url: `/api/accounts/${f.account.id}/discover`, payload: { maxPages: 20, maxArticles: 2 } }); await f.app.archive.idle();
  const limited = f.app.archive.store.job(response.json().id)!;
  assert.equal(limited.completed, 2); assert.equal(limited.status, 'paused'); assert.deepEqual(f.requests, [0]);
  const old = f.app.archive.createDiscoveryJob(f.account.id, 1); await f.app.archive.idle();
  assert.equal(f.app.archive.store.job(old.id)?.coverage?.stopReason, 'page_limit');
  assert.equal(f.app.archive.store.job(old.id)?.status, 'paused');
  assert.equal(f.app.archive.store.articles().length, 7);
});

test('duplicate tails do not inflate the limit or leave a fully inspected final page paused', async t => {
  const f = await fixture(t);
  f.page(async () => ({ entries: [entry(1), entry(2), entry(2)], nextOffset: 0, canContinue: false }));
  const response = await f.app.inject({ method: 'POST', url: `/api/accounts/${f.account.id}/discover`, payload: { maxArticles: 2 } }); await f.app.archive.idle();
  const job = f.app.archive.store.job(response.json().id)!;
  assert.equal(job.completed, 2); assert.equal(job.status, 'completed'); assert.equal(job.coverage?.complete, true);
  assert.equal(f.app.archive.store.articles().length, 2);
});

test('article-limited automatic downloads include only newly ingested targets and cannot bypass the source gate', async t => {
  const f = await fixture(t);
  f.app.archive.store.upsertArticle({ accountId: f.account.id, biz: BIZ, mid: '1', url: url(1), title: '已有文章' });
  const job = f.app.archive.createDiscoveryJob(f.account.id, 20, true, 2); await f.app.archive.idle();
  assert.equal(f.articles.length, 1); assert.equal(new URL(f.articles[0]).searchParams.get('mid'), '2');
  assert.equal(f.app.archive.store.articles().length, 2);
  f.block(); assert.throws(() => f.app.archive.resume(job.id));
  assert.deepEqual(f.requests, [0]);
});

test('a page request cap pauses before another fetch and malformed article limits are rejected', async t => {
  const f = await fixture(t);
  for (const maxArticles of [0, -1, 1.5, 10001, '2', null, true]) {
    assert.equal((await f.app.inject({ method: 'POST', url: `/api/accounts/${f.account.id}/discover`, payload: { maxArticles } })).statusCode, 400, String(maxArticles));
  }
  const response = await f.app.inject({ method: 'POST', url: `/api/accounts/${f.account.id}/discover`, payload: { maxPages: 1, maxArticles: 100 } }); await f.app.archive.idle();
  assert.equal(f.app.archive.store.job(response.json().id)?.coverage?.stopReason, 'page_limit'); assert.deepEqual(f.requests, [0]);
  f.app.archive.resume(response.json().id); f.fail(); await f.app.archive.idle();
  assert.equal(f.app.archive.store.job(response.json().id)?.status, 'blocked'); assert.deepEqual(f.requests, [0, 10]);
  assert.throws(() => f.app.archive.resume(response.json().id)); assert.deepEqual(f.requests, [0, 10]);
});
