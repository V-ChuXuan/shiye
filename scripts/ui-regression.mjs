// Uses a local collector fixture: no WeChat connection, credentials, or network collection.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../dist/server/app.js';

async function assertSelectionScope(page, total, current, elsewhere) {
  const details = page.locator('.selection-details');
  assert.equal(await details.locator('summary').innerText(), `已选 ${total} 篇`);
  if (!await details.evaluate(element => element.open)) await details.locator('summary').click();
  assert.equal(await details.locator('p').isVisible(), true);
  assert.equal(await details.locator('p').innerText(), `本页 ${current} 篇 · 其他页或筛选外 ${elsewhere} 篇`);
  assert.equal(await page.getByRole('button', { name: `下载${total}篇`, exact: true }).isEnabled(), true);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const executablePath = process.env.WECHAT_ARCHIVE_BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(path => existsSync(path));
assert.ok(executablePath, 'Set WECHAT_ARCHIVE_BROWSER to an installed Chromium browser.');
await mkdir('data/ui-verification', { recursive: true });
const temporary = await mkdtemp(join(root, 'data', 'ui-regression-'));
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const sha256 = createHash('sha256').update(image).digest('hex');
const collected = [];
const source = {
  fetchArticle: async () => { throw new Error('The fixture must not fetch public articles.'); },
  fetchImage: async src => { collected.push(src); return { buffer: image, ext: 'gif', mime: 'image/gif', sha256 }; },
  captureSession: async () => {}, hasSession: () => true, getGate: () => null, clearGate: () => {},
  discoverPage: async () => ({ entries: [], nextOffset: 0, canContinue: false }),
};
const app = await createApp({ dataDir: join(temporary, 'app'), source, schedulerEnabled: false });
const records = [];
for (const [name, biz, titles] of [
  ['本地测试甲号', 'MzkzNzg5Njc2MQ==', ['待补全文章甲一', '待补全文章甲二', '本地阅读样本']],
  ['本地测试乙号', 'MzA5MTIzNDU2Nw==', ['待补全文章乙一']],
]) {
  const account = app.archive.store.upsertAccount(biz, name);
  for (const title of titles) {
    const mid = String(1000 + records.length);
    const url = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=${mid}&idx=1&sn=fixture&chksm=fixture`;
    const complete = title === '本地阅读样本';
    const article = app.archive.store.upsertArticle({ accountId: account.id, biz, mid, idx: '1', title, url,
      publishedAt: '2026-10-24 08:00', status: complete ? 'complete' : 'partial', imageCount: complete ? 1 : 2, textLength: 6,
      blocks: [{ type: 'text', text: '本地测试正文' }, { type: 'image', seq: 1 }, ...complete ? [] : [{ type: 'image', seq: 2 }]],
    });
    const src = `https://mmbiz.qpic.cn/fixture/${mid}/1/0`;
    await app.archive.saveImage(article.id, { seq: 1, src, status: 'pending' }, image, 'gif', 'image/gif', sha256);
    if (!complete) app.archive.store.saveAsset(article.id, { seq: 2, src: `https://mmbiz.qpic.cn/fixture/${mid}/2/0`, status: 'failed' });
    records.push({ ...article, accountName: name });
  }
}
await app.listen({ host: '127.0.0.1', port: 0 });
const address = app.server.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ executablePath, headless: true });
let page;
let passed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], external = [], requests = [];
  await context.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.hostname); return route.abort(); }
    if (url.pathname === '/api/jobs' && request.method() === 'POST') {
      const payload = request.postDataJSON(); requests.push(payload);
      if (requests.length === 2) return route.fulfill({ status: 409, json: { error: '第二组暂未建立，请保留选择后重试。' } });
    }
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#jobs`);
  await page.getByRole('heading', { name: /任务|进度/ }).first().waitFor();
  const skip = page.getByRole('button', { name: '跳到主内容', exact: true });
  await skip.focus(); await page.keyboard.press('Enter');
  assert.equal(new URL(page.url()).hash, '#jobs', 'Skip navigation must preserve the active route.');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content');
  await page.getByRole('button', { name: '文章目录', exact: true }).click();
  const downloadedRow = page.getByRole('row').filter({ hasText: '本地阅读样本' });
  await downloadedRow.waitFor();
  assert.equal(await downloadedRow.locator('.downloaded-marker').count(), 1, 'A saved article needs a static completed mark, not an empty disabled checkbox.');
  assert.equal(await downloadedRow.getByRole('checkbox').count(), 0);
  const selectionCenters = await page.locator('.article-table-wrap').evaluate(table => [...table.querySelectorAll('.checkbox-cell>[data-slot=checkbox], .downloaded-marker')].map(element => {
    const box = element.getBoundingClientRect(); return (box.left + box.right) / 2;
  }));
  assert.ok(selectionCenters.every(value => Math.abs(value - selectionCenters[0]) <= 1), 'Checkboxes and completed markers must share one selection-column alignment.');
  assert.equal(await downloadedRow.getByRole('button', { name: '查看图集《本地阅读样本》', exact: true }).count(), 1);
  assert.equal(await page.locator('.article-action-col').count(), 0, 'The duplicate open-arrow column must be removed.');
  await mkdir('data/desktop-verification/frontend', { recursive: true });
  await page.screenshot({ path: 'data/desktop-verification/frontend/catalogue-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'data/desktop-verification/frontend/catalogue-mobile.png' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const firstAccount = records.find(record => record.title === '待补全文章甲一').accountId;
  await page.getByRole('combobox', { name: '筛选公众号', exact: true }).click();
  await page.getByRole('option', { name: '本地测试甲号', exact: true }).click();
  await page.getByRole('button', { name: '采集任务', exact: true }).click();
  await page.getByRole('button', { name: '文章目录', exact: true }).click();
  assert.equal(await page.getByRole('combobox', { name: '筛选公众号', exact: true }).innerText(), '本地测试甲号', 'Account filter must survive ordinary page navigation.');
  await page.getByRole('combobox', { name: '筛选公众号', exact: true }).click();
  await page.getByRole('option', { name: '全部公众号', exact: true }).click();
  await page.getByRole('checkbox', { name: '选择 待补全文章甲一', exact: true }).check();
  await page.getByLabel('搜索文章标题').fill('乙一');
  await page.getByRole('checkbox', { name: '选择 待补全文章乙一', exact: true }).check();
  await page.getByLabel('搜索文章标题').fill('');
  await page.getByRole('checkbox', { name: '选择 待补全文章甲二', exact: true }).waitFor();
  assert.equal(await page.getByRole('checkbox', { name: '选择 待补全文章甲二', exact: true }).isChecked(), false);
  await page.getByRole('button', { name: '下载2篇', exact: true }).click();
  await page.getByRole('button', { name: '确认建立任务', exact: true }).click();
  await page.getByRole('dialog').getByText(/已建立\s*1\s*篇/).first().waitFor();
  assert.equal(requests.length, 2);
  const a = records.find(record => record.title === '待补全文章甲一');
  const b = records.find(record => record.title === '待补全文章乙一');
  assert.deepEqual(requests[0].articleIds, [a.id]); assert.deepEqual(requests[1].articleIds, [b.id]);
  await page.getByRole('button', { name: '确认建立任务', exact: true }).click();
  await page.getByRole('button', { name: '采集任务', exact: true }).waitFor();
  await page.waitForURL('**/#jobs');
  assert.equal(requests.length, 3); assert.deepEqual(requests[2].articleIds, [b.id]);
  await app.archive.idle();
  assert.equal(app.archive.jobs().length, 2);
  assert.equal(app.archive.article(a.id).status, 'complete'); assert.equal(app.archive.article(b.id).status, 'complete');
  assert.equal(app.archive.article(records.find(record => record.title === '待补全文章甲二').id).status, 'partial');
  assert.equal(collected.length, 2, 'Only the two missing selected images should be fetched by the mock source.');
  await page.goto(`${origin}/#reader?id=${records.find(record => record.title === '本地阅读样本').id}`);
  await page.getByRole('heading', { name: '本地阅读样本', exact: true }).waitFor();
  await page.getByRole('tab', { name: '图集', exact: true }).click();
  await page.getByRole('tab', { name: '图集', exact: true }).getAttribute('aria-selected').then(value => assert.equal(value, 'true'));
  const desktopGallery = await page.locator('.reader-gallery').evaluate(element => {
    const gallery = element.getBoundingClientRect(), toolbar = document.querySelector('.reader-mode').getBoundingClientRect();
    return { width: gallery.width, top: gallery.top, toolbarBottom: toolbar.bottom };
  });
  assert.ok(desktopGallery.width >= 300 && desktopGallery.top >= desktopGallery.toolbarBottom, 'Nova horizontal tabs must stack their panel below the tab bar.');
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  const separator = page.getByRole('separator', { name: '调整阅读目录宽度', exact: true });
  await separator.waitFor();
  const beforeWidth = await separator.evaluate(element => element.previousElementSibling.getBoundingClientRect().width);
  const beforeLayout = await page.evaluate(() => JSON.parse(localStorage.getItem('wechat-archive-ui')).state.readerLayout);
  await separator.focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(before => {
    const saved = JSON.parse(localStorage.getItem('wechat-archive-ui') || '{}').state?.readerLayout;
    return saved && Math.abs(saved.catalogue - before) > 0.05;
  }, beforeLayout.catalogue);
  const afterWidth = await separator.evaluate(element => element.previousElementSibling.getBoundingClientRect().width);
  assert.ok(Math.abs(afterWidth - beforeWidth) > 1, 'Keyboard resize must change the real panel width.');
  const savedLayout = await page.evaluate(() => JSON.parse(localStorage.getItem('wechat-archive-ui')).state.readerLayout);
  assert.ok(savedLayout.catalogue >= 15 && savedLayout.catalogue <= 60 && Math.abs(savedLayout.catalogue + savedLayout.content - 100) <= 1);
  const imageButton = page.getByRole('button', { name: '放大第 1 张图片', exact: true });
  await imageButton.click(); await page.getByRole('dialog').waitFor();
  await page.getByRole('dialog').locator('img').evaluate(element => element.decode());
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await imageButton.evaluate(element => element === document.activeElement), true, 'Closing the image dialog must restore its initiating control.');
  await imageButton.click();
  const imageDialog = page.getByRole('dialog');
  await imageDialog.getByRole('button', { name: '查看原图', exact: true }).click();
  assert.equal(await imageDialog.locator('.lightbox').getAttribute('data-original'), 'true');
  await page.evaluate(id => { location.hash = `reader?id=${id}`; }, a.id);
  await page.getByRole('heading', { name: a.title, exact: true }).waitFor();
  await imageDialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '放大第 2 张图片', exact: true }).click();
  assert.equal(await imageDialog.locator('.lightbox').getAttribute('data-original'), 'false', 'Changing articles must clear the previous image and its size mode.');
  await page.keyboard.press('Escape'); await imageDialog.waitFor({ state: 'hidden' });
  await page.locator('.reader-catalogue').getByRole('button', { name: /本地阅读样本/ }).click();
  await page.getByRole('heading', { name: '本地阅读样本', exact: true }).waitFor();
  await page.reload(); await page.getByRole('heading', { name: '本地阅读样本', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab', { name: '图集', exact: true }).getAttribute('aria-selected'), 'true');
  const restoredLayout = await page.evaluate(() => JSON.parse(localStorage.getItem('wechat-archive-ui')).state.readerLayout);
  assert.ok(Math.abs(restoredLayout.catalogue - savedLayout.catalogue) < 0.1, 'Reader panel preference must survive reload.');
  await page.screenshot({ path: 'data/ui-verification/regression-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('separator', { name: '调整阅读目录宽度', exact: true }).waitFor({ state: 'hidden' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const mobileGallery = await page.locator('.reader-gallery').evaluate(element => ({
    width: element.getBoundingClientRect().width,
    columns: getComputedStyle(element).gridTemplateColumns.split(' ').length,
    imageWidth: element.querySelector('img').getBoundingClientRect().width,
  }));
  assert.ok(mobileGallery.width >= 260 && mobileGallery.columns === 2 && mobileGallery.imageWidth >= 120, `Mobile gallery must have two readable columns: ${JSON.stringify(mobileGallery)}`);
  await page.screenshot({ path: 'data/ui-verification/regression-mobile.png' });
  assert.deepEqual(errors, []);
  assert.ok(external.every(host => host === 'me.kis.v2.scr.kaspersky-labs.com'), `Unexpected browser network: ${external.join(', ')}`);

  const raceContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let releaseOld, markHeld, markDelivered, accountReads = 0;
  const held = new Promise(done => { markHeld = done; });
  const release = new Promise(done => { releaseOld = done; });
  const delivered = new Promise(done => { markDelivered = done; });
  await raceContext.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/accounts' && request.method() === 'GET' && ++accountReads === 1) {
      const response = await route.fetch(), snapshot = await response.json();
      snapshot[0].name = '过期轮询快照'; markHeld(); await release;
      await route.fulfill({ response, json: snapshot }); markDelivered(); return;
    }
    return route.continue();
  });
  const racePage = await raceContext.newPage(); racePage.setDefaultTimeout(10000);
  await racePage.goto(`${origin}/#accounts`); await held;
  await racePage.getByRole('button', { name: '采集任务', exact: true }).click();
  const fresh = racePage.waitForResponse(response => response.url() === `${origin}/api/accounts` && response.ok());
  await racePage.getByRole('button', { name: '刷新进度', exact: true }).click(); await fresh;
  releaseOld(); await delivered;
  await racePage.getByRole('button', { name: '公众号', exact: true }).click();
  await racePage.getByRole('button', { name: '本地测试乙号', exact: true }).waitFor();
  assert.equal(await racePage.getByRole('button', { name: '过期轮询快照', exact: true }).count(), 0, 'An older poll response must not replace a newer refresh.');
  await raceContext.close();
  const reviewFailures = [], review = { mobile: [], table: [], reader: [] };
  const longTitle = '用于窄屏检查的很长文章标题'.repeat(5) + 'LongUnbrokenTitleForMobileLayout';
  const fixture = app.archive.article(records.find(record => record.title === '待补全文章甲二').id);
  const catalogueRoute = url => url.pathname === '/api/articles/page' && url.searchParams.get('status') !== 'complete';
  let catalogueItems = [{ ...fixture, title: longTitle }];
  await page.route(catalogueRoute, route => route.fulfill({ json: { items: catalogueItems, total: catalogueItems.length, page: 1, pageSize: 50 } }));
  for (const width of [320, 390, 1440, 1905]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${origin}/#articles`);
    const title = page.getByRole('button', { name: longTitle, exact: true });
    await title.waitFor();
    const geometry = await page.locator('[data-slot=table-container]').evaluate(container => {
      const table = container.querySelector('table'), cells = [...table.querySelector('tbody tr').children];
      const visible = cells.filter(cell => getComputedStyle(cell).display !== 'none');
      return { width: container.clientWidth, scrollWidth: container.scrollWidth,
        visibleCells: visible.length, titleWidth: cells[1].getBoundingClientRect().width,
        statusRight: visible.find(cell => cell.querySelector('.article-state')).getBoundingClientRect().right,
        right: container.getBoundingClientRect().right,
        alignment: ['date-col', 'image-col', 'article-status-col'].flatMap(column => {
          const header = table.querySelector(`thead .${column}`), cell = table.querySelector(`tbody .${column}`);
          if (getComputedStyle(header).display === 'none') return [];
          const headerRange = document.createRange(); headerRange.selectNodeContents(header);
          const headerBox = headerRange.getBoundingClientRect();
          const bodyRange = document.createRange(); bodyRange.selectNodeContents(cell);
          const bodyBox = column === 'article-status-col' ? cell.querySelector('.article-state').getBoundingClientRect() : bodyRange.getBoundingClientRect();
          return [{ column, difference: Math.abs((headerBox.left + headerBox.right - bodyBox.left - bodyBox.right) / 2) }];
        }) };
    });
    review.mobile.push({ viewport: width, ...geometry });
    assert.ok(geometry.alignment.every(item => item.difference <= 1), `Header and body alignment must match: ${JSON.stringify(geometry.alignment)}`);
    if (width < 560 && geometry.scrollWidth > geometry.width + 1) reviewFailures.push(`${width}px catalogue scrolls horizontally: ${JSON.stringify(geometry)}`);
    if (width < 560 && geometry.statusRight > geometry.right + 1) reviewFailures.push(`${width}px catalogue status is outside the visible table`);
    assert.ok(geometry.titleWidth >= 120, 'The article title needs readable space.');
    assert.equal(await page.getByRole('checkbox', { name: `选择 ${longTitle}`, exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: `打开 ${longTitle}`, exact: true }).count(), 0);
    assert.equal(geometry.visibleCells, width >= 1440 ? 5 : 3);
    await mkdir('data/expert-review-20261024', { recursive: true });
    await page.screenshot({ path: `data/expert-review-20261024/catalogue-long-title-${width}.png`, fullPage: true });
    await title.click();
    await page.getByRole('heading', { name: fixture.title, exact: true }).waitFor();
  }
  catalogueItems = [
    { status: 'complete', title: '已下载图文', imageCount: 9, savedImageCount: 9 },
    { status: 'discovered', title: '待采集图文', imageCount: 0, savedImageCount: 0 },
    { status: 'partial', title: '需要补全图文', imageCount: 123, savedImageCount: 1 },
    { status: 'unavailable', title: '不可访问图文', imageCount: 0, savedImageCount: 0 },
    { status: 'downloading', title: '采集中的图文', imageCount: 12, savedImageCount: 11 },
  ].map((values, index) => ({ ...fixture, ...values, id: `alignment-${index}`, coverUrl: undefined }));
  await mkdir('data/title-table-verification', { recursive: true });
  await mkdir('data/workflow-verification/selection', { recursive: true });
  for (const width of [320, 390, 1440, 1905]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${origin}/#articles`);
    await page.getByRole('button', { name: '已下载图文', exact: true }).waitFor();
    const headerSelection = page.getByRole('checkbox', { name: '选择当前页所有待采集文章', exact: true });
    if (width === 320) {
      assert.equal(await headerSelection.getAttribute('aria-checked'), 'false');
      await page.getByRole('checkbox', { name: '选择 待采集图文', exact: true }).check();
      assert.equal(await headerSelection.getAttribute('aria-checked'), 'mixed', 'Part of the current eligible page must show a mixed checkbox.');
      assert.notEqual(await headerSelection.getAttribute('data-indeterminate'), null);
      assert.equal(await headerSelection.locator('[data-slot=checkbox-indicator] svg').isVisible(), true);
      await assertSelectionScope(page, 1, 1, 0);
      await headerSelection.focus(); await page.keyboard.press('Space');
      assert.equal(await headerSelection.getAttribute('aria-checked'), 'true', 'Space on a mixed header selects all current eligible rows.');
      for (const name of ['待采集图文', '需要补全图文', '采集中的图文']) assert.equal(await page.getByRole('checkbox', { name: `选择 ${name}`, exact: true }).isChecked(), true);
      assert.equal(await page.getByRole('row').filter({ hasText: '已下载图文' }).getByRole('checkbox').count(), 0);
      const unavailable = page.getByRole('checkbox', { name: '选择 不可访问图文', exact: true });
      assert.equal(await unavailable.isDisabled(), true); assert.equal(await unavailable.isChecked(), false);
      await assertSelectionScope(page, 3, 3, 0);
      await page.keyboard.press('Space');
      assert.equal(await headerSelection.getAttribute('aria-checked'), 'false');
      assert.equal(await page.getByRole('button', { name: '清空选择', exact: true }).count(), 0);
      await page.getByRole('checkbox', { name: '选择 待采集图文', exact: true }).check();
      await headerSelection.click();
      assert.equal(await headerSelection.getAttribute('aria-checked'), 'true', 'Mouse activation of a mixed header selects the current eligible page.');
      await headerSelection.click();
      assert.equal(await headerSelection.getAttribute('aria-checked'), 'false');
      await page.getByRole('checkbox', { name: '选择 待采集图文', exact: true }).check();
    }
    await page.getByRole('checkbox', { name: '选择 待采集图文', exact: true }).check();
    assert.equal(await headerSelection.getAttribute('aria-checked'), 'mixed', 'Each viewport must display the current-page mixed state.');
    const geometry = await page.locator('.article-table-wrap').evaluate(container => {
      const table = container.querySelector('table');
      const bounds = element => {
        if (element.classList.contains('article-status-col')) return element.querySelector('.article-state').getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(element); return range.getBoundingClientRect();
      };
      const center = box => (box.left + box.right) / 2;
      return { width: container.clientWidth, scrollWidth: container.scrollWidth,
        rows: [...table.querySelectorAll('tbody tr')].map(row => ({
          title: row.querySelector('.article-title').textContent,
          columns: ['date-col', 'image-col', 'article-status-col'].flatMap(column => {
            const header = table.querySelector(`thead .${column}`), cell = row.querySelector(`.${column}`);
            if (getComputedStyle(header).display === 'none') return [];
            const range = document.createRange(); range.selectNodeContents(header);
            const headerBox = range.getBoundingClientRect(), contentBox = bounds(cell), cellBox = cell.getBoundingClientRect();
            return [{ column, value: cell.textContent, centerDifference: Math.abs(center(headerBox) - center(contentBox)),
              verticalDifference: Math.abs((contentBox.top + contentBox.bottom - cellBox.top - cellBox.bottom) / 2) }];
          }),
        })),
      };
    });
    assert.equal(geometry.rows.length, 5);
    assert.ok(geometry.scrollWidth <= geometry.width + 1, `${width}px table must not overflow`);
    for (const row of geometry.rows) for (const column of row.columns) {
      assert.ok(column.centerDifference <= 1, `${width}px ${row.title} ${column.column} must share the header center: ${JSON.stringify(column)}`);
      assert.ok(column.verticalDifference <= 1, `${width}px ${row.title} ${column.column} must be vertically centered: ${JSON.stringify(column)}`);
    }
    review.table.push({ viewport: width, ...geometry });
    await page.screenshot({ path: `data/title-table-verification/table-${width}.png`, fullPage: true });
    await page.screenshot({ path: `data/workflow-verification/selection/mixed-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: '清空选择', exact: true }).click();
  assert.equal(await page.getByRole('checkbox', { name: '选择当前页所有待采集文章', exact: true }).getAttribute('aria-checked'), 'false');
  assert.equal(await page.locator('.selection-details').count(), 0);
  assert.equal(await page.getByRole('button', { name: '下载所选', exact: true }).isDisabled(), true);
  await page.unroute(catalogueRoute);
  const complete = app.archive.article(records.find(record => record.title === '本地阅读样本').id);
  let readerState = 'complete', imageFails = false;
  await page.route(url => url.pathname === `/api/articles/${complete.id}`, route => route.fulfill({ json: {
    ...complete, status: readerState, ...readerState === 'discovered' ? { blocks: [], assets: [], savedImageCount: 0 } : {},
    ...readerState === 'partial' ? { blocks: [...complete.blocks, { type: 'image', seq: 2 }], imageCount: 2 } : {},
  } }));
  await page.route(url => url.pathname.startsWith(`/api/assets/${complete.id}/`), route => imageFails ? route.fulfill({ status: 404 }) : route.continue());
  const repairRequests = [];
  let releaseRepair, repairReceived;
  await page.route('**/api/jobs', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    repairRequests.push(route.request().postDataJSON());
    const released = new Promise(done => { releaseRepair = done; });
    repairReceived(); await released;
    return route.fulfill({ status: 409, json: { error: '修复确认测试：尚未建立任务。' } });
  });
  for (const state of ['complete', 'discovered', 'downloading', 'partial', 'unavailable', 'complete-image-failure']) {
    readerState = state === 'complete-image-failure' ? 'complete' : state;
    imageFails = state === 'complete-image-failure';
    await page.goto(`${origin}/?review=${state}#reader?id=${complete.id}`);
    await page.getByRole('heading', { name: complete.title, exact: true }).waitFor();
    await page.getByRole('tab', { name: '正文', exact: true }).click();
    if (state === 'discovered' || state === 'partial') {
      const hint = page.locator(state === 'discovered' ? '.reader-body .reader-empty-copy' : '.reader-body .image-missing');
      assert.equal(await hint.evaluate(element => getComputedStyle(element).userSelect), 'none', 'Empty-body and missing-image hints are interface text.');
    }
    if (imageFails) {
      await page.locator('.reader-body .reader-image-button').scrollIntoViewIfNeeded();
      await page.getByText('本地图片无法读取。', { exact: true }).waitFor();
      const failedImage = page.getByRole('button', { name: '放大第 1 张图片', exact: true });
      await failedImage.click();
      const failedDialog = page.getByRole('dialog');
      await failedDialog.getByText('本地图片暂时无法读取', { exact: true }).waitFor();
      await failedDialog.getByRole('button', { name: '查看原图', exact: true }).click();
      await failedDialog.getByText('本地图片暂时无法读取', { exact: true }).waitFor();
      await page.keyboard.press('Escape'); await failedDialog.waitFor({ state: 'hidden' });
      assert.equal(await failedImage.evaluate(element => element === document.activeElement), true, 'A failed image still restores focus when closed.');
    }
    const footer = await page.locator('.reader-footer').innerText();
    const sourceLink = page.locator('.reader-footer').getByRole('link', { name: '查看原文', exact: true });
    assert.equal(await sourceLink.getAttribute('href'), complete.url);
    assert.equal(await sourceLink.getAttribute('rel'), 'noopener noreferrer');
    const expectedFooter = state === 'complete' ? '查看原文' : `${imageFails ? '本地图片无法读取' : state === 'discovered' ? '正文尚未保存到本地' : '归档尚未完整'}\n查看原文`;
    review.reader.push({ state, footer });
    if (footer.replace(/\s+/g, '') !== expectedFooter.replace(/\s+/g, '')) reviewFailures.push(`${state} reader has incorrect archive notice: ${footer}`);
    assert.equal(await page.locator('.reader-meta .status').count(), ['complete', 'complete-image-failure'].includes(state) ? 0 : 1, 'Complete articles omit the redundant saved badge; image failures remain explicit in the warning and footer.');
    assert.equal(await page.locator('.reader-warning').count(), state === 'complete' ? 0 : 1);
    assert.equal(await page.getByRole('button', { name: /检查归档|检查并补全图片/ }).count(), 0);
    const repairLabel = state === 'complete-image-failure' ? '修复图片' : state === 'partial' ? '补全内容' : state === 'discovered' ? '下载文章' : null;
    const repair = page.locator('.reader-warning button');
    assert.equal(await repair.count(), repairLabel ? 1 : 0, `${state} must expose only its contextual repair action.`);
    if (repairLabel) {
      const submitted = repairRequests.length;
      await page.getByRole('button', { name: '文章目录', exact: true }).click();
      const preserved = page.getByRole('checkbox', { name: '选择 待补全文章甲二', exact: true });
      await preserved.check();
      await page.getByRole('button', { name: complete.title, exact: true }).click();
      await page.getByRole('tab', { name: '正文', exact: true }).click();
      if (imageFails) {
        await page.locator('.reader-body .reader-image-button').scrollIntoViewIfNeeded();
        await page.getByText('本地图片无法读取。', { exact: true }).waitFor();
      }
      assert.equal(await repair.innerText(), repairLabel);
      assert.equal(await repair.isEnabled(), true);
      await repair.click();
      const confirmation = page.getByRole('dialog', { name: '采集选中的 1 篇文章', exact: true });
      await confirmation.waitFor();
      assert.equal(await confirmation.locator('.selection-review>div').count(), 1);
      assert.equal(await confirmation.locator('.selection-review strong').innerText(), '1 篇');
      assert.equal(repairRequests.length, submitted, 'Opening the single-article confirmation must not submit any job.');
      await confirmation.getByRole('button', { name: '再看一下', exact: true }).click();
      await confirmation.waitFor({ state: 'hidden' });
      assert.equal(repairRequests.length, submitted, 'Canceling repair must not submit any job.');
      await page.getByRole('button', { name: '文章目录', exact: true }).click();
      assert.equal(await preserved.isChecked(), true, 'Canceling repair must retain the previous directory selection.');
      await page.getByRole('button', { name: complete.title, exact: true }).click();
      if (imageFails) {
        await page.locator('.reader-body .reader-image-button').scrollIntoViewIfNeeded();
        await page.getByText('本地图片无法读取。', { exact: true }).waitFor();
      }
      await repair.click(); await confirmation.waitFor();
      const received = new Promise(done => { repairReceived = done; });
      await confirmation.getByRole('button', { name: '确认建立任务', exact: true }).click(); await received;
      assert.deepEqual(repairRequests.at(-1), { accountId: complete.accountId, articleIds: [complete.id] }, 'Confirmation must freeze the reader article ID, excluding the directory selection.');
      assert.equal(await repair.isDisabled(), true, 'A pending confirmation disables repeated repair.');
      assert.equal(await confirmation.getByRole('button', { name: '建立任务中…', exact: true }).isDisabled(), true);
      releaseRepair();
      await confirmation.getByText('修复确认测试：尚未建立任务。', { exact: true }).waitFor();
      await confirmation.getByRole('button', { name: '再看一下', exact: true }).click();
      await confirmation.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: '文章目录', exact: true }).click();
      assert.equal(await preserved.isChecked(), true);
    }
  }
  assert.equal(repairRequests.length, 3);
  assert.equal(app.archive.jobs().length, 2, 'Mocked repair confirmations must not create actual fixture tasks.');
  await mkdir('data/expert-review-20261024', { recursive: true });
  await writeFile('data/expert-review-20261024/ui-fixes-result.json', JSON.stringify({ review, failures: reviewFailures }, null, 2));
  assert.deepEqual(reviewFailures, [], 'Reader state claims and mobile catalogue must match actual content.');
  const avatarContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  let avatarProfileRequests = 0, avatarImageRequests = 0;
  let avatarAccount = { ...app.archive.accounts()[0], avatarSource: undefined, avatarUrl: undefined };
  await avatarContext.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/accounts') return route.fulfill({ json: [avatarAccount] });
    if (url.pathname === `/api/accounts/${avatarAccount.id}/profile`) {
      avatarProfileRequests++;
      avatarAccount = { ...avatarAccount, avatarSource: `https://mmbiz.qpic.cn/fixture/avatar/${avatarProfileRequests}/0`, avatarUrl: `/api/accounts/${avatarAccount.id}/avatar?v=${avatarProfileRequests}` };
      return route.fulfill({ json: avatarAccount });
    }
    if (url.pathname === `/api/accounts/${avatarAccount.id}/avatar`) {
      avatarImageRequests++;
      return avatarProfileRequests === 2 ? route.fulfill({ status: 404 }) : route.fulfill({ contentType: 'image/gif', body: image });
    }
    return route.continue();
  });
  const avatarPage = await avatarContext.newPage();
  avatarPage.on('pageerror', error => errors.push(error.message));
  await avatarPage.goto(`${origin}/#accounts`);
  const avatar = avatarPage.getByRole('button', { name: `更新${avatarAccount.name}的头像`, exact: true });
  await avatar.waitFor();
  assert.equal(avatarProfileRequests, 0, 'Opening a card must not fetch account metadata.');
  for (const attempt of [1, 2, 3]) {
    await avatar.click();
    if (attempt === 2) await avatar.locator('img').waitFor({ state: 'hidden' });
    else { await avatar.locator('img').waitFor(); await avatar.locator('img').evaluate(img => img.decode()); }
    const box = await avatar.boundingBox(); assert.ok(box.width === 42 && box.height === 42, 'Avatar failures must preserve the mobile square.');
  }
  assert.equal(avatarProfileRequests, 3); assert.ok(avatarImageRequests >= 3, 'Explicit profile retries and new sources must reload a failed avatar.');
  await avatarPage.screenshot({ path: 'data/expert-review-20261024/avatar-fixture-mobile.png' });
  await avatarContext.close();
  assert.deepEqual(errors, []);
  const pagingAccount = app.archive.accounts().find(account => account.name === '本地测试甲号');
  for (let index = 1; index <= 60; index++) {
    const mid = String(8000 + index);
    app.archive.store.upsertArticle({ accountId: pagingAccount.id, biz: pagingAccount.biz, mid,
      url: `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(pagingAccount.biz)}&mid=${mid}&idx=1`,
      title: `分页文章${String(index).padStart(3, '0')}`, publishedAt: '2027-01-01 12:00' });
  }
  const pagingContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const pageRequests = [];
  let discoveryPayload;
  await pagingContext.route('**/*', route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/articles/page') pageRequests.push(Object.fromEntries(url.searchParams));
    if (url.pathname === `/api/accounts/${pagingAccount.id}/discover` && request.method() === 'POST') {
      discoveryPayload = request.postDataJSON(); return route.fulfill({ status: 201, json: { id: 'scope-fixture' } });
    }
    return route.continue();
  });
  const pagingPage = await pagingContext.newPage(); pagingPage.setDefaultTimeout(10000);
  await pagingPage.goto(`${origin}/#articles`);
  await pagingPage.getByLabel('搜索文章标题').fill('分页文章');
  await pagingPage.getByRole('button', { name: '分页文章060', exact: true }).waitFor();
  await pagingPage.locator('.catalogue-summary').getByText('60 篇', { exact: true }).waitFor();
  await pagingPage.getByText('1–50 / 60 篇', { exact: true }).waitFor();
  assert.equal(await pagingPage.locator('.article-table-wrap tbody tr').count(), 50);
  await pagingPage.getByRole('checkbox', { name: '选择 分页文章060', exact: true }).check();
  const pagingHeader = pagingPage.getByRole('checkbox', { name: '选择当前页所有待采集文章', exact: true });
  assert.equal(await pagingHeader.getAttribute('aria-checked'), 'mixed');
  const selectionDetails = pagingPage.locator('.selection-details');
  assert.equal(await selectionDetails.evaluate(element => element.open), false);
  assert.equal(await selectionDetails.locator('p').isVisible(), false, 'Selection scope stays hidden until requested.');
  await selectionDetails.locator('summary').focus(); await pagingPage.keyboard.press('Space');
  assert.equal(await selectionDetails.evaluate(element => element.open), true, 'The native selection summary must expand with the keyboard.');
  await assertSelectionScope(pagingPage, 1, 1, 0);
  await pagingPage.getByRole('button', { name: '下一页', exact: true }).click();
  await pagingPage.getByText('51–60 / 60 篇', { exact: true }).waitFor();
  assert.equal(await pagingHeader.getAttribute('aria-checked'), 'false', 'Off-page selections must not make an unselected page mixed.');
  await assertSelectionScope(pagingPage, 1, 0, 1);
  await pagingPage.getByRole('checkbox', { name: '选择 分页文章010', exact: true }).check();
  assert.equal(await pagingHeader.getAttribute('aria-checked'), 'mixed');
  await assertSelectionScope(pagingPage, 2, 1, 1);
  assert.equal(await pagingPage.locator('.article-table-wrap tbody tr').count(), 10);
  await pagingPage.getByRole('button', { name: '上一页', exact: true }).click();
  await pagingPage.getByRole('checkbox', { name: '选择 分页文章060', exact: true }).waitFor();
  assert.equal(await pagingPage.getByRole('checkbox', { name: '选择 分页文章060', exact: true }).isChecked(), true);
  await pagingPage.getByRole('button', { name: '下一页', exact: true }).click();
  await pagingPage.getByText('51–60 / 60 篇', { exact: true }).waitFor();
  await pagingPage.getByLabel('搜索文章标题').fill('分页文章060');
  await pagingPage.getByText('1–1 / 1 篇', { exact: true }).waitFor();
  assert.equal(await pagingPage.getByRole('button', { name: '上一页', exact: true }).isDisabled(), true);
  assert.equal(await pagingPage.getByRole('button', { name: '下一页', exact: true }).isDisabled(), true);
  assert.ok((await pagingPage.locator('.catalogue-toolbar').innerText()).includes('已选 2 篇'), 'Filtering and paging must retain both selections.');
  assert.equal(await pagingHeader.getAttribute('aria-checked'), 'true', 'A fully selected one-row filter is checked even when another selection is outside the filter.');
  await assertSelectionScope(pagingPage, 2, 1, 1);
  assert.ok(pageRequests.some(request => request.page === '2' && request.q === '分页文章'));
  assert.equal(pageRequests.at(-1).page, '1', 'A changed filter must request the first page.');
  let releaseOldPage, markPageHeld, markPageDelivered;
  const oldPageRelease = new Promise(done => { releaseOldPage = done; });
  const oldPageHeld = new Promise(done => { markPageHeld = done; });
  const oldPageDelivered = new Promise(done => { markPageDelivered = done; });
  const heldPageRoute = url => url.pathname === '/api/articles/page' && url.searchParams.get('page') === '2' && url.searchParams.get('q') === '分页文章';
  await pagingPage.route(heldPageRoute, async route => {
    const response = await route.fetch(); markPageHeld(); await oldPageRelease;
    await route.fulfill({ response }); markPageDelivered();
  });
  await pagingPage.getByLabel('搜索文章标题').fill('分页文章');
  await pagingPage.getByText('1–50 / 60 篇', { exact: true }).waitFor();
  await pagingPage.getByRole('button', { name: '下一页', exact: true }).click(); await oldPageHeld;
  try {
    await pagingPage.getByLabel('搜索文章标题').fill('分页文章060');
    await pagingPage.getByText('1–1 / 1 篇', { exact: true }).waitFor();
  } finally { releaseOldPage(); }
  await oldPageDelivered;
  assert.equal(await pagingPage.locator('.article-table-wrap tbody tr').count(), 1, 'An older page response cannot replace a newer filter.');
  await pagingPage.getByRole('button', { name: '分页文章060', exact: true }).waitFor();
  await pagingPage.unroute(heldPageRoute);
  for (let index = 1; index <= 102; index++) {
    const mid = String(9000 + index);
    app.archive.store.upsertArticle({ accountId: pagingAccount.id, biz: pagingAccount.biz, mid,
      url: `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(pagingAccount.biz)}&mid=${mid}&idx=1`,
      title: `阅读分页${String(index).padStart(3, '0')}`, publishedAt: '2026-11-01 12:00', status: 'complete',
      blocks: [{ type: 'text', text: '离线分页阅读' }], textLength: 6 });
  }
  await pagingPage.getByRole('button', { name: '阅读室', exact: true }).click();
  await pagingPage.getByRole('heading', { name: '阅读分页001', exact: true }).waitFor();
  const completeCount = app.archive.store.articles({ status: 'complete' }).length;
  assert.equal(await pagingPage.locator('.reading-card').count(), completeCount, 'The reading library must include later summary pages.');
  assert.ok(pageRequests.some(request => request.status === 'complete' && request.page === '2'));

  const readerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const readerRecords = app.archive.store.articles({ status: 'complete' });
  const [readerFirst, readerSecond] = readerRecords;
  let readerSummary = app.archive.summary(), libraryReads = 0, holdDirectory = true, holdDetail = false, failDirectory = false;
  let releaseDirectory, directoryEntered, releaseDetail, detailEntered, detailDelivered;
  const directoryRelease = new Promise(done => { releaseDirectory = done; });
  const directoryHeld = new Promise(done => { directoryEntered = done; });
  const detailRelease = new Promise(done => { releaseDetail = done; });
  const detailHeld = new Promise(done => { detailEntered = done; });
  const detailDone = new Promise(done => { detailDelivered = done; });
  await readerContext.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/summary') return route.fulfill({ json: readerSummary });
    if (url.pathname === '/api/articles/page' && url.searchParams.get('status') === 'complete') {
      libraryReads++;
      if (holdDirectory) { holdDirectory = false; directoryEntered(); await directoryRelease; }
      if (failDirectory) { failDirectory = false; return route.fulfill({ status: 503, json: { error: '阅读目录测试失败' } }); }
      const pageNumber = Number(url.searchParams.get('page')), pageSize = Number(url.searchParams.get('pageSize'));
      return route.fulfill({ json: { items: readerRecords.slice((pageNumber - 1) * pageSize, pageNumber * pageSize), total: readerRecords.length, page: pageNumber, pageSize } });
    }
    if (url.pathname === `/api/articles/${readerFirst.id}` && holdDetail) {
      holdDetail = false; detailEntered(); await detailRelease;
      try { await route.fulfill({ json: app.archive.article(readerFirst.id) }); } catch { /* A newer article aborts this request. */ }
      finally { detailDelivered(); }
      return;
    }
    return route.continue();
  });
  const readerPage = await readerContext.newPage(); readerPage.setDefaultTimeout(10000);
  await readerPage.clock.install();
  try {
    await readerPage.goto(`${origin}/#reader?id=${readerFirst.id}`); await directoryHeld;
    await readerPage.getByRole('heading', { name: readerFirst.title, exact: true }).waitFor();
    assert.equal(libraryReads, 1, 'The current body must open before a held catalogue response.');
    await readerPage.getByText('正在读取阅读目录…', { exact: true }).waitFor();
    await readerPage.evaluate(id => { location.hash = `reader?id=${id}`; }, readerSecond.id);
    await readerPage.getByRole('heading', { name: readerSecond.title, exact: true }).waitFor();
    assert.equal(libraryReads, 1, 'Switching articles must reuse the in-flight catalogue.');
    releaseDirectory();
    await readerPage.waitForFunction(count => document.querySelectorAll('.reader-catalogue-item').length === count, readerRecords.length);
    const loadedLibraryReads = libraryReads;
    holdDetail = true;
    await readerPage.evaluate(id => { location.hash = `reader?id=${id}`; }, readerFirst.id); await detailHeld;
    await readerPage.evaluate(id => { location.hash = `reader?id=${id}`; }, readerSecond.id);
    await readerPage.getByRole('heading', { name: readerSecond.title, exact: true }).waitFor();
    releaseDetail(); await detailDone;
    assert.equal(await readerPage.locator('.reader-heading h1').innerText(), readerSecond.title, 'A superseded body response must never replace the current article.');
    assert.equal(libraryReads, loadedLibraryReads, 'Switching a loaded article must not reread all catalogue pages.');
    const added = { ...readerRecords[0], id: 'reader-newly-archived', title: '新完成的本地文章' };
    readerRecords.push(added); readerSummary = { ...readerSummary, archivedCount: readerSummary.archivedCount + 1 };
    await readerPage.clock.fastForward(4000);
    await readerPage.waitForFunction(count => document.querySelectorAll('.reader-catalogue-item').length === count, readerRecords.length);
    assert.ok(libraryReads > loadedLibraryReads, 'A changed archive summary must refresh the complete catalogue.');
    await readerPage.getByRole('heading', { name: readerSecond.title, exact: true }).waitFor();
    failDirectory = true; readerSummary = { ...readerSummary, imageCount: readerSummary.imageCount + 1 };
    await readerPage.clock.fastForward(4000);
    await readerPage.getByText('阅读目录测试失败', { exact: true }).waitFor();
    assert.equal(await readerPage.locator('.reader-heading h1').innerText(), readerSecond.title, 'A catalogue failure must not hide the current body.');
    await readerPage.getByRole('button', { name: '重新读取目录', exact: true }).click();
    await readerPage.getByText('阅读目录测试失败', { exact: true }).waitFor({ state: 'hidden' });
    await readerPage.waitForFunction(count => document.querySelectorAll('.reader-catalogue-item').length === count && !document.querySelector('.reader-catalogue-list [role=status]'), readerRecords.length);
  } finally { releaseDirectory(); releaseDetail(); await readerContext.close(); }

  await pagingPage.getByRole('button', { name: '公众号', exact: true }).click();
  await pagingPage.locator('.account-item').filter({ hasText: '本地测试甲号' }).getByRole('button', { name: '发现文章', exact: true }).click();
  await pagingPage.getByLabel('本次最多发现篇数', { exact: true }).fill('25');
  await pagingPage.getByLabel('最多检查批次', { exact: true }).fill('2');
  await pagingPage.getByRole('dialog').getByText('每批最多10条推送，可能包含多篇文章。', { exact: false }).waitFor();
  await pagingPage.getByRole('button', { name: '开始发现文章', exact: true }).click();
  await pagingPage.waitForURL('**/#jobs');
  assert.deepEqual(discoveryPayload, { maxPages: 2, maxArticles: 25 }, 'Article and batch limits must remain distinct.');
  await pagingContext.close();
  const report = { passed: true, checks: ['skip focus preserves route', 'account filter survives page navigation', 'selection survives filters', 'real checkbox and confirmation freezes IDs', 'partial group failure retains only unsubmitted selection', 'unselected article remains unchanged', 'resume reuses complete images', 'gallery tabs stack correctly', 'Escape restores initiating focus', 'reader preferences survive reload', 'keyboard panel resize changes width and persists', 'reduced motion media matched', 'mobile single panel and readable two-column gallery', 'stale poll cannot replace newer refresh', '320px and 390px catalogue needs no internal horizontal scroll and title stays clickable', 'reader footer distinguishes incomplete archives and image failures', 'reader repair actions match all six archive states', 'repair opens single-article confirmation without submission and cancellation retains selection', 'repair confirmation freezes one article ID and disables repeated submission', 'downloaded rows use static completion marks and semantic state text', 'duplicate open-arrow column removed', 'date/count/status headers and row contents align', 'real mixed checkbox supports mouse and keyboard and excludes saved or unavailable rows', 'native selection details expand by keyboard and distinguish current page from other pages and filters', '50-item paging retains cross-page selection and resets filters to page one', 'discovery article and batch limits submit independently', 'older page response cannot overwrite a changed filter', 'reader library loads all complete pages beyond 100 articles', 'body opens before a held catalogue and switching articles reuses catalogue requests', 'superseded article responses cannot replace the current body', 'archive summary changes refresh the complete catalogue', 'catalogue failures preserve the current body and offer retry'], review, mockImageRequests: collected.length, externalBlocked: external };
  await writeFile('data/ui-verification/regression-result.json', JSON.stringify(report, null, 2));
  await writeFile('data/workflow-verification/selection/browser-result.json', JSON.stringify({ passed: true, checks: report.checks.filter(check => /mixed checkbox|selection totals|cross-page selection/.test(check)) }, null, 2));
  console.log(JSON.stringify(report)); passed = true;
} catch (error) {
  if (page) await page.screenshot({ path: 'data/ui-verification/regression-failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser.close(); await app.close();
  assert.ok(resolve(temporary).startsWith(`${resolve(root, 'data')}${sep}ui-regression-`));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (!passed) console.error('UI regression failed; screenshot retained in data/ui-verification.');
}
