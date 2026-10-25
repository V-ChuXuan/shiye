// Runs the built application against an isolated, local-only archive fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

async function dragText(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  await page.evaluate(() => getSelection().removeAllRanges());
  const box = await locator.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const rect = [...range.getClientRects()].find(rect => rect.width > 6 && rect.height > 6);
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.mouse.move(box.x + 1, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 10 });
  await page.mouse.up();
  return page.evaluate(() => getSelection().toString());
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const browserPath = process.env.WECHAT_ARCHIVE_BROWSER || [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium', '/usr/bin/google-chrome',
].find(path => existsSync(path));
assert.ok(browserPath, 'Set WECHAT_ARCHIVE_BROWSER to an installed Chromium browser.');
assert.ok(existsSync('dist/server/index.js') && existsSync('dist/client/index.html'), 'Run npm run build first.');
await mkdir('data', { recursive: true });
const temporary = await mkdtemp(join(root, 'data', 'smoke-'));
const legacy = join(temporary, 'legacy');
const articleDir = join(legacy, 'sample');
await mkdir(join(articleDir, 'images'), { recursive: true });
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
// A large GIF logical screen makes natural-size scrolling observable on both viewports.
image.writeUInt16LE(1800, 6); image.writeUInt16LE(1200, 8);
const title = '离线验收文章';
const meta = {
  id: 'local-browser-fixture', biz: 'MzkzNzg5Njc2MQ==', mid: '123456', idx: '1',
  account: '离线验收号', title, publishTime: '2025-01-01 12:00',
  url: 'https://mp.weixin.qq.com/s?__biz=MzkzNzg5Njc2MQ%3D%3D&mid=123456&idx=1&sn=fixture&chksm=fixture',
  imageCount: 2, images: [1, 2].map(seq => ({ seq, src: `https://mmbiz.qpic.cn/fixture/${seq}/0`, file: `00${seq}.gif`,
    bytes: image.length, sha1: createHash('sha1').update(image).digest('hex') })),
};
const markdown = '# 离线验收文章\n\n---\n\n这是本地正文，断开外网后仍可阅读。\n\n<script>window.__sourceScriptRan = true</script>\n\n![](images/001.gif)\n\n![](images/002.gif)\n';
await writeFile(join(articleDir, 'images', '001.gif'), image);
await writeFile(join(articleDir, 'images', '002.gif'), image);
await writeFile(join(articleDir, 'meta.json'), JSON.stringify(meta));
await writeFile(join(articleDir, 'article.md'), markdown);
await writeFile(join(legacy, 'index.jsonl'), JSON.stringify({ ...meta, dir: articleDir }) + '\n');
const listener = createServer();
await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
const port = listener.address().port;
await new Promise(done => listener.close(done));
const origin = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/server/index.js'], {
  cwd: root, env: { ...process.env, PORT: String(port), WECHAT_ARCHIVE_DATA: join(temporary, 'app') },
  windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-4000); });
