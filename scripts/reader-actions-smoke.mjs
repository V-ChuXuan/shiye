// Isolated article actions and explicit retry; never requests WeChat or a user library.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../dist/server/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); process.chdir(root);
const evidence = resolve('data/safe-cancel-verification'); await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(join(evidence, 'reader-actions-'));
const executablePath = process.env.WECHAT_ARCHIVE_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(existsSync);
assert.ok(executablePath);
let sourceRequests = 0;
const forbidden = async () => { sourceRequests++; throw new Error('No source requests in reader actions fixture.'); };
const app = await createApp({ dataDir: join(fixture, 'data'), defaultImageDirectory: join(fixture, 'pictures'), schedulerEnabled: false,
  source: { fetchArticle: forbidden, fetchImage: forbidden, captureSession: forbidden, discoverPage: forbidden, hasSession: () => false, getGate: () => null, clearGate() {} } });
const account = app.archive.store.upsertAccount('ReaderActions==', '阅读操作号');
const add = (title, status, imageCount = 0) => app.archive.store.upsertArticle({ accountId: account.id, biz: account.biz, title,
  url: `https://mp.weixin.qq.com/s/reader-action-${title}`, publishedAt: '2026-10-25', status, imageCount,
  blocks: Array.from({ length: 70 }, (_, n) => ({ type: 'text', text: `${title}第${n + 1}段保留当前正文与阅读位置。` })).concat(imageCount ? [{ type: 'image', seq: 1 }] : []) });
