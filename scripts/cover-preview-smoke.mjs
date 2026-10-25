// Exercises the real local cover endpoint with an isolated collector; never contacts WeChat.
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
const executablePath = process.env.WECHAT_ARCHIVE_BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(path => existsSync(path));
assert.ok(executablePath, 'Set WECHAT_ARCHIVE_BROWSER to an installed Chromium browser.');
await mkdir('data/cover-verification', { recursive: true });
const temporary = await mkdtemp(join(root, 'data', 'cover-smoke-'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const requests = [];
let articleRequests = 0, imageRequests = 0, discoveryRequests = 0;
const source = {
  fetchArticle: async () => { articleRequests++; throw new Error('Cover previews must not fetch article bodies.'); },
  fetchImage: async () => { imageRequests++; throw new Error('Cover previews must not fetch article image assets.'); },
  fetchCover: async src => {
    requests.push(src);
    if (src.includes('/broken/')) throw { code: 'network' };
    return { buffer: png, ext: 'png', mime: 'image/png', sha256: createHash('sha256').update(png).digest('hex') };
  },
  captureSession: async () => {}, hasSession: () => true, getGate: () => null, clearGate: () => {},
  discoverPage: async () => { discoveryRequests++; return { entries: [], nextOffset: 0, canContinue: false }; },
};
const app = await createApp({ dataDir: join(temporary, 'app'), source, schedulerEnabled: false });
const biz = 'MzkzNzg5Njc2MQ==';
const account = app.archive.store.upsertAccount(biz, '封面测试号');
const add = (title, mid, publishedAt, coverSource) => app.archive.store.upsertArticle({
  accountId: account.id, biz, mid, idx: '1', title, publishedAt,
  url: `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=${mid}&idx=1&sn=fixture`,
  ...(coverSource ? { coverSource } : {}),
});
const previewArticle = add('待采集封面样本', '1001', '2026-10-24 12:00', 'https://mmbiz.qpic.cn/fixture/preview/640');
const brokenArticle = add('封面不可用样本', '1002', '2026-10-23 12:00', 'https://mmbiz.qpic.cn/fixture/broken/640');
add('旧目录待补封面', '1003', '2026-10-22 12:00');
for (let index = 0; index < 140; index++) add(`远处封面样本${index}`, String(2000 + index), '2025-01-01 12:00', `https://mmbiz.qpic.cn/fixture/far-${index}/640`);
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true });
let page, passed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const external = [], errors = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    external.push(url.hostname); return route.abort();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#articles`);
  const button = page.getByRole('button', { name: '预览《待采集封面样本》的封面', exact: true });
  await button.waitFor();
  await button.locator('img').evaluate(image => image.decode());
  assert.ok((await button.boundingBox()).width >= 44, 'The visible thumbnail must be large enough to recognize.');
  const row = page.getByRole('row').filter({ has: button });
  await row.getByRole('button', { name: '下载《待采集封面样本》', exact: true }).waitFor();
  await page.getByRole('status', { name: '封面暂不可用', exact: true }).waitFor();
  const broken = page.getByRole('button', { name: /^(?:预览|重试)《封面不可用样本》的封面$/ });
  assert.ok((await broken.boundingBox()).height <= 60, 'A failed thumbnail must not grow the article row.');
  assert.equal(await page.getByRole('row').filter({ hasText: '旧目录待补封面' }).locator('img').count(), 0);
  assert.ok(requests.length < 142, 'Lazy thumbnails must not fetch the entire distant list.');
  await page.reload(); await button.waitFor();
  await page.getByRole('status', { name: '封面暂不可用', exact: true }).waitFor();
  assert.equal(requests.filter(src => src.includes('/broken/')).length, 1, 'Reloading a failed thumbnail must not bypass the request cooldown.');
  await page.getByRole('button', { name: '重试《封面不可用样本》的封面', exact: true }).click();
  await page.getByRole('status', { name: '封面暂不可用', exact: true }).waitFor();
  assert.equal(requests.filter(src => src.includes('/broken/')).length, 1, 'An explicit retry still respects the shared source cooldown.');
  assert.equal(await page.getByRole('dialog').count(), 0, 'Retrying a failed thumbnail must not open an empty preview.');
  app.archive.store.setArticle(brokenArticle.id, { coverSource: 'https://mmbiz.qpic.cn/fixture/recovered/640' });
  await page.getByRole('button', { name: '刷新目录', exact: true }).click();
  await broken.locator('img').waitFor();
  await broken.locator('img').evaluate(image => image.decode());
  assert.ok(requests.some(src => src.includes('/recovered/')), 'Changed cover sources must recover a failed image at the same local URL.');
  const loadedBeforePreview = requests.filter(src => src.includes('/preview/')).length;
  await button.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: previewArticle.title, exact: true }).waitFor();
  await dialog.getByText('仅预览封面，正文和图集尚未采集。', { exact: true }).waitFor();
  await dialog.locator('img').evaluate(image => image.decode());
  assert.ok((await dialog.locator('img').boundingBox()).width >= 260, 'The expanded cover must be larger than its list thumbnail.');
  assert.equal(requests.filter(src => src.includes('/preview/')).length, loadedBeforePreview, 'Opening the preview must reuse the cached cover.');
  await page.screenshot({ path: 'data/cover-verification/preview-desktop.png' });
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await button.evaluate(element => element === document.activeElement), true, 'Escape must restore the initiating preview button.');
  let transientFailure = true;
  const localPreviewRoute = url => url.pathname === `/api/covers/${previewArticle.id}`;
  await page.route(localPreviewRoute, route => {
    if (transientFailure) { transientFailure = false; return route.fulfill({ status: 503 }); }
    return route.continue();
  });
  await page.reload();
  const retry = page.getByRole('button', { name: '重试《待采集封面样本》的封面', exact: true });
  await retry.waitFor();
  await retry.click();
  await button.locator('img').waitFor(); await button.locator('img').evaluate(image => image.decode());
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('button button').count(), 0, 'Retry controls must not be nested buttons.');
  assert.equal(requests.filter(src => src.includes('/preview/')).length, loadedBeforePreview, 'Same-URL explicit retry should reuse the server cache after a temporary local response failure.');
  await page.unroute(localPreviewRoute);
  const supplement = page.getByRole('button', { name: '补充封面', exact: true });
  assert.equal(await supplement.isEnabled(), true);
  await supplement.click();
  await page.getByRole('dialog').getByRole('heading', { name: '发现「封面测试号」的文章', exact: true }).waitFor();
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  app.archive.store.upsertAccount('MzA5MTIzNDU2Nw==', '另一个测试号');
  await page.reload(); await page.getByRole('button', { name: '补充封面', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '补充封面', exact: true }).isDisabled(), true, 'Several accounts require an explicit account filter.');
  await page.getByRole('combobox', { name: '筛选公众号', exact: true }).click();
  await page.getByRole('option', { name: '封面测试号', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.cover-hint button')?.disabled);
  await page.getByRole('button', { name: '补充封面', exact: true }).click();
  await page.getByRole('dialog').getByRole('heading', { name: '发现「封面测试号」的文章', exact: true }).waitFor();
  await page.keyboard.press('Escape'); await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile page must not overflow.');
  await page.screenshot({ path: 'data/cover-verification/catalogue-mobile.png' });
  await button.click(); await page.getByRole('dialog').locator('img').evaluate(image => image.decode());
  assert.ok((await page.getByRole('dialog').locator('img').boundingBox()).width >= 260, 'The mobile cover preview must remain readable.');
  assert.ok(await page.getByRole('dialog').evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1; }));
  await page.screenshot({ path: 'data/cover-verification/preview-mobile.png' });
  await page.keyboard.press('Escape');
  const fresh = app.archive.article(previewArticle.id);
  assert.equal(fresh.status, 'discovered'); assert.equal(fresh.savedImageCount, 0); assert.equal(fresh.imageCount, 0);
  assert.deepEqual(fresh.blocks, []); assert.deepEqual(fresh.assets, []); assert.equal(app.archive.jobs().length, 0);
  assert.equal(app.archive.article(brokenArticle.id).status, 'discovered');
  assert.equal(requests.filter(src => src.includes('/broken/')).length, 1, 'Failed cover requests must respect the cooldown across reloads.');
  assert.equal(articleRequests, 0); assert.equal(imageRequests, 0); assert.equal(discoveryRequests, 0);
  assert.deepEqual(errors, []);
  assert.ok(external.every(host => host === 'me.kis.v2.scr.kaspersky-labs.com'), `Unexpected network: ${external.join(', ')}`);
  const report = { passed: true, checks: ['real same-origin thumbnail decode', 'visible-range lazy loading', 'large cover preview reuses cache', 'Escape restores initiating focus', 'failed cover stays compact and cooldown prevents retry loops', 'changed cover source recovers a failed thumbnail', 'explicit same-URL retry recovers a temporary failure without nested buttons', 'manual retry still respects source cooldown', 'missing cover uses placeholder', 'single-account supplement reuses discovery dialog', 'multiple accounts require filtering', 'mobile catalogue and preview fit viewport', 'preview preserves discovered status and zero assets/jobs/body requests'], coverRequests: requests.length, articleRequests, imageRequests, discoveryRequests, externalBlocked: external };
  await writeFile('data/cover-verification/result.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); passed = true;
} catch (error) {
  if (page) await page.screenshot({ path: 'data/cover-verification/failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser.close(); await app.close();
  assert.ok(resolve(temporary).startsWith(`${resolve(root, 'data')}${sep}cover-smoke-`));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (!passed) console.error('Cover preview smoke failed; diagnostics retained in data/cover-verification.');
}
