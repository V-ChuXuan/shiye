// Isolated reading search and connection-state fixture; no user library or WeChat.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../dist/server/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); process.chdir(root);
const evidence = resolve('data/library-polish-verification'); await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(join(evidence, 'search-'));
const executablePath = process.env.WECHAT_ARCHIVE_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(path => existsSync(path));
assert.ok(executablePath);
let sourceRequests = 0;
const sessions = new Set(), forbidden = async () => { sourceRequests++; throw new Error('No WeChat requests allowed.'); };
const app = await createApp({ dataDir: join(fixture, 'data'), defaultImageDirectory: join(fixture, 'pictures'), schedulerEnabled: false,
  source: { fetchArticle: forbidden, fetchImage: forbidden, discoverPage: forbidden, captureSession: forbidden, hasSession: biz => sessions.has(biz), getGate: () => null, clearGate: () => {} } });
const first = app.archive.store.upsertAccount('LibrarySearchA==', '阅读甲号'), second = app.archive.store.upsertAccount('LibrarySearchB==', '阅读乙号');
const records = [];
for (const [index, [account, title]] of [[first, '初见 ALPHA .[1]'], [first, '旅行 BETA'], [second, '另一篇 alpha'], [second, '雨天随记']].entries()) {
  records.push(app.archive.store.upsertArticle({ accountId: account.id, biz: account.biz, mid: String(index), idx: '1', title, url: `https://mp.weixin.qq.com/s/library-${index}`,
    publishedAt: `2026-10-${String(25 - index).padStart(2, '0')}`, status: 'complete', imageCount: 0, textLength: 10000,
    blocks: Array.from({ length: 60 }, (_, part) => ({ type: 'text', text: `${title} 本地正文第${part + 1}段。` })) }));
}
const pending = app.archive.store.upsertArticle({ accountId: first.id, biz: first.biz, title: '待采集独立选择', url: 'https://mp.weixin.qq.com/s/library-pending', publishedAt: '2026-10-20', status: 'discovered', imageCount: 0 });
await app.listen({ host: '127.0.0.1', port: 0 }); const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const errors = [], external = [], checks = [], positionRequests = []; let libraryRequests = 0;
await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) { external.push(url.hostname); return route.abort(); }
  if (url.pathname === '/api/articles/page' && url.searchParams.get('status') === 'complete') libraryRequests++;
  if (url.pathname.startsWith('/api/reading-positions/') && route.request().method() === 'PUT') positionRequests.push(route.request().postDataJSON());
  return route.continue();
});
const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
async function eventually(check) { const until = Date.now() + 10000; while (!await check()) { if (Date.now() > until) throw new Error('Library search assertion timed out.'); await new Promise(done => setTimeout(done, 25)); } }
const search = () => page.getByRole('searchbox', { name: '搜索已下载文章', exact: true });
const clear = () => page.getByRole('button', { name: '清空阅读筛选', exact: true });
async function source(label) { await page.getByRole('combobox', { name: '筛选阅读公众号', exact: true }).click(); await page.getByRole('option', { name: label, exact: true }).click(); }
const titles = () => page.locator('.reading-card h2').allTextContents();
try {
  await page.goto(`${origin}/#reader`); await page.getByRole('heading', { name: '阅读室', exact: true }).waitFor();
  await search().waitFor(); await eventually(async () => (await titles()).length === 4);
  await search().fill('  AlPhA  '); await eventually(async () => (await titles()).length === 2);
  await source('阅读甲号'); await eventually(async () => (await titles()).join() === records[0].title);
  await search().fill('.[1]'); await eventually(async () => (await titles()).join() === records[0].title);
  await search().fill('不存在'); await page.getByText('没有匹配的文章', { exact: true }).waitFor();
  assert.equal(await page.getByText('阅读室正在等第一篇文章', { exact: true }).count(), 0);
  await clear().click(); await eventually(async () => (await titles()).length === 4);
  checks.push('local title matching is trimmed, case-insensitive and literal; source uses AND; no-match differs from an empty library and clear restores all');

  await search().fill('alpha'); await source('阅读甲号');
  await page.locator('.reading-card').filter({ has: page.getByRole('heading', { name: records[0].title, exact: true }) }).click();
  await page.locator('.reader-sheet h1').filter({ hasText: records[0].title }).waitFor();
  assert.equal(await search().inputValue(), 'alpha');
  await eventually(async () => (await page.locator('.reader-catalogue-item').count()) === 1);
  await page.locator('.reader-scroll').evaluate(node => { node.dispatchEvent(new WheelEvent('wheel')); node.scrollTo({ top: 321, behavior: 'instant' }); });
  await eventually(async () => (await page.locator('.reader-scroll').evaluate(node => node.scrollTop)) === 321);
  await eventually(async () => (await (await fetch(`${origin}/api/reading-positions/${records[0].id}`)).json()).body === 321);
  await page.locator('.reader-sheet').evaluate(node => { window.__searchSheet = node; });
  const beforeSearchRequests = libraryRequests;
  await search().fill('BETA'); await eventually(async () => (await page.locator('.reader-catalogue-item').allTextContents()).join().includes(records[1].title));
  assert.equal(await page.locator('.reader-sheet h1').innerText(), records[0].title);
  assert.equal(await page.locator('.reader-sheet').evaluate(node => node === window.__searchSheet), true, 'Filtering cannot remount the current body.');
  assert.equal(await page.locator('.reader-scroll').evaluate(node => node.scrollTop), 321);
  assert.equal(libraryRequests, beforeSearchRequests, 'Local filtering must not refetch the library.');
  await search().fill('无匹配'); await page.getByText('没有匹配的文章', { exact: true }).waitFor();
  assert.equal(await page.locator('.reader-sheet h1').innerText(), records[0].title);
  // Activate without Playwright first scrolling the old body to reveal its offscreen tab.
  await page.getByRole('tab', { name: '图集', exact: true }).evaluate(node => node.click());
  await search().fill('BETA');
  assert.equal(await page.getByRole('tab', { name: '图集', exact: true }).getAttribute('aria-selected'), 'true');
  assert.equal((await (await fetch(`${origin}/api/reading-positions/${records[0].id}`)).json()).body, 321);
  await clear().click(); await eventually(async () => (await page.locator('.reader-catalogue-item').count()) === 4);
  await page.getByRole('tab', { name: '正文', exact: true }).click();
  await eventually(async () => (await page.locator('.reader-scroll').evaluate(node => node.scrollTop)) === 321);
  await page.screenshot({ path: join(evidence, 'library-search-catalogue.png'), fullPage: true });
  await page.getByRole('button', { name: '返回目录', exact: true }).click();
  await page.waitForURL(`${origin}/#reader`); await search().waitFor();
  assert.equal(await search().inputValue(), '');
  checks.push('reading room and wide catalogue share filters; hiding the active article preserves body DOM, mode, scroll position and library requests');

  await page.getByRole('button', { name: '文章目录', exact: true }).click();
  await page.getByRole('checkbox', { name: `选择 ${pending.title}`, exact: true }).check();
  await page.getByRole('searchbox', { name: '搜索文章标题', exact: true }).fill('待采集');
  await page.getByRole('button', { name: '阅读室', exact: true }).click(); await search().fill('BETA');
  await page.getByRole('button', { name: '文章目录', exact: true }).click();
  assert.equal(await page.getByRole('searchbox', { name: '搜索文章标题', exact: true }).inputValue(), '待采集');
  assert.equal(await page.getByRole('checkbox', { name: `选择 ${pending.title}`, exact: true }).isChecked(), true);
  await page.getByRole('button', { name: '阅读室', exact: true }).click(); assert.equal(await search().inputValue(), 'BETA');
  await page.reload(); await search().waitFor(); assert.equal(await search().inputValue(), '', 'Reading filters must not persist across reload.');
  checks.push('reading filters stay independent from article filters and selection and are not persisted');

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await search().fill('alpha'); await source('阅读乙号'); await eventually(async () => (await titles()).join() === records[2].title);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: join(evidence, `library-search-${width}.png`), fullPage: true });
    await clear().click();
  }
  await search().focus(); await page.keyboard.type('BETA'); await page.keyboard.press('Enter');
  await eventually(async () => (await titles()).join() === records[1].title);
  checks.push('keyboard input and source menus work at desktop and 390px without overflow');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '公众号', exact: true }).click();
  await page.locator(`#account-${first.id}`).getByRole('button', { name: '发现文章', exact: true }).click();
  const dialog = page.getByRole('dialog'); await dialog.locator('.connection-instruction').waitFor();
  sessions.add(first.biz);
  await eventually(async () => await dialog.locator('.connection-instruction').count() === 0);
  sessions.delete(first.biz);
  await eventually(async () => await dialog.locator('.connection-instruction').count() === 1);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  sessions.add(first.biz);
  await page.locator(`#account-${first.id}`).getByRole('button', { name: '重新连接', exact: true }).waitFor();
  await page.locator(`#account-${first.id}`).getByRole('button', { name: '发现文章', exact: true }).click();
  await dialog.getByRole('heading', { name: `发现「${first.name}」的文章`, exact: true }).waitFor();
  assert.equal(await dialog.locator('.connection-instruction').count(), 0);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  checks.push('discovery instructions follow live connection state even while its dialog remains open');

  const singleContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await singleContext.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/articles/page' && url.searchParams.get('status') === 'complete') return route.fulfill({ json: { items: [records[0]], total: 1, page: 1, pageSize: 100 } });
    return route.continue();
  });
  try {
    const singlePage = await singleContext.newPage(); await singlePage.goto(`${origin}/#reader`);
    await singlePage.getByRole('searchbox', { name: '搜索已下载文章', exact: true }).waitFor();
    assert.equal(await singlePage.getByRole('combobox', { name: '筛选阅读公众号', exact: true }).count(), 0);
    await singlePage.locator('.reading-card').click(); await singlePage.locator('.reader-sheet h1').waitFor();
    assert.equal(await singlePage.getByRole('combobox', { name: '筛选阅读公众号', exact: true }).count(), 0);
  } finally { await singleContext.close(); }
  checks.push('single-source reading room and catalogue omit redundant source selectors');

  const metadata = JSON.parse(await readFile('package.json', 'utf8')), lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
  assert.equal(metadata.version, '0.1.1'); assert.equal(lock.version, metadata.version); assert.equal(lock.packages[''].version, metadata.version);
  assert.equal((await (await fetch(`${origin}/api/about`)).json()).version, metadata.version);
  await page.getByRole('button', { name: '关于', exact: true }).click(); await page.getByText(`版本 ${metadata.version}`, { exact: true }).waitFor();
  checks.push('package, lock, API and About expose the same 0.1.1 version');
  assert.equal(sourceRequests, 0); assert.deepEqual(errors, []);
  assert.ok(external.every(host => host === 'me.kis.v2.scr.kaspersky-labs.com'), external.join(','));
  await writeFile(join(evidence, 'library-search-result.json'), JSON.stringify({ passed: true, checks, sourceRequests, libraryRequests }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, sourceRequests, libraryRequests }));
} catch (error) { console.error(JSON.stringify({ positionRequests })); await page.screenshot({ path: join(evidence, 'library-search-failure.png'), fullPage: true }).catch(() => {}); throw error; }
finally { await browser.close(); await app.close(); assert.ok(fixture.startsWith(`${evidence}${sep}search-`)); await rm(fixture, { recursive: true, force: true, maxRetries: 5 }); }
