// Isolated daily-reading and reconnect fixture; never accesses WeChat or a user library.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../dist/server/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const evidence = resolve('data/reliability-verification');
await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(join(evidence, 'reader-details-'));
const executablePath = process.env.WECHAT_ARCHIVE_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(path => existsSync(path));
assert.ok(executablePath);
const captures = [], sessions = new Set();
let forbiddenRequests = 0;
const forbidden = async () => { forbiddenRequests++; throw new Error('This fixture must not collect from WeChat.'); };
const source = { fetchArticle: forbidden, fetchImage: forbidden, fetchCover: forbidden, discoverPage: forbidden,
  captureSession: async biz => { captures.push(biz); sessions.add(biz); }, hasSession: biz => sessions.has(biz), getGate: () => null, clearGate: () => {} };
const options = { dataDir: join(fixture, 'data'), defaultImageDirectory: join(fixture, 'pictures'), source, schedulerEnabled: false };
let app = await createApp(options);
const first = app.archive.store.upsertAccount('MzkzNzg5Njc2MQ==', '阅读甲号');
const second = app.archive.store.upsertAccount('MzkzNzg5Njc2Mg==', '阅读乙号');
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const sha = createHash('sha256').update(image).digest('hex');
const articles = [];
for (const [index, account] of [first, first, second].entries()) {
  const article = app.archive.store.upsertArticle({ accountId: account.id, biz: account.biz, mid: String(1000 + index), idx: '1',
    title: `阅读位置样本${index + 1}`, url: `https://mp.weixin.qq.com/s/reading-${index}`, publishedAt: '2026-10-25', status: 'complete', imageCount: 8, textLength: 20,
    blocks: [{ type: 'text', text: '本地阅读正文，滚动位置需要按文章与视图保存。' }, ...Array.from({ length: 8 }, (_, n) => ({ type: 'image', seq: n + 1 }))] });
  for (let seq = 1; seq <= 8; seq++) await app.archive.saveImage(article.id, { seq, src: `https://mmbiz.qpic.cn/reader/${index}/${seq}/0`, status: 'pending' }, image, 'gif', 'image/gif', sha);
  articles.push(article);
}
const waiting = app.archive.store.saveJob({ ...app.archive.store.createJob(first, 'archive'), status: 'waiting_session', message: '请连接微信后继续。' });
await app.listen({ host: '127.0.0.1', port: 0 });
let origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true });
let resumeRequests = 0;
const errors = [], checks = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort();
  if (/^\/api\/jobs\/[^/]+\/resume$/.test(url.pathname)) {
    resumeRequests++;
    return route.fulfill({ json: { ...waiting, status: 'queued' } });
  }
  return route.continue();
});
const page = await context.newPage(); page.setDefaultTimeout(10000);
page.on('pageerror', error => errors.push(error.message));
const positions = async id => (await fetch(`${origin}/api/reading-positions/${id}`)).json();
async function eventually(check) {
  const deadline = Date.now() + 10000;
  while (!await check()) { if (Date.now() > deadline) throw new Error('Reader detail assertion timed out'); await new Promise(done => setTimeout(done, 30)); }
}
async function open(article) {
  const requestedPosition = page.waitForResponse(response => response.url() === `${origin}/api/reading-positions/${article.id}` && response.request().method() === 'GET');
  const target = `${origin}/#reader?id=${article.id}`;
  if (page.url() === target) await page.reload(); else await page.goto(target);
  await page.getByRole('heading', { name: article.title, exact: true }).waitFor();
  await eventually(async () => (await page.locator('.reader-sheet img').evaluateAll(images => images.every(image => image.complete))));
  await requestedPosition;
}
async function scroll(top, wide = true) {
  const actual = await page.evaluate(({ top, wide }) => new Promise((done, reject) => {
    const target = wide ? document.querySelector('.reader-scroll') : window;
    const current = () => wide ? target.scrollTop : window.scrollY;
    const before = current();
    const finished = () => { clearTimeout(timer); target.removeEventListener('scroll', finished); done({ top: current(), before, max: wide ? target.scrollHeight - target.clientHeight : document.documentElement.scrollHeight - innerHeight }); };
    const timer = setTimeout(() => { target.removeEventListener('scroll', finished); reject(new Error('Fixture scroll event did not arrive')); }, 10000);
    target.addEventListener('scroll', finished, { once: true });
    target.dispatchEvent(new WheelEvent('wheel', { deltaY: 1 }));
    target.scrollTo({ top, behavior: 'instant' });
    if (current() === before) finished();
  }), { top, wide });
  assert.equal(actual.top, top, JSON.stringify(actual));
}
async function imageNavigation() {
  const large = Buffer.from(image); large.writeUInt16LE(1800, 6); large.writeUInt16LE(1200, 8);
  const firstImage = `**/api/assets/${articles[0].id}/1`;
  await page.route(firstImage, route => route.fulfill({ contentType: 'image/gif', body: large }));
  const dialog = page.getByRole('dialog'), preview = dialog.locator('.lightbox');
  const current = async seq => {
    await eventually(async () => await dialog.locator('img').getAttribute('alt') === `第 ${seq} 张本地图片`);
    await dialog.locator('img').evaluate(node => node.decode());
  };
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await open(articles[0]);
    const opener = page.getByRole('button', { name: '放大第 1 张图片', exact: true });
    await opener.click(); await dialog.waitFor(); await current(1);
    const previous = dialog.getByRole('button', { name: '上一张', exact: true });
    const next = dialog.getByRole('button', { name: '下一张', exact: true });
    assert.equal(await previous.count(), 1, 'Multi-image previews must offer continuous navigation.');
    assert.equal(await previous.isDisabled(), true);
    await preview.focus(); await page.keyboard.press('ArrowLeft'); await current(1);
    await page.keyboard.press('ArrowRight'); await current(2);
    await next.click(); await current(3);
    await dialog.getByRole('button', { name: '查看原图', exact: true }).click();
    await previous.click(); await current(2);
    assert.equal(await preview.getAttribute('data-original'), 'false', 'Changing images resets original-size mode.');
    await preview.focus();
    for (let index = 2; index < 8; index++) await page.keyboard.press('ArrowRight');
    await current(8); assert.equal(await next.isDisabled(), true);
    await page.keyboard.press('ArrowRight'); await current(8);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await opener.evaluate(node => node === document.activeElement), true);
    await opener.click(); await current(1);
    await dialog.getByRole('button', { name: '查看原图', exact: true }).click();
    assert.ok(await preview.evaluate(node => node.scrollWidth > node.clientWidth));
    await preview.focus(); await page.keyboard.press('ArrowRight');
    await eventually(async () => await preview.evaluate(node => node.scrollLeft > 0));
    await current(1);
    await next.click(); await current(2);
    assert.equal(await preview.getAttribute('data-original'), 'false');
    const bounds = await dialog.boundingBox();
    assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
    assert.equal(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    for (const button of [previous, next]) assert.ok((await button.boundingBox()).height >= 44);
    await page.screenshot({ path: join(evidence, `reader-image-navigation-${width}.png`) });
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    assert.equal(await opener.evaluate(node => node === document.activeElement), true);
  }
  await page.unroute(firstImage);
  const singleArticle = url => url.pathname === `/api/articles/${articles[0].id}`;
  await page.route(singleArticle, async route => {
    const response = await route.fetch(), article = await response.json();
    await route.fulfill({ json: { ...article, imageCount: 1, savedImageCount: 1, blocks: [{ type: 'image', seq: 1 }], assets: article.assets.filter(asset => asset.seq === 1) } });
  });
  await open(articles[0]);
  await page.getByRole('button', { name: '放大第 1 张图片', exact: true }).click(); await current(1);
  assert.equal(await dialog.getByRole('button', { name: '上一张', exact: true }).count(), 0);
  assert.equal(await dialog.getByRole('button', { name: '下一张', exact: true }).count(), 0);
  await preview.focus(); await page.keyboard.press('ArrowRight'); await current(1);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  await page.unroute(singleArticle);
  await page.route(singleArticle, async route => {
    const response = await route.fetch(), article = await response.json();
    await route.fulfill({ json: { ...article, status: 'partial', assets: article.assets.map(asset => asset.seq === 2 ? { ...asset, status: 'failed', localUrl: undefined } : asset) } });
  });
  const failedImage = `**/api/assets/${articles[0].id}/4`;
  await page.route(failedImage, route => route.fulfill({ status: 404, body: 'missing fixture image' }));
  await open(articles[0]);
  await page.getByRole('button', { name: '放大第 1 张图片', exact: true }).click(); await current(1);
  await dialog.getByRole('button', { name: '下一张', exact: true }).click(); await current(3);
  assert.equal(await dialog.locator('.lightbox-navigation>span').innerText(), '2 / 7', 'Navigation excludes incomplete assets.');
  await dialog.getByRole('button', { name: '下一张', exact: true }).click();
  await dialog.getByText('本地图片暂时无法读取', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: '上一张', exact: true }).click(); await current(3);
  assert.equal(await dialog.getByText('本地图片暂时无法读取', { exact: true }).count(), 0, 'A failed image must not hide a subsequent valid image.');
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  await page.unroute(singleArticle); await page.unroute(failedImage);
  assert.equal(context.pages().length, 1, 'Continuous image navigation must stay in the existing window.');
  checks.push('same-window image navigation supports mouse and keyboard, disabled non-wrapping boundaries, mode reset, original-image scrolling, single/incomplete/failed images and focus on desktop/mobile');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await open(articles[1]);
}
try {
  await imageNavigation();
  await open(articles[0]);
  await eventually(async () => await page.locator('.reader-catalogue-source').count() === 3);
  assert.deepEqual((await page.locator('.reader-catalogue-source').allTextContents()).sort(), ['阅读乙号', '阅读甲号', '阅读甲号'].sort());
  await scroll(460); await eventually(async () => (await positions(articles[0].id)).body === 460);
  await page.locator('.reader-catalogue').getByRole('button', { name: new RegExp(articles[1].title) }).click();
  await page.getByRole('heading', { name: articles[1].title, exact: true }).waitFor();
  await eventually(async () => await page.locator('.reader-scroll').evaluate(node => node.scrollTop) < 1);
  await scroll(230); await eventually(async () => (await positions(articles[1].id)).body === 230);
  await page.locator('.reader-catalogue').getByRole('button', { name: new RegExp(articles[0].title) }).click();
  await eventually(async () => Math.abs(await page.locator('.reader-scroll').evaluate(node => node.scrollTop) - 460) <= 1);
  await page.getByRole('tab', { name: '图集', exact: true }).evaluate(node => node.click());
  await eventually(async () => await page.locator('.reader-scroll').evaluate(node => node.scrollTop) < 1);
  await scroll(180); await eventually(async () => (await positions(articles[0].id)).gallery === 180);
  await page.getByRole('tab', { name: '正文', exact: true }).evaluate(node => node.click());
  await eventually(async () => Math.abs(await page.locator('.reader-scroll').evaluate(node => node.scrollTop) - 460) <= 1);
  await page.reload();
  await eventually(async () => Math.abs(await page.locator('.reader-scroll').evaluate(node => node.scrollTop) - 460) <= 1);
  checks.push('per-article and body/gallery scroll positions survive switching and reload; multi-source catalogue shows account names');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.reader-scroll').waitFor({ state: 'hidden' });
  await eventually(async () => Math.abs(await page.evaluate(() => scrollY) - 460) <= 1);
  await scroll(360, false); await eventually(async () => (await positions(articles[0].id)).body === 360);
  await page.reload(); await eventually(async () => Math.abs(await page.evaluate(() => scrollY) - 360) <= 1);
  checks.push('narrow-screen page scroll is restored and saved without an inner reader pane');

  const oldOrigin = origin;
  await app.close(); app = await createApp(options); await app.listen({ host: '127.0.0.1', port: 0 });
  origin = `http://127.0.0.1:${app.server.address().port}`;
  assert.notEqual(origin, oldOrigin);
  await page.goto(`${origin}/#reader?id=${articles[0].id}`);
  await eventually(async () => Math.abs(await page.evaluate(() => scrollY) - 360) <= 1);
  assert.equal((await positions(articles[0].id)).gallery, 180);
  checks.push('saved positions survive a service restart with a different local origin');

  await page.setViewportSize({ width: 1440, height: 1000 });
  let releasePosition, markPosition;
  const heldPosition = new Promise(done => { releasePosition = done; });
  const positionEntered = new Promise(done => { markPosition = done; });
  await page.route(`**/api/reading-positions/${articles[0].id}`, async route => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch(); markPosition(); await heldPosition;
    await route.fulfill({ response }).catch(() => {});
  });
  await page.reload(); await positionEntered;
  await page.getByRole('heading', { name: articles[0].title, exact: true }).waitFor();
  await page.waitForFunction(() => { const pane = document.querySelector('.reader-scroll'); return pane && pane.scrollHeight - pane.clientHeight >= 120; });
  await scroll(120);
  await page.getByRole('button', { name: '采集任务', exact: true }).click();
  releasePosition();
  await page.unroute(`**/api/reading-positions/${articles[0].id}`);
  await eventually(async () => (await positions(articles[0].id)).body === 120);
  checks.push('intentional scroll before a slow position response is retained on immediate navigation');

  await fetch(`${origin}/api/reading-positions/${articles[0].id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'body', top: 3500 }) });
  let releaseImages;
  const heldImages = new Promise(done => { releaseImages = done; });
  await page.route('**/api/assets/**', async route => { await heldImages; await route.continue().catch(() => {}); });
  await page.goto(`${origin}/#reader?id=${articles[0].id}`);
  await page.getByRole('heading', { name: articles[0].title, exact: true }).waitFor();
  await new Promise(done => setTimeout(done, 250));
  assert.equal((await positions(articles[0].id)).body, 3500, 'Unloaded images must not overwrite the saved position with the clamped top.');
  releaseImages();
  await eventually(async () => Math.abs(await page.locator('.reader-scroll').evaluate(node => node.scrollTop) - 3500) <= 1);
  await page.unroute('**/api/assets/**');
  checks.push('late image loads restore the requested position without saving an intermediate zero');

  let failPosition = true;
  await page.route(`**/api/reading-positions/${articles[0].id}`, route => {
    if (route.request().method() === 'GET' && failPosition) { failPosition = false; return route.fulfill({ status: 503, json: { error: 'position test unavailable' } }); }
    return route.continue();
  });
  await page.reload(); await page.getByText('阅读位置暂时无法恢复。', { exact: true }).waitFor();
  assert.equal((await positions(articles[0].id)).body, 3500);
  await page.getByRole('button', { name: '重新读取位置', exact: true }).evaluate(node => node.click());
  await eventually(async () => Math.abs(await page.locator('.reader-scroll').evaluate(node => node.scrollTop) - 3500) <= 1);
  await page.getByText('阅读位置暂时无法恢复。', { exact: true }).waitFor({ state: 'hidden' });
  await page.unroute(`**/api/reading-positions/${articles[0].id}`);
  checks.push('failed position reads leave saved progress intact and allow a successful retry');

  let failSave = true, positionGets = 0, positionPuts = 0;
  await page.route(`**/api/reading-positions/${articles[0].id}`, route => {
    if (route.request().method() === 'GET') positionGets++;
    if (route.request().method() === 'PUT') {
      positionPuts++;
      if (failSave) return route.fulfill({ status: 503, json: { error: 'position save test unavailable' } });
    }
    return route.continue();
  });
  await scroll(2400);
  const saveWarning = page.getByText('阅读位置暂时无法保存。', { exact: true });
  await saveWarning.waitFor();
  const warningBox = await saveWarning.boundingBox(), paneBox = await page.locator('.reader-scroll').boundingBox();
  assert.ok(warningBox && paneBox && warningBox.y >= paneBox.y && warningBox.y + warningBox.height <= paneBox.y + paneBox.height, 'A failed position save must be visible while reading the middle of a long article.');
  const firstFailedSave = positionPuts;
  await scroll(2600);
  await eventually(async () => positionPuts > firstFailedSave);
  const topBeforeRetry = await page.locator('.reader-scroll').evaluate(node => Math.round(node.scrollTop));
  const getsBeforeRetry = positionGets, putsBeforeRetry = positionPuts;
  failSave = false;
  await page.getByRole('button', { name: '重试保存位置', exact: true }).evaluate(node => node.click());
  await eventually(async () => (await positions(articles[0].id)).body === topBeforeRetry);
  await saveWarning.waitFor({ state: 'hidden' });
  assert.equal(positionGets, getsBeforeRetry, 'Retrying a save must not reload the old remote position.');
  assert.ok(positionPuts > putsBeforeRetry);
  assert.ok(Math.abs(await page.locator('.reader-scroll').evaluate(node => node.scrollTop) - topBeforeRetry) <= 1, 'Retrying a save must not move the reader to an old position.');
  await page.unroute(`**/api/reading-positions/${articles[0].id}`);
  checks.push('position save errors stay visible mid-article and retry the latest scrolled point without a GET or jump');

  await page.goto(`${origin}/#articles`);
  await page.getByRole('button', { name: `查看图集《${articles[0].title}》`, exact: true }).click();
  assert.equal(await page.getByRole('tab', { name: '图集', exact: true }).getAttribute('aria-selected'), 'true');
  await page.getByRole('button', { name: '文章目录', exact: true }).click();
  await page.getByRole('button', { name: articles[1].title, exact: true }).click();
  await page.getByRole('heading', { name: articles[1].title, exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '正文', exact: true }).getAttribute('aria-selected'), 'true', 'Article titles must explicitly open the body after a gallery visit.');
  await page.getByRole('tab', { name: '图集', exact: true }).evaluate(node => node.click());
  await page.reload();
  assert.equal(await page.getByRole('tab', { name: '图集', exact: true }).getAttribute('aria-selected'), 'true', 'Refreshing a reader must retain its current view.');
  await page.locator('.reader-catalogue').getByRole('button', { name: new RegExp(articles[0].title) }).click();
  await page.getByRole('heading', { name: articles[0].title, exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '图集', exact: true }).getAttribute('aria-selected'), 'true', 'Switching within the reader must retain its current view.');
  checks.push('title and gallery actions choose explicit views while reader tab choices survive refresh and catalogue navigation');

  await page.route(url => url.pathname === '/api/articles/page' && url.searchParams.get('status') === 'complete', route => route.fulfill({ json: { items: articles.slice(0, 2), total: 2, page: 1, pageSize: 100 } }));
  await page.reload();
  await eventually(async () => await page.locator('.reader-catalogue-item').count() === 2);
  assert.equal(await page.locator('.reader-catalogue-source').count(), 0);
  checks.push('single-source catalogue omits redundant account labels');

  await page.goto(`${origin}/#jobs?id=${waiting.id}`);
  const job = page.locator(`[id="job-${waiting.id}"]`);
  await job.getByRole('button', { name: '前往连接微信', exact: true }).waitFor();
  assert.equal(await job.getByRole('button', { name: '继续任务', exact: true }).count(), 0);
  await job.getByRole('button', { name: '前往连接微信', exact: true }).click();
  const account = page.locator(`[id="account-${first.id}"]`);
  await account.getByRole('button', { name: '连接微信', exact: true }).click();
  await account.getByRole('button', { name: '重新连接', exact: true }).waitFor();
  await page.getByText('已连接微信，可以返回原任务继续。', { exact: true }).waitFor();
  assert.equal(resumeRequests, 0); assert.equal(forbiddenRequests, 0);
  await account.getByRole('button', { name: '返回任务', exact: true }).click();
  await job.getByRole('button', { name: '继续任务', exact: true }).waitFor();
  assert.equal(resumeRequests, 0);
  await job.getByRole('button', { name: '继续任务', exact: true }).click();
  await eventually(async () => resumeRequests === 1);
  app.archive.store.gate = 'rate_limited';
  await page.getByRole('button', { name: '刷新进度', exact: true }).click();
  await job.getByRole('button', { name: '前往连接微信', exact: true }).waitFor();
  assert.equal(await job.getByRole('button', { name: '继续任务', exact: true }).count(), 0);
  checks.push('blocked and disconnected jobs prioritize reconnect; reconnect never resumes until the user explicitly continues');
  assert.deepEqual(errors, []); assert.equal(forbiddenRequests, 0); assert.deepEqual(captures, [first.biz]);
  await page.screenshot({ path: join(evidence, 'reader-details.png'), fullPage: true });
  await writeFile(join(evidence, 'reader-details-result.json'), JSON.stringify({ passed: true, checks, fixture, resumeRequests, forbiddenRequests }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
} finally { await browser.close(); await app.close(); }
