// Custom filters run against a disposable local fixture, never WeChat.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../dist/server/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); process.chdir(root);
const executablePath = process.env.WECHAT_ARCHIVE_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(existsSync);
assert.ok(executablePath);
const evidence = resolve('data/filter-verification/filters'); await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(join(evidence, 'fixture-'));
let sourceRequests = 0;
const forbidden = async () => { sourceRequests++; throw new Error('Filters must not request WeChat.'); };
const app = await createApp({ dataDir: join(temporary, 'app'), schedulerEnabled: false,
  source: { fetchArticle: forbidden, fetchImage: forbidden, fetchCover: forbidden, captureSession: forbidden, discoverPage: forbidden, hasSession: () => false, getGate: () => null, clearGate: () => {} } });
const first = app.archive.store.upsertAccount('MzkzNzg5Njc2MQ==', 'Alpha 测试号');
const second = app.archive.store.upsertAccount('MzkzNzg5Njc2Mg==', 'Beta 测试号');
const records = [
  { title: '较早文章', date: '2026-10-20', status: 'discovered', account: first },
  { title: '选择保留样本', date: '2026-10-24', status: 'discovered', account: first },
  { title: '完整归档样本', date: '2026-10-24', status: 'complete', account: first },
  { title: '较新文章', date: '2026-10-25', status: 'partial', account: second },
  { title: '不可访问样本', date: '2026-10-26', status: 'unavailable', account: second },
  { title: '闰日文章', date: '2024-02-29', status: 'discovered', account: first },
];
for (const [index, record] of records.entries()) app.archive.store.upsertArticle({ accountId: record.account.id, biz: record.account.biz,
  mid: String(1000 + index), idx: '1', title: record.title, publishedAt: record.date, status: record.status,
  url: `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(record.account.biz)}&mid=${1000 + index}&idx=1&sn=fixture` });
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true });
let passed = false, page;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const errors = [], external = [], queries = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.hostname); return route.abort(); }
    if (url.pathname === '/api/articles/page') queries.push(Object.fromEntries(url.searchParams));
    return route.continue();
  });
  page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#articles`);
  await page.getByRole('checkbox', { name: '选择 选择保留样本', exact: true }).check();
  const account = page.getByRole('combobox', { name: '筛选公众号', exact: true });
  const status = page.getByRole('combobox', { name: '筛选归档状态', exact: true });
  await account.click(); await page.getByRole('listbox').waitFor();
  assert.equal(await page.getByRole('option', { name: '全部公众号', exact: true }).getAttribute('aria-selected'), 'true');
  await page.screenshot({ path: join(evidence, 'account-menu-desktop.png') });
  await page.keyboard.press('Escape'); await page.getByRole('listbox').waitFor({ state: 'hidden' });
  assert.equal(await account.evaluate(node => document.activeElement === node), true);
  await account.click(); await page.keyboard.press('b'); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '较新文章', exact: true }).waitFor();
  assert.ok((await account.innerText()).includes('Beta 测试号'));
  const selectedScope = page.locator('.selection-details');
  assert.equal(await selectedScope.locator('summary').innerText(), '已选 1 篇');
  assert.equal(await selectedScope.locator('p').isVisible(), false);
  await selectedScope.locator('summary').click();
  assert.equal(await selectedScope.locator('p').innerText(), '本页 0 篇 · 其他页或筛选外 1 篇');
  assert.equal(await selectedScope.locator('p').isVisible(), true);
  await account.click(); await page.getByRole('option', { name: '全部公众号', exact: true }).click();
  await page.getByRole('button', { name: '选择保留样本', exact: true }).waitFor();
  assert.ok((await account.innerText()).includes('全部公众号'), 'An empty-string option must remain selectable.');
  await status.click(); await page.getByRole('option', { name: '已下载', exact: true }).click();
  await page.getByRole('button', { name: '完整归档样本', exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 1);
  await status.click(); await page.getByRole('listbox').waitFor();
  await page.getByRole('option', { name: '已下载', exact: true }).focus();
  await page.keyboard.press('Home'); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '闰日文章', exact: true }).waitFor();
  assert.ok((await status.innerText()).includes('全部状态'));
  const start = page.getByRole('button', { name: '开始日期', exact: true });
  const end = page.getByRole('button', { name: '结束日期', exact: true });
  const setDate = async (label, value) => {
    await page.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('textbox', { name: `输入${label}`, exact: true }).fill(value);
    await page.getByRole('button', { name: '应用日期', exact: true }).click();
  };
  await setDate('开始日期', '2026-10-24');
  await page.getByRole('button', { name: '较新文章', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '较早文章', exact: true }).count(), 0);
  await end.click();
  const dialog = page.getByRole('dialog', { name: '结束日期', exact: true }); await dialog.waitFor();
  assert.equal(await dialog.getByRole('button', { name: '2026年10月23日', exact: true }).isDisabled(), true);
  await page.getByRole('textbox', { name: '输入结束日期', exact: true }).fill('2026-02-30');
  await page.getByRole('button', { name: '应用日期', exact: true }).click();
  await page.getByRole('alert').getByText('请输入有效日期，格式为 YYYY-MM-DD。', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '输入结束日期', exact: true }).fill('2026-10-23');
  await page.getByRole('button', { name: '应用日期', exact: true }).click();
  await page.getByRole('alert').getByText('日期超出可选范围。', { exact: true }).waitFor();
  assert.equal(queries.some(query => query.until === '2026-02-30' || query.until === '2026-10-23'), false);
  await page.getByRole('textbox', { name: '输入结束日期', exact: true }).fill('2026-10-24');
  await page.getByRole('button', { name: '应用日期', exact: true }).click();
  await page.getByRole('button', { name: '较新文章', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '选择保留样本', exact: true }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 2);
  await start.click(); await page.keyboard.press('Escape');
  assert.equal(await start.evaluate(node => document.activeElement === node), true);
  await page.getByRole('button', { name: '清空日期', exact: true }).click();
  await page.getByRole('button', { name: '闰日文章', exact: true }).waitFor();
  await setDate('开始日期', '2024-02-29');
  await start.click();
  const selectedDay = page.getByRole('button', { name: '2024年2月29日', exact: true });
  await selectedDay.hover();
  const selectedColors = await selectedDay.evaluate(node => ({ background: getComputedStyle(node).backgroundColor, color: getComputedStyle(node).color }));
  assert.deepEqual(selectedColors, { background: 'rgb(36, 91, 70)', color: 'rgb(255, 255, 255)' }, 'Hover must preserve the selected day contrast.');
  await selectedDay.focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-day') === '2024-03-01');
  await page.keyboard.press('Home'); await page.waitForFunction(() => document.activeElement?.getAttribute('data-day') === '2024-02-26');
  await page.keyboard.press('End'); await page.waitForFunction(() => document.activeElement?.getAttribute('data-day') === '2024-03-03');
  await page.keyboard.press('PageUp'); await page.waitForFunction(() => document.activeElement?.getAttribute('data-day') === '2024-02-03');
  await page.keyboard.press('PageDown'); await page.waitForFunction(() => document.activeElement?.getAttribute('data-day') === '2024-03-03');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '清空日期', exact: true }).click();
  const layouts = [];
  for (const [width, height] of [[1440, 1000], [390, 844], [320, 600]]) {
    await page.setViewportSize({ width, height });
    await status.click(); await page.getByRole('listbox').waitFor();
    const selectBox = await page.getByRole('listbox').boundingBox(); assert.ok(selectBox.x >= 0 && selectBox.x + selectBox.width <= width + 1);
    await page.screenshot({ path: join(evidence, `status-menu-${width}.png`) }); await page.keyboard.press('Escape');
    await start.click(); await page.getByRole('dialog', { name: '开始日期', exact: true }).waitFor();
    const calendarBox = await page.getByRole('dialog', { name: '开始日期', exact: true }).boundingBox();
    assert.ok(calendarBox.x >= 0 && calendarBox.x + calendarBox.width <= width + 1);
    assert.ok(calendarBox.y >= 0 && calendarBox.y + calendarBox.height <= height + 1, 'Calendar must fit short screens and scroll internally.');
    await page.getByRole('dialog', { name: '开始日期', exact: true }).getByRole('button', { name: '清空', exact: true }).scrollIntoViewIfNeeded();
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })); assert.ok(geometry.scrollWidth <= width + 1);
    await page.screenshot({ path: join(evidence, `calendar-${width}.png`) }); await page.keyboard.press('Escape');
    layouts.push({ ...geometry, selectBox, calendarBox });
  }
  assert.equal(sourceRequests, 0); assert.deepEqual(errors, []);
  assert.ok(external.every(host => host === 'me.kis.v2.scr.kaspersky-labs.com'));
  const report = { passed: true, checks: ['custom Select empty value, current mark and keyboard typeahead', 'Escape restores trigger focus', 'filters preserve selections', 'status filters still reach same API', 'custom range prevents invalid and reversed dates', 'leap day and month keyboard navigation', 'date clear restores complete catalogue', '1440/390/320px popup bounds and layout'], layouts, sourceRequests, queries };
  await writeFile(join(evidence, 'browser-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: true, checks: report.checks, sourceRequests })); passed = true;
} finally {
  if (!passed && page) await page.screenshot({ path: join(evidence, 'failure.png') }).catch(() => {});
  await browser.close(); await app.close();
  assert.ok(temporary.startsWith(`${evidence}${sep}fixture-`));
  if (passed) await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
}