let browser;
let passed = false;
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await fetch(`${origin}/api/health`)).ok; } catch { /* The server is still starting. */ }
    if (ready) break;
    if (child.exitCode !== null) throw new Error(`Server stopped: ${log}`);
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(ready, `Server did not become ready: ${log}`);
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const external = [];
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'http:' && url.origin === origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    external.push(url.hostname); return route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  let popups = 0; page.on('popup', () => popups++);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByRole('heading', { name: '这里将是你的个人文库' }).waitFor();
  assert.equal(await page.title(), '拾页');
  const brand = page.getByRole('button', { name: '拾页，返回公众号', exact: true });
  await brand.waitFor();
  assert.equal(await brand.getAttribute('type'), 'button'); assert.equal(await brand.getAttribute('href'), null);
  const mark = brand.locator('img');
  await mark.evaluate(image => image.decode());
  assert.equal(await mark.getAttribute('alt'), '');
  assert.equal(Math.round((await mark.boundingBox()).width), 42);
  const iconUrl = await page.locator('link[rel="icon"]').evaluate(icon => icon.href);
  assert.equal(iconUrl, await mark.evaluate(image => image.currentSrc), 'Brand and favicon must share the same local artwork.');
  const icon = await fetch(iconUrl);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type') || '', /^image\/png/);
  assert.deepEqual([...new Uint8Array(await icon.arrayBuffer()).slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(await page.locator('.main-nav button').count(), 6);
  assert.equal(await page.locator('.sidebar a, .skip-link[href]').count(), 0, 'Internal controls must not expose link targets.');
  for (const [view, label] of [['accounts', '公众号'], ['articles', '文章目录'], ['jobs', '采集任务'], ['reader', '阅读室'], ['settings', '设置'], ['about', '关于']]) {
    const button = page.getByRole('button', { name: label, exact: true });
    assert.equal(await button.getAttribute('type'), 'button');
    assert.equal(await button.getAttribute('role'), null);
    assert.equal(await button.getAttribute('href'), null);
    for (const key of ['Enter', 'Space']) {
      const resetView = view === 'accounts' ? 'about' : 'accounts';
      await page.getByRole('button', { name: view === 'accounts' ? '关于' : '拾页，返回公众号', exact: true }).click();
      await page.waitForURL(`**/#${resetView}`);
      await button.focus(); await page.keyboard.press(key); await page.waitForURL(`**/#${view}`);
      await page.locator(`.main-nav button[data-view="${view}"][aria-current="page"]`).waitFor();
      assert.equal(await page.locator('.main-nav [aria-current="page"]').count(), 1);
    }
  }
  for (const key of ['Enter', 'Space']) {
    await page.getByRole('button', { name: '关于', exact: true }).click(); await page.waitForURL('**/#about');
    await brand.focus(); await page.keyboard.press(key); await page.waitForURL('**/#accounts');
  }
  assert.equal(await mark.evaluate(image => image.draggable), false);
  const navText = page.locator('.main-nav button[data-view="about"] > span').first();
  assert.equal(await navText.evaluate(element => getComputedStyle(element).userSelect), 'none');
  await page.evaluate(() => getSelection().removeAllRanges());
  const textBox = await navText.boundingBox();
  await page.mouse.move(textBox.x + 1, textBox.y + textBox.height / 2); await page.mouse.down();
  await page.mouse.move(textBox.x + textBox.width - 1, textBox.y + textBox.height / 2, { steps: 10 }); await page.mouse.up();
  assert.equal(await page.evaluate(() => getSelection().toString()), '', 'Dragging navigation text must not select it.');
  await page.goto(`${origin}/#jobs?probe=preserved`);
  const skip = page.getByRole('button', { name: '跳到主内容', exact: true });
  assert.equal(await skip.getAttribute('type'), 'button'); assert.equal(await skip.getAttribute('href'), null);
  for (const key of ['Enter', 'Space']) {
    await skip.focus(); await page.keyboard.press(key);
    assert.equal(new URL(page.url()).hash, '#jobs?probe=preserved');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main-content');
  }
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('heading', { name: '图片保存位置', exact: true }).waitFor();
  for (const selector of ['.page-heading h1', '.settings-panel-heading h2', '.migration-option>span:last-child']) {
    assert.equal(await dragText(page, page.locator(selector)), '', `${selector} is interface text and must not be selected.`);
  }
  const directory = page.getByLabel('正文图片保存位置', { exact: true });
  await directory.focus(); await directory.press('ControlOrMeta+A');
  assert.deepEqual(await directory.evaluate(element => [element.selectionStart, element.selectionEnd]), [0, (await directory.inputValue()).length]);
  await page.getByRole('button', { name: '关于', exact: true }).click();
  assert.match(await dragText(page, page.locator('.about-identity h2')), /拾页/);
  assert.match(await dragText(page, page.locator('.about-version')), /版本/);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.settings-advanced > summary').click();
  await page.getByRole('button', { name: '迁移旧版资料', exact: true }).click();
  await page.getByLabel('旧归档文件夹', { exact: true }).fill(legacy);
  await page.getByLabel('本次最多迁移篇数').fill('1');
  await page.getByRole('button', { name: '开始迁移', exact: true }).click();
  await page.getByRole('button', { name: '去阅读室', exact: true }).waitFor();
  const accounts = await (await fetch(`${origin}/api/accounts`)).json();
  const articles = await (await fetch(`${origin}/api/articles`)).json();
  assert.equal(accounts.length, 1); assert.equal(articles.length, 1);
  assert.equal(articles[0].status, 'complete');
  assert.equal(await readFile(join(articleDir, 'article.md'), 'utf8'), markdown, 'Import must preserve original files.');
  await page.getByRole('button', { name: '去阅读室', exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.locator('.reader-body img').first().evaluate(image => image.decode());
  assert.equal(await page.locator('.reader-meta .status').count(), 0);
  assert.equal(await page.locator('.reader-footer > span').count(), 0);
  assert.equal(await page.locator('.reader-footer').innerText(), '查看原文');
  assert.equal(await page.locator('.reader-toolbar').innerText(), '返回目录');
  assert.equal(await page.getByRole('button', { name: /检查归档|修复图片|补全内容|下载文章/ }).count(), 0);
  for (const selector of ['.reader-meta time', '.reader-meta>span']) {
    assert.equal(await dragText(page, page.locator(selector)), '', 'Reader dates and image counts must not be selected.');
  }
  assert.match(await dragText(page, page.locator('.reader-heading h1')), /离线验收文章/);
  assert.match(await dragText(page, page.locator('.reader-account')), /离线验收号/);
  assert.equal(new URL(page.url()).hash, `#reader?id=${articles[0].id}`, 'Dragging the author must preserve the reader.');
  await page.locator('.reader-account').focus(); await page.keyboard.press('Enter');
  await page.waitForURL(`**/#articles?accountId=${accounts[0].id}`);
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__sourceScriptRan), undefined);
  assert.ok(await page.getByText('这是本地正文，断开外网后仍可阅读。', { exact: false }).isVisible());
  const paragraph = page.locator('.reader-body p').filter({ hasText: '这是本地正文，断开外网后仍可阅读。' });
  assert.notEqual(await paragraph.evaluate(element => getComputedStyle(element).userSelect), 'none');
  await paragraph.click({ position: { x: 20, y: 12 }, clickCount: 3 });
  assert.match(await page.evaluate(() => getSelection().toString()), /这是本地正文/);
  assert.equal(await dragText(page, page.locator('.reader-body figcaption').first()), '', 'Image sequence captions must not be selected.');
  await page.getByRole('tab', { name: '图集', exact: true }).click();
  await page.getByRole('button', { name: '放大第 1 张图片', exact: true }).click();
  await page.getByRole('dialog').locator('img').evaluate(image => image.decode());
  await page.getByRole('dialog', { name: '图片 01', exact: true }).waitFor();
  assert.equal(await page.getByRole('dialog').getAttribute('aria-describedby'), null);
  assert.equal(await page.getByRole('dialog').locator('[data-slot="dialog-description"]').count(), 0);
  const dialog = page.getByRole('dialog'), lightbox = dialog.locator('.lightbox');
  assert.equal(await dialog.getByRole('link').count(), 0);
  assert.equal(await lightbox.getAttribute('data-original'), 'false');
  const original = dialog.getByRole('button', { name: '查看原图', exact: true });
  assert.equal(await original.getAttribute('aria-pressed'), 'false');
  await original.focus(); await page.keyboard.press('Space');
  assert.equal(await dialog.getByRole('button', { name: '适应窗口', exact: true }).getAttribute('aria-pressed'), 'true');
  const natural = await lightbox.evaluate(element => {
    const image = element.querySelector('img'), box = image.getBoundingClientRect();
    element.scrollLeft = element.scrollWidth; element.scrollTop = element.scrollHeight;
    return { width: box.width, height: box.height, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
      left: element.scrollLeft, top: element.scrollTop };
  });
  assert.equal(natural.naturalWidth, 1800); assert.equal(natural.naturalHeight, 1200);
  assert.equal(natural.width, natural.naturalWidth); assert.equal(natural.height, natural.naturalHeight);
  assert.ok(natural.left > 0 && natural.top > 0, 'Original-size images must scroll inside the dialog.');
  await lightbox.evaluate(element => { element.scrollLeft = 0; element.scrollTop = 0; });
  await lightbox.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  await page.waitForFunction(() => { const element = document.querySelector('.lightbox'); return element.scrollLeft > 0 && element.scrollTop > 0; });
  await dialog.getByRole('button', { name: '适应窗口', exact: true }).click();
  assert.equal(await lightbox.getAttribute('data-original'), 'false');
  assert.ok(await lightbox.evaluate(element => {
    const box = element.querySelector('img').getBoundingClientRect(); return box.width <= element.clientWidth + 1 && box.height <= element.clientHeight + 1;
  }), 'Adapted images must fit inside the current viewing area.');
  await original.click();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '放大第 1 张图片', exact: true }).evaluate(element => element === document.activeElement), true);
  await page.getByRole('button', { name: '放大第 1 张图片', exact: true }).click();
  assert.equal(await lightbox.getAttribute('data-original'), 'false', 'Reopening resets original-size mode.');
  await original.click(); await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '放大第 2 张图片', exact: true }).click();
  await dialog.locator('img').evaluate(image => image.decode());
  assert.equal(await lightbox.getAttribute('data-original'), 'false', 'A different image starts in adapted mode.');
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(context.pages().length, 1); assert.equal(popups, 0, 'Image controls must stay in the current page.');
  await page.getByRole('button', { name: '文章目录', exact: true }).click();
  await page.getByLabel('搜索文章标题').fill('没有这个标题');
  await page.getByRole('heading', { name: '没有匹配的文章' }).waitFor();
  await page.getByLabel('搜索文章标题').fill('离线验收');
  const search = page.getByLabel('搜索文章标题'); await search.press('ControlOrMeta+A');
  assert.deepEqual(await search.evaluate(element => [element.selectionStart, element.selectionEnd]), [0, '离线验收'.length]);
  await page.getByRole('button', { name: title, exact: true }).waitFor();
  assert.match(await dragText(page, page.locator('.article-title')), /离线验收文章/);
  assert.match(await dragText(page, page.locator('.article-account')), /离线验收号/);
  assert.equal(new URL(page.url()).hash, '#articles', 'Dragging the article title must preserve the directory.');
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.getByRole('button', { name: '文章目录', exact: true }).click();
  const accountRoute = url => url.pathname === '/api/accounts';
  await page.route(accountRoute, route => route.fulfill({ json: [...accounts, { ...accounts[0], id: 'selection-fixture', name: '选区测试号', lastCheckedAt: '2026-10-24T00:00:00Z' }] }));
  await page.goto(`${origin}/#accounts`);
  await page.locator('.library-summary').waitFor();
  for (const selector of ['.page-heading h1', '.library-summary>span', '.account-metadata>span', '.account-coverage p', '.schedule>summary', '.page-tip p']) {
    assert.equal(await dragText(page, page.locator(selector).first()), '', `${selector} must not create a text selection.`);
  }
  const lastCheck = page.locator('#account-selection-fixture .account-last-check');
  await lastCheck.locator('summary').focus(); await page.keyboard.press('Space');
  assert.equal(await lastCheck.evaluate(element => element.open), true);
  assert.equal(await dragText(page, lastCheck.locator('time')), '');
  assert.match(await dragText(page, page.locator('.account-name').first()), /离线验收号/);
  assert.equal(new URL(page.url()).hash, '#accounts', 'Dragging the account name must preserve the account page.');
  await page.unroute(accountRoute);
  await page.reload();
  await page.getByRole('button', { name: '公众号', exact: true }).click();
  const schedule = page.locator('.schedule');
  await schedule.locator('summary').focus(); await page.keyboard.press('Space');
  assert.equal(await schedule.evaluate(element => element.open), true, 'Update strategy remains keyboard accessible.');
  assert.equal(await dragText(page, page.locator('.schedule-form .field-hint')), '');
  await page.getByRole('combobox', { name: '更新方式', exact: true }).click();
  await page.getByRole('option', { name: '定时发现新文章', exact: true }).click();
  await page.getByLabel('检查间隔（分钟）').fill('60');
  assert.equal(await page.getByLabel('检查间隔（分钟）').evaluate(element => getComputedStyle(element).userSelect), 'text');
  assert.equal(await dragText(page, page.locator('.schedule-form label').last()), '');
  await page.getByRole('button', { name: '保存策略', exact: true }).click();
  await page.getByText('更新策略已保存。', { exact: true }).waitFor();
  assert.equal((await (await fetch(`${origin}/api/accounts`)).json())[0].updatePolicy, 'discover');
  await page.getByRole('combobox', { name: '更新方式', exact: true }).click();
  await page.getByRole('option', { name: '手动更新', exact: true }).click();
  await page.getByRole('button', { name: '保存策略', exact: true }).click();
  await page.getByRole('button', { name: '采集任务', exact: true }).click();
  await page.getByRole('heading', { name: '采集桌上还没有任务' }).waitFor();
  const jobResponse = await fetch(`${origin}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accountId: accounts[0].id, articleIds: [articles[0].id] }) });
  assert.equal(jobResponse.status, 201);
  const job = await jobResponse.json();
  let completed;
  for (let attempt = 0; attempt < 50; attempt++) {
    completed = (await (await fetch(`${origin}/api/jobs`)).json()).find(item => item.id === job.id);
    if (completed?.status === 'completed') break;
    await new Promise(done => setTimeout(done, 100));
  }
  assert.equal(completed?.status, 'completed');
  assert.equal(completed.total, 1); assert.equal(completed.completed, 1);
  await page.getByRole('button', { name: '刷新进度', exact: true }).click();
  const completedJob = page.locator('.job-history-item').filter({ hasText: '1篇全部完整归档' });
  await completedJob.locator('summary').click();
  assert.equal(await completedJob.getByRole('progressbar').count(), 0);
  await completedJob.getByText('1篇全部完整归档', { exact: true }).waitFor();
  for (const selector of ['.page-heading h1', '.task-section h2', '.job-history-count', '.job-history-summary time', '.job-history-detail .job-message']) {
    assert.equal(await dragText(page, page.locator(selector).first()), '', `${selector} must not be selected.`);
  }
  assert.match(await dragText(page, page.locator('.job-history-title>strong')), /离线验收号/);
  await page.getByRole('button', { name: '阅读室', exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(Math.round((await mark.boundingBox()).width), 36);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Mobile page must not overflow.');
  await page.getByRole('heading', { name: title, exact: true }).click();
  await page.getByRole('tab', { name: '正文', exact: true }).click();
  await page.locator('.reader-body img').first().evaluate(image => image.decode());
  await page.getByRole('tab', { name: '图集', exact: true }).click();
  await page.getByRole('button', { name: '放大第 1 张图片', exact: true }).click();
  await dialog.locator('img').evaluate(image => image.decode());
  await original.click();
  assert.ok(await lightbox.evaluate(element => element.querySelector('img').getBoundingClientRect().width === 1800 && element.scrollWidth > element.clientWidth));
  assert.ok(await dialog.evaluate(element => { const box = element.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1; }));
  await dialog.getByRole('button', { name: '适应窗口', exact: true }).click();
  assert.ok(await lightbox.evaluate(element => element.querySelector('img').getBoundingClientRect().width <= element.clientWidth + 1));
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(context.pages().length, 1); assert.equal(popups, 0);
  const refused = await fetch(`${origin}/api/accounts`, { method: 'POST', headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(refused.status, 403);
  assert.deepEqual(errors, []);
  // This machine's antivirus injects its own script; it is blocked, never requested by the app.
  assert.ok(external.every(host => host === 'me.kis.v2.scr.kaspersky-labs.com'), `Unexpected external requests: ${external.join(', ')}`);
  const summary = await (await fetch(`${origin}/api/summary`)).json();
  assert.equal(summary.archivedCount, 1); assert.equal(summary.imageCount, 2);
  console.log(JSON.stringify({ passed: true, browser: 'Chromium', checks: ['Shiye title and accessible brand', 'shared local brand artwork and favicon PNG', 'desktop and mobile logo sizing', 'native button navigation with Enter and Space', 'navigation text drag prevention', 'selectable body and form inputs', 'interface headings and metadata reject actual drag selection', 'authors and titles retain selection without navigating', 'selected author still supports keyboard activation and titles support ordinary clicks', 'about content and saved paths remain selectable', 'empty state', 'UI import preserves originals', 'article filters', 'local reader image decode', 'safe source text', 'gallery and lightbox original/adapted sizing and reset', 'desktop and mobile image scrolling without popups', 'update policy persistence', 'offline task reuses validated images', 'mobile layout', 'Origin rejection', 'no app external browser requests'], blockedEnvironmentRequests: external }));
  passed = true;
} finally {
  await browser?.close();
  child.kill('SIGTERM');
  await Promise.race([new Promise(done => child.once('close', done)), new Promise(done => setTimeout(done, 2000))]);
  if (passed) {
    const dataRoot = resolve(root, 'data');
    assert.ok(resolve(temporary).startsWith(`${dataRoot}${sep}smoke-`));
    await rm(temporary, { recursive: true });
  } else console.error(`Browser diagnostics retained at ${temporary}`);
}
