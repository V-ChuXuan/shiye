// Single-article actions use an isolated collector and library; no WeChat requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../dist/server/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const executablePath = process.env.WECHAT_ARCHIVE_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
assert.ok(executablePath, 'Set WECHAT_ARCHIVE_BROWSER to an installed Chromium browser.');
const evidence = resolve('data/row-action-verification/implementation');
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(join(evidence, 'fixture-'));
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const sha256 = createHash('sha256').update(image).digest('hex');
const records = [], bodyRequests = [], imageRequests = [];
let captureRequests = 0;
const source = {
  fetchArticle: async url => {
    bodyRequests.push(url);
    const article = records.find(item => item.url === url);
    assert.ok(article, 'Only the explicitly requested fixture article can be fetched.');
    return { biz: article.biz, mid: article.mid, idx: '1', title: article.title, account: '行操作测试号', publishedAt: article.publishedAt,
      url, blocks: [{ type: 'text', text: '该篇本地正文' }, { type: 'image', seq: 1 }], textLength: 7,
      images: [{ seq: 1, src: `https://mmbiz.qpic.cn/fixture/${article.mid}/0` }] };
  },
  fetchImage: async src => { imageRequests.push(src); return { buffer: image, ext: 'gif', mime: 'image/gif', sha256 }; },
  fetchCover: async () => { throw new Error('Row actions must not fetch remote covers.'); },
  captureSession: async () => { captureRequests++; throw new Error('Row actions must not capture a session.'); },
  hasSession: () => false, getGate: () => null, clearGate: () => {},
  discoverPage: async () => { throw new Error('Row actions must not discover history.'); },
};
const app = await createApp({ dataDir: join(temporary, 'app'), source, schedulerEnabled: false });
const first = app.archive.store.upsertAccount('MzkzNzg5Njc2MQ==', '行操作测试号');
const second = app.archive.store.upsertAccount('MzkzNzg5Njc2Mg==', '其他测试号');
function add(title, mid, status, account = first) {
  const article = app.archive.store.upsertArticle({ accountId: account.id, biz: account.biz, mid, idx: '1', title, status,
    publishedAt: '2026-10-24 12:00', url: `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(account.biz)}&mid=${mid}&idx=1&sn=fixture`,
    ...status === 'complete' || status === 'partial' ? { imageCount: 1, textLength: 7, blocks: [{ type: 'text', text: '已存正文' }, { type: 'image', seq: 1 }] } : {} });
  records.push(article); return article;
}
const target = add('单篇下载样本', '1001', 'discovered');
const other = add('另一页选择样本', '1002', 'discovered', second);
const partial = add('缺图补全样本', '1003', 'partial');
app.archive.store.saveAsset(partial.id, { seq: 1, src: 'https://mmbiz.qpic.cn/fixture/partial/0', status: 'failed' });
const saved = add('已有本地图集', '1004', 'complete');
await app.archive.saveImage(saved.id, { seq: 1, src: 'https://mmbiz.qpic.cn/fixture/saved/0', status: 'pending' }, image, 'gif', 'image/gif', sha256);
add('正在下载样本', '1005', 'downloading');
add('无法访问样本', '1006', 'unavailable');
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true });
let page, passed = false, releasePending;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const external = [], errors = [], posts = [];
  let failNext = true, holdNext = false, markHeld;
  const held = new Promise(done => { markHeld = done; });
  const pending = new Promise(done => { releasePending = done; });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.hostname); return route.abort(); }
    if (url.pathname === '/api/jobs' && request.method() === 'POST') {
      posts.push(request.postDataJSON());
      if (failNext) { failNext = false; return route.fulfill({ status: 409, json: { error: '本次单篇任务未建立，请保留选择后重试。' } }); }
      if (holdNext) { holdNext = false; markHeld(); await pending; }
    }
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#articles`);
  const action = (article, label) => page.getByRole('button', { name: `${label}《${article.title}》`, exact: true });
  const choose = article => page.getByRole('checkbox', { name: `选择 ${article.title}`, exact: true });
  await action(saved, '查看图集').waitFor();
  for (const title of ['正在下载样本', '无法访问样本']) assert.equal(await page.getByRole('row').filter({ hasText: title }).locator('.article-state-action').count(), 0);
  assert.equal(await page.getByRole('row').filter({ hasText: saved.title }).getByRole('checkbox').count(), 0);
  await choose(target).check(); await choose(other).check();
  await action(target, '下载').click();
  await page.getByRole('alert').filter({ hasText: '本次单篇任务未建立' }).waitFor();
  assert.deepEqual(posts, [{ accountId: first.id, articleIds: [target.id] }]);
  assert.equal(new URL(page.url()).hash, '#articles');
  assert.equal(await choose(target).isChecked(), true); assert.equal(await choose(other).isChecked(), true);
  assert.equal(await page.getByRole('dialog').count(), 0);
  holdNext = true;
  await action(target, '下载').evaluate(button => { button.click(); button.click(); });
  await held;
  assert.equal(await action(target, '下载').isDisabled(), true);
  assert.equal(await action(target, '下载').getAttribute('aria-busy'), 'true');
  await action(target, '下载').getByText('提交中', { exact: true }).waitFor();
  assert.equal(posts.length, 2, 'A double activation while the request is pending creates one POST.');
  releasePending();
  await page.waitForURL('**/#jobs?id=*');
  const createdId = new URL(page.url()).hash.split('id=')[1];
  const created = app.archive.store.job(decodeURIComponent(createdId));
  assert.ok(created); assert.deepEqual(app.archive.store.jobItems(created.id).map(item => item.articleId), [target.id]);
  await page.waitForFunction(async jobId => (await (await fetch('/api/jobs')).json()).find(job => job.id === jobId)?.status === 'completed', created.id);
  await page.getByRole('button', { name: '文章目录', exact: true }).click();
  await action(target, '查看图集').waitFor();
  assert.equal(await choose(target).count(), 0); assert.equal(await choose(other).isChecked(), true);
  assert.ok((await page.locator('.catalogue-toolbar').innerText()).includes('已选 1 篇'));
  assert.equal(app.archive.store.article(other.id).status, 'discovered');

  await page.getByRole('button', { name: saved.title, exact: true }).click();
  await page.getByRole('heading', { name: saved.title, exact: true }).waitFor();
  await page.getByRole('tab', { name: '正文', exact: true }).click();
  await page.getByRole('button', { name: '返回目录', exact: true }).click();
  const beforeGallery = { posts: posts.length, bodies: bodyRequests.length, images: imageRequests.length };
  await action(target, '查看图集').focus(); await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: target.title, exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '图集', exact: true }).getAttribute('aria-selected'), 'true');
  await page.locator('.reader-gallery img').first().evaluate(image => image.decode());
  assert.equal(new URL(page.url()).hash, `#reader?id=${target.id}`);
  assert.deepEqual({ posts: posts.length, bodies: bodyRequests.length, images: imageRequests.length }, beforeGallery);
  await page.screenshot({ path: join(evidence, 'local-gallery.png') });
  await page.getByRole('button', { name: '返回目录', exact: true }).click();
  await action(partial, '补全').focus(); await page.keyboard.press('Space');
  await page.waitForURL('**/#jobs?id=*');
  assert.deepEqual(posts.at(-1), { accountId: first.id, articleIds: [partial.id] });
  const partialJob = decodeURIComponent(new URL(page.url()).hash.split('id=')[1]);
  await page.waitForFunction(async id => (await (await fetch('/api/jobs')).json()).find(job => job.id === id)?.status === 'completed', partialJob);
  await page.getByRole('button', { name: '文章目录', exact: true }).click();
  await action(partial, '查看图集').waitFor();
  assert.equal(await choose(other).isChecked(), true);
  const layouts = [];
  for (const width of [320, 390, 1440, 1905]) {
    await page.setViewportSize({ width, height: 1000 });
    await action(target, '查看图集').waitFor();
    const geometry = await page.locator('.article-table-wrap').evaluate(container => {
      const table = container.querySelector('table'), range = document.createRange(); range.selectNodeContents(table.querySelector('thead .article-status-col'));
      const header = range.getBoundingClientRect();
      return { width: container.clientWidth, scrollWidth: container.scrollWidth, rows: [...table.querySelectorAll('tbody .article-status-col')].map(cell => {
        const state = cell.querySelector('.article-state').getBoundingClientRect(), box = cell.getBoundingClientRect(), action = cell.querySelector('button')?.getBoundingClientRect();
        return { difference: Math.abs((header.left + header.right - state.left - state.right) / 2), verticalDifference: Math.abs((box.top + box.bottom - state.top - state.bottom) / 2), actionHeight: action?.height, inside: !action || action.left >= box.left && action.right <= box.right };
      }) };
    });
    assert.ok(geometry.scrollWidth <= geometry.width + 1);
    for (const row of geometry.rows) { assert.ok(row.difference <= 1); assert.ok(row.verticalDifference <= 1); assert.ok(row.inside); if (row.actionHeight) assert.ok(row.actionHeight >= 44); }
    layouts.push({ viewport: width, ...geometry });
    await page.screenshot({ path: join(evidence, `row-actions-${width}.png`), fullPage: true });
  }
  assert.deepEqual(errors, []);
  assert.ok(external.every(host => host === 'me.kis.v2.scr.kaspersky-labs.com'));
  assert.equal(captureRequests, 0);
  assert.equal(bodyRequests.length, 1); assert.equal(imageRequests.length, 2);
  const report = { passed: true, checks: ['single row ignores the batch selection', 'failure preserves selection and stays in directory', 'pending double activation submits once', 'success removes only target selection and opens its task', 'downloaded row opens exact local gallery from body preference', 'gallery performs no archive or collector requests', 'partial row keyboard action completes missing image', 'downloading/unavailable stay noninteractive', '320/390/1440/1905px centered controls have 44px targets'], jobPosts: posts.length, bodyRequests: bodyRequests.length, imageRequests: imageRequests.length, captureRequests, layouts };
  await writeFile(join(evidence, 'browser-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); passed = true;
} catch (error) {
  if (page) await page.screenshot({ path: join(evidence, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  releasePending?.(); await browser.close(); await app.close();
  assert.ok(temporary.startsWith(`${evidence}${sep}fixture-`));
  if (passed) await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
}