const text = add('纯文本样本', 'complete'), illustrated = add('有图样本', 'complete', 1), pending = add('待下载样本', 'discovered');
const partial = add('待补全样本', 'partial', 1), downloading = add('下载中样本', 'downloading'), unavailable = add('不可访问样本', 'unavailable');
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
await app.archive.saveImage(illustrated.id, { seq: 1, src: 'https://mmbiz.qpic.cn/reader-actions/0', status: 'pending' }, image, 'gif', 'image/gif');
await app.listen({ host: '127.0.0.1', port: 0 }); const origin = `http://127.0.0.1:${app.server.address().port}`;
await fetch(`${origin}/api/reading-positions/${text.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'body', top: 321 }) });
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const page = await context.newPage(); page.setDefaultTimeout(10000);
const errors = [], checks = [], detailRequests = new Map(); let libraryRequests = 0, failId = '', holdId = '', releaseHeld;
let heldReady;
const held = new Promise(done => { heldReady = done; });
await context.route('**/*', async route => {
  const request = route.request(), url = new URL(request.url());
  if (url.origin !== origin) return route.abort();
  if (url.pathname === '/api/articles/page' && url.searchParams.get('status') === 'complete') libraryRequests++;
  const match = /^\/api\/articles\/([^/]+)$/.exec(url.pathname);
  if (match && match[1] !== 'page' && request.method() === 'GET') {
    const id = decodeURIComponent(match[1]); detailRequests.set(id, (detailRequests.get(id) || 0) + 1);
    if (id === failId) { failId = ''; return route.fulfill({ status: 503, json: { error: '本地正文暂时无法读取' } }); }
    if (id === holdId) {
      holdId = ''; heldReady(); await new Promise(done => { releaseHeld = done; });
      return route.fulfill({ json: await (await fetch(request.url())).json() }).catch(() => {});
    }
  }
  return route.continue();
});
page.on('pageerror', error => errors.push(error.message));
const action = (article, label) => page.getByRole('button', { name: `${label}《${article.title}》`, exact: true });
const heading = article => page.locator('.reader-sheet h1').filter({ hasText: article.title });
async function until(check) { const limit = Date.now() + 10000; while (!await check()) { assert.ok(Date.now() < limit, 'Reader action assertion timed out.'); await new Promise(done => setTimeout(done, 25)); } }
try {
  await page.goto(`${origin}/#articles`);
  await action(text, '阅读全文').waitFor(); await action(illustrated, '查看图集').waitFor();
  await action(pending, '下载').waitFor(); await action(partial, '补全').waitFor();
  for (const [article, label] of [[downloading, '采集中'], [unavailable, '不可访问']]) {
    const row = page.getByRole('row').filter({ has: page.getByRole('button', { name: article.title, exact: true }) });
    assert.equal(await row.locator('.article-status-col').innerText(), label);
    assert.equal(await row.locator('.article-status-col button').count(), 0);
  }
  await action(text, '阅读全文').focus(); await page.keyboard.press('Enter'); await heading(text).waitFor();
  assert.equal(await page.getByRole('tab', { name: '正文', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.getByText('这篇文章还没有保存到本地的图片', { exact: true }).count(), 0);
  assert.equal(await page.locator('.reader-meta').getByText(/张图片/).count(), 0, 'Known zero-image articles omit redundant image counts.');
  await page.getByRole('tab', { name: '图集', exact: true }).evaluate(node => node.click());
  await page.getByText('这篇文章没有图片。', { exact: true }).waitFor();
  await page.getByRole('tab', { name: '正文', exact: true }).evaluate(node => node.click());
  await page.getByRole('button', { name: '返回目录', exact: true }).click(); await action(illustrated, '查看图集').click(); await heading(illustrated).waitFor();
  assert.equal(await page.getByRole('tab', { name: '图集', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('.reader-meta').getByText('1 / 1 张图片', { exact: true }).count(), 1);
  await page.evaluate(id => { location.hash = `reader?id=${id}`; }, partial.id); await heading(partial).waitFor();
  await page.getByText('这篇文章还没有保存到本地的图片。', { exact: true }).waitFor();
  assert.equal(await page.locator('.reader-meta').getByText('0 / 1 张图片', { exact: true }).count(), 1);
  assert.equal(await page.getByText('这篇文章没有图片。', { exact: true }).count(), 0);
  await page.evaluate(id => { location.hash = `reader?id=${id}`; }, pending.id); await heading(pending).waitFor();
  await page.getByText('这篇文章还没有保存到本地的图片。', { exact: true }).waitFor();
  assert.equal(await page.getByText('这篇文章没有图片。', { exact: true }).count(), 0, 'An undiscovered zero count does not prove the source has no images.');
  checks.push('complete zero-image articles open body with a text action; illustrated archives still open gallery and other statuses keep their actions');
  checks.push('known zero-image metadata and gallery copy differ from missing or not-yet-downloaded images without changing the chosen gallery mode');

  await page.getByRole('button', { name: '返回目录', exact: true }).click();
  await page.getByRole('checkbox', { name: `选择 ${pending.title}`, exact: true }).check();
  await page.getByRole('searchbox', { name: '搜索文章标题', exact: true }).fill('样本');
  await page.getByRole('button', { name: '阅读室', exact: true }).click();
  assert.equal(await page.locator('.reading-card').filter({ has: page.getByRole('heading', { name: text.title, exact: true }) }).locator('.reading-cover span').count(), 0);
  assert.equal(await page.locator('.reading-card').filter({ has: page.getByRole('heading', { name: illustrated.title, exact: true }) }).locator('.reading-cover span').innerText(), '1 图');
  await page.getByRole('searchbox', { name: '搜索已下载文章', exact: true }).fill('纯文本');
  failId = text.id;
  await page.locator('.reading-card').filter({ has: page.getByRole('heading', { name: text.title, exact: true }) }).click();
  await page.getByText('本地正文暂时无法读取', { exact: true }).waitFor();
  const reads = detailRequests.get(text.id), lists = libraryRequests, retry = page.getByRole('button', { name: '重新读取', exact: true });
  assert.equal(await retry.count(), 1);
  await page.waitForTimeout(4200);
  assert.equal(detailRequests.get(text.id), reads, 'Healthy polling must not automatically retry the article.');
  await retry.focus(); await page.keyboard.press('Enter'); await heading(text).waitFor();
  assert.equal(detailRequests.get(text.id), reads + 1); assert.equal(libraryRequests, lists, 'Explicit article retry must not reload the catalogue.');
  assert.equal(new URL(page.url()).hash, `#reader?id=${text.id}`);
  assert.equal(await page.getByRole('tab', { name: '正文', exact: true }).getAttribute('aria-selected'), 'true');
  await until(async () => Math.abs(await page.locator('.reader-scroll').evaluate(node => node.scrollTop) - 321) < 2);
  await page.getByRole('button', { name: '返回目录', exact: true }).click();
  assert.equal(new URL(page.url()).hash, '#reader');
  assert.equal(await page.getByRole('searchbox', { name: '搜索已下载文章', exact: true }).inputValue(), '纯文本');
  await page.getByRole('button', { name: '文章目录', exact: true }).click();
  assert.equal(await page.getByRole('searchbox', { name: '搜索文章标题', exact: true }).inputValue(), '样本');
  assert.equal(await page.getByRole('checkbox', { name: `选择 ${pending.title}`, exact: true }).isChecked(), true);
  checks.push('one explicit retry recovers a failed body without a catalogue reload, automatic loop or changes to mode, position, return path, filters and selection');

  failId = illustrated.id; await action(illustrated, '查看图集').click();
  await page.getByText('本地正文暂时无法读取', { exact: true }).waitFor(); await retry.click(); await heading(illustrated).waitFor();
  assert.equal(await page.getByRole('tab', { name: '图集', exact: true }).getAttribute('aria-selected'), 'true');
  checks.push('retry preserves an explicitly selected gallery view');

  await page.getByRole('button', { name: '返回目录', exact: true }).click();
  failId = text.id; await action(text, '阅读全文').click(); await page.getByText('本地正文暂时无法读取', { exact: true }).waitFor();
  holdId = text.id; await retry.click(); await held;
  await page.evaluate(id => { location.hash = `reader?id=${id}`; }, illustrated.id); await heading(illustrated).waitFor();
  releaseHeld(); releaseHeld = undefined;
  await page.waitForTimeout(150);
  assert.equal(await heading(text).count(), 0); assert.equal(await heading(illustrated).count(), 1);
  checks.push('a held older retry cannot replace a newer article after navigation');
  await page.screenshot({ path: join(evidence, 'reader-actions.png'), fullPage: true });

  await page.setViewportSize({ width: 390, height: 1000 });
  failId = text.id; await page.evaluate(id => { location.hash = `reader?id=${id}`; }, text.id);
  await page.getByText('本地正文暂时无法读取', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const retryBounds = await retry.boundingBox(); assert.ok(retryBounds && retryBounds.x >= 0 && retryBounds.x + retryBounds.width <= 390);
  await page.screenshot({ path: join(evidence, 'reader-retry-390.png'), fullPage: true });
  await retry.focus(); await page.keyboard.press('Enter'); await heading(text).waitFor();
  checks.push('the explicit retry remains visible, keyboard operable and within a 390px viewport');
  await page.getByRole('tab', { name: '图集', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.getByText('这篇文章没有图片。', { exact: true }).waitFor();
  assert.equal(await page.locator('.reader-meta').getByText(/张图片/).count(), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(evidence, 'reader-noimage-390.png'), fullPage: true });
  checks.push('the zero-image gallery remains keyboard accessible without redundant metadata or overflow at 390px');
  assert.equal(sourceRequests, 0); assert.deepEqual(errors, []);
  const report = { passed: true, checks, sourceRequests, libraryRequests, detailRequests: Object.fromEntries(detailRequests) };
  await writeFile(join(evidence, 'reader-actions-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await page.screenshot({ path: join(evidence, 'reader-actions-failure.png'), fullPage: true }).catch(() => {}); throw error; }
finally { releaseHeld?.(); await browser.close(); await app.close(); }
