import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server/app.js';

test('a header-only image response cannot become a complete archived article', async t => {
  const parent = resolve('data/review-fixes-verification'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'image-test-'));
  const bytes = Buffer.from('524946460400000057454250', 'hex');
  const forbidden = async (): Promise<never> => { throw new Error('This test must not request WeChat.'); };
  const source = { fetchArticle: forbidden, captureSession: forbidden, discoverPage: forbidden, hasSession: () => true, getGate: () => null, clearGate: () => {},
    fetchImage: async () => ({ buffer: bytes, ext: 'webp', mime: 'image/webp', sha256: createHash('sha256').update(bytes).digest('hex') }) };
  const app = await createApp({ dataDir: join(root, 'data'), defaultImageDirectory: join(root, 'pictures'), schedulerEnabled: false, source });
  t.after(async () => { await app.close(); assert.ok(root.startsWith(`${parent}${sep}image-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  const account = app.archive.store.upsertAccount('image-integrity-biz', '本地测试');
  const article = app.archive.store.upsertArticle({ accountId: account.id, biz: account.biz, title: '损坏资源', url: 'https://mp.weixin.qq.com/s/image-integrity', imageCount: 1, blocks: [{ type: 'image', seq: 1 }] });
  app.archive.store.saveAsset(article.id, { seq: 1, src: 'https://mmbiz.qpic.cn/fixture/0', status: 'pending' });
  const job = app.archive.createArchiveJob(account.id, [article.id]); await app.archive.idle();
  assert.equal(app.archive.store.job(job.id)?.status, 'partial');
  assert.equal(app.archive.article(article.id).status, 'partial');
  assert.equal(app.archive.article(article.id).savedImageCount, 0);
  assert.ok(app.archive.store.storedAssets(article.id).every(asset => asset.status !== 'complete'));
});
