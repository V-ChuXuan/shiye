// Isolated history fixture: no user library, credentials or WeChat requests.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../dist/server/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = join(root, 'data/image-jobs-verification');
await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(join(evidence, 'history-'));
const executablePath = process.env.WECHAT_ARCHIVE_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium'].find(path => existsSync(path));
assert.ok(executablePath);
let sourceRequests = 0;
const forbidden = async () => { sourceRequests++; throw new Error('No source access in history smoke.'); };
const app = await createApp({ dataDir: join(fixture, 'data'), defaultImageDirectory: join(fixture, 'pictures'), schedulerEnabled: false,
  source: { fetchArticle: forbidden, fetchImage: forbidden, discoverPage: forbidden, captureSession: forbidden, hasSession: () => false, getGate: () => null, clearGate: () => {} } });
const store = app.archive.store, account = store.upsertAccount('HistorySmoke==', '任务历史测试号');
const makeJob = index => ({ id: `completed-${index}`, accountId: account.id, accountName: account.name, kind: 'archive', status: 'completed', total: 1, completed: 1, failed: 0, progress: 100, message: `历史任务${index}`, createdAt: '2026-10-25', updatedAt: '2026-10-25' });
const insert = store.db.prepare('INSERT INTO jobs(id,account_id,data) VALUES(?,?,?)');
store.db.transaction(() => { for (let index = 0; index < 5000; index++) { const job = makeJob(index); insert.run(job.id, account.id, JSON.stringify(job)); } })();
const waiting = store.createJob(account, 'archive'); store.saveJob({ ...waiting, status: 'waiting_session', message: '请先连接微信。' });
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const historyRequests = [], openRequests = [], errors = [], external = [];
let failNext = false, holdNext = false, heldStarted, releaseHeld = () => {}, heldDone = Promise.resolve();
await context.route('**/*', async route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) { external.push(url.hostname); return route.abort(); }
  if (url.pathname === '/api/jobs') { assert.equal(url.searchParams.get('scope'), 'open', 'UI polling must never request legacy full history.'); openRequests.push(url.search); }
  if (url.pathname === '/api/jobs/history') {
    historyRequests.push(url.search);
    if (failNext) { failNext = false; return route.fulfill({ status: 503, json: { error: '历史测试暂时失败' } }); }
    if (holdNext) {
      holdNext = false;
      const response = await route.fetch();
      const held = new Promise(done => { releaseHeld = done; });
      let done; heldDone = new Promise(resolve => { done = resolve; });
      heldStarted(); await held;
      await route.fulfill({ response }); done(); return;
    }
  }
  return route.continue();
});
const page = await context.newPage(); page.setDefaultTimeout(10000);
page.on('pageerror', error => errors.push(error.message));
await page.clock.install();
async function eventually(check) { const end = Date.now() + 10000; while (!await check()) { if (Date.now() > end) throw new Error('History fixture assertion timed out'); await new Promise(done => setTimeout(done, 25)); } }
const pagination = page.getByRole('navigation', { name: '任务历史分页', exact: true });
const range = text => eventually(async () => (await pagination.innerText()).includes(text) && !await page.getByText('正在读取任务历史…', { exact: true }).count());
const hold = () => { holdNext = true; return new Promise(done => { heldStarted = done; }); };
try {
  await page.goto(`${origin}/#accounts`); await page.locator('.account-item').waitFor();
  await page.clock.fastForward(8000); await eventually(() => openRequests.length >= 2);
  assert.equal(historyRequests.length, 0, 'Other pages do not load completed history.');
  await page.getByRole('button', { name: '采集任务', exact: true }).click(); await range('1–20 / 5000 条');
  assert.equal(await page.locator('.job-history-item').count(), 20);
  assert.equal(await page.locator('.job-item').count(), 1, 'Open recovery tasks stay visible.');
  const firstHistoryReads = historyRequests.length, firstOpenReads = openRequests.length;
  await page.clock.fastForward(8000); await eventually(() => openRequests.length > firstOpenReads);
  assert.equal(historyRequests.length, firstHistoryReads, 'Ordinary progress polls do not fetch completed history.');
  await pagination.getByRole('button', { name: '下一页', exact: true }).click(); await range('21–40 / 5000 条');
  assert.equal(await page.locator('.job-history-item').first().getAttribute('id'), 'job-completed-4979');

  const held = hold(); await page.getByRole('button', { name: '刷新进度', exact: true }).click(); await held;
  await page.evaluate(() => { location.hash = 'jobs?id=completed-0'; });
  await range('4981–5000 / 5000 条');
  const focused = page.locator('#job-completed-0');
  await eventually(async () => focused.evaluate(node => node.open && document.activeElement === node));
  releaseHeld(); await heldDone; await range('4981–5000 / 5000 条');
  await pagination.getByRole('button', { name: '上一页', exact: true }).click(); await range('4961–4980 / 5000 条');
  const readsBeforePoll = historyRequests.length;
  await pagination.getByRole('button', { name: '上一页', exact: true }).focus();
  const readsBefore = openRequests.length; await page.clock.fastForward(4000); await eventually(() => openRequests.length > readsBefore);
  assert.equal(historyRequests.length, readsBeforePoll);
  assert.equal(await pagination.getByRole('button', { name: '上一页', exact: true }).evaluate(node => node === document.activeElement), true, 'Polling does not focus the old deep link again.');

  failNext = true; await page.getByRole('button', { name: '刷新进度', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '历史测试暂时失败' }).waitFor();
  assert.equal(await page.locator('.job-history-item').count(), 20, 'A failed refresh preserves the visible history.');
  assert.equal(await page.locator('.job-item').count(), 1);
  await page.getByRole('button', { name: '重试读取历史', exact: true }).click(); await range('4961–4980 / 5000 条');
  assert.equal(await page.getByRole('alert').filter({ hasText: '历史测试暂时失败' }).count(), 0);

  const short = makeJob(5000); insert.run(short.id, account.id, JSON.stringify(short));
  const beforeShort = historyRequests.length;
  await page.clock.fastForward(4000); await range('4961–4980 / 5001 条');
  assert.ok(historyRequests.length > beforeShort, 'A job born and completed between polls still refreshes the current history page.');
  assert.equal(await page.locator('.job-item').count(), 1);
  const hiddenReads = openRequests.length, hiddenHistory = historyRequests.length;
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
  await page.clock.fastForward(8000); assert.equal(openRequests.length, hiddenReads); assert.equal(historyRequests.length, hiddenHistory);
  await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: false }));

  const leavingHeld = hold(); await page.getByRole('button', { name: '刷新进度', exact: true }).click(); await leavingHeld;
  await page.getByRole('button', { name: '公众号', exact: true }).click(); releaseHeld(); await heldDone;
  const awayHistory = historyRequests.length; await page.clock.fastForward(4000); await page.locator('.account-item').waitFor();
  assert.equal(historyRequests.length, awayHistory);
  await page.getByRole('button', { name: '采集任务', exact: true }).click(); await range('1–20 / 5001 条');
  for (const id of ['completed-5000', 'completed-4999']) {
    await page.evaluate(id => { location.hash = `jobs?id=${id}`; }, id);
    await eventually(async () => page.locator(`#job-${id}`).evaluate(node => node.open && node === document.activeElement));
    await range('1–20 / 5001 条');
  }
  const keyboardRow = page.locator('.job-history-item').nth(2);
  await keyboardRow.locator('summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await keyboardRow.evaluate(node => node.open), true);
  await page.screenshot({ path: join(evidence, 'history-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, 'history-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'History fits a narrow window.');
  await pagination.getByRole('button', { name: '下一页', exact: true }).click(); await range('21–40 / 5001 条');
  assert.deepEqual(errors, []); assert.ok(external.every(host => host === 'me.kis.v2.scr.kaspersky-labs.com'), `Unexpected browser network: ${external.join(', ')}`); assert.equal(sourceRequests, 0);
  const initialContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  let releaseSummary = () => {}, initialHistoryReads = 0, holdSummary = true;
  const summaryGate = new Promise(done => { releaseSummary = done; });
  await initialContext.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/jobs/history') initialHistoryReads++;
    if (url.pathname === '/api/summary' && holdSummary) { holdSummary = false; await summaryGate; }
    return route.continue();
  });
  const initialPage = await initialContext.newPage();
  try {
    await initialPage.goto(`${origin}/#jobs`);
    await eventually(async () => (await initialPage.getByRole('navigation', { name: '任务历史分页', exact: true }).innerText()).includes('1–20 / 5001 条'));
    const initialShort = makeJob(5001); insert.run(initialShort.id, account.id, JSON.stringify(initialShort));
    releaseSummary();
    await eventually(async () => (await initialPage.getByRole('navigation', { name: '任务历史分页', exact: true }).innerText()).includes('1–20 / 5002 条'));
    assert.ok(initialHistoryReads >= 2, 'The first known summary count must reconcile history loaded before it.');
  } finally { releaseSummary(); await initialContext.close(); }
  const report = { passed: true, completedFixtureCount: 5000, checks: ['open-only polling', 'no history on other pages or unchanged polls', '20-item pages and range', 'old deep link locates page 250 once', 'same-page hash changes retain and focus the target row', 'stale response cannot replace a new focus page', 'user paging survives old deep link and polling', 'independent history error retains content and retry', 'completed count catches short jobs between polls', 'first summary count reconciles an earlier history snapshot', 'hidden page stops polling', 'late response ignored after navigation', 'keyboard accordion and narrow paging'], historyReads: historyRequests.length, openReads: openRequests.length, sourceRequests };
  await writeFile(join(evidence, 'history-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { await page.screenshot({ path: join(evidence, 'history-failure.png'), fullPage: true }).catch(() => {}); throw error; }
finally { releaseHeld(); await browser.close(); await app.close(); assert.ok(fixture.startsWith(`${evidence}${sep}history-`)); await rm(fixture, { recursive: true, force: true, maxRetries: 5 }); }
