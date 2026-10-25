// Isolated task navigation and history fixture; no real WeChat or user library.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../dist/server/app.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const evidence = resolve('data/workflow-verification/tasks');
await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(join(evidence, 'fixture-'));
const executablePath = process.env.WECHAT_ARCHIVE_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(path => existsSync(path));
assert.ok(executablePath, 'Provide an installed Chromium browser.');
const captures = [], sessions = new Set();
let failCapture = true, sourceRequests = 0;
const forbidden = async () => { sourceRequests++; throw new Error('Workflow fixtures cannot collect WeChat content.'); };
const source = { fetchArticle: forbidden, fetchImage: forbidden, fetchCover: forbidden, discoverPage: forbidden,
  captureSession: async biz => { captures.push(biz); if (failCapture) { failCapture = false; throw { code: 'network' }; } sessions.add(biz); },
  hasSession: biz => sessions.has(biz), getGate: () => null, clearGate: () => {} };
const app = await createApp({ dataDir: join(temporary, 'app'), source, schedulerEnabled: false });
const first = app.archive.store.upsertAccount('MzkzNzg5Njc2MQ==', '本地任务甲号');
const second = app.archive.store.upsertAccount('MzkzNzg5Njc2Mg==', '本地任务乙号');
const statuses = ['running', 'queued', 'paused', 'partial', 'failed', 'waiting_session', 'blocked', 'completed', 'completed'];
const records = statuses.map((status, index) => {
  const account = index % 2 ? second : first;
  const original = app.archive.store.createJob(account, index % 2 ? 'discover' : 'archive');
  return app.archive.store.saveJob({ ...original, status, total: 10, completed: status === 'completed' ? 10 : 2, failed: status === 'failed' ? 1 : 0,
    progress: status === 'completed' ? 100 : 20, message: status === 'completed' ? '任务已完成，文章和图片已保存到本地，可随时查看归档文章。'.repeat(4) : `任务详情${index + 1}`, coverage: original.kind === 'discover' ? { count: 10, complete: status === 'completed' } : undefined });
});
const waiting = records.find(job => job.status === 'waiting_session');
await app.listen({ host: '127.0.0.1', port: 0 });
const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true });
const errors = [], external = [];
let resumeRequests = 0, passed = false;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) { external.push(url.hostname); return route.abort(); }
    if (/^\/api\/jobs\/[^/]+\/resume$/.test(url.pathname)) resumeRequests++;
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#jobs`);
  await page.getByRole('heading', { name: '采集任务', exact: true }).waitFor();
  await page.locator('#active-jobs-heading').waitFor();
  const active = page.getByRole('region', { name: /^进行中/ });
  const attention = page.getByRole('region', { name: /^待处理/ });
  const completed = page.getByRole('region', { name: /^已完成/ });
  assert.equal(await active.locator('.job-item').count(), 2);
  assert.equal(await attention.locator('.job-item').count(), 5);
  assert.equal(await completed.locator('.job-history-item').count(), 2);
  assert.equal(await completed.getByRole('progressbar').count(), 0);
  assert.equal(await page.locator('.task-summary').count(), 0, 'Task groups carry the counts without a repeated summary.');
  assert.equal(await completed.locator('.status').count(), 0, 'Completed history uses its section heading instead of repeating a status badge.');
  assert.equal(await active.locator('.status').count(), 2);
  assert.equal(await attention.locator('.status').count(), 5);
  const sectionOrder = await page.locator('.task-section>h2').allTextContents();
  assert.ok(sectionOrder[0].startsWith('进行中') && sectionOrder[1].startsWith('待处理') && sectionOrder[2].startsWith('已完成'));
  const history = completed.locator('.job-history-item').first();
  assert.equal(await history.evaluate(element => element.open), false);
  await history.locator('summary').focus(); await page.keyboard.press('Space');
  assert.equal(await history.evaluate(element => element.open), true);
  await history.locator('.job-history-detail').waitFor();
  assert.equal(await history.getByRole('button', { name: '查看文章', exact: true }).isVisible(), true);
  const historyAlignment = [];
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const geometry = await history.evaluate(element => {
      const title = element.querySelector('.job-history-title');
      const message = element.querySelector('.job-message');
      const button = element.querySelector('.job-actions>button');
      const text = [...button.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      const range = document.createRange();
      range.selectNodeContents(text);
      return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
        title: title.getBoundingClientRect().x, message: message.getBoundingClientRect().x,
        actionText: range.getBoundingClientRect().x, count: element.querySelector('.job-history-count').getBoundingClientRect().x,
        date: element.querySelector('summary>time').getBoundingClientRect().x,
        messageHeight: message.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(message).lineHeight),
        buttonHeight: button.getBoundingClientRect().height };
    });
    assert.ok(Math.abs(geometry.title - geometry.message) <= 1, `History description aligns at ${width}px.`);
    assert.ok(Math.abs(geometry.title - geometry.actionText) <= 1, `History action text aligns at ${width}px.`);
    if (width <= 1000) {
      assert.ok(Math.abs(geometry.title - geometry.count) <= 1, `History count aligns at ${width}px.`);
      assert.ok(Math.abs(geometry.title - geometry.date) <= 1, `History date aligns at ${width}px.`);
      assert.ok(geometry.messageHeight > geometry.lineHeight, `Long history descriptions wrap at ${width}px.`);
    }
    assert.ok(geometry.scrollWidth <= width + 1, `History does not overflow at ${width}px.`);
    assert.ok(geometry.buttonHeight >= 32, 'History action retains its click height.');
    historyAlignment.push(geometry);
    await page.screenshot({ path: join(evidence, `history-expanded-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const refresh = page.getByRole('button', { name: '刷新进度', exact: true });
  await refresh.click();
  assert.equal(await history.evaluate(element => element.open), true, 'Polling cannot collapse an expanded history row.');
  await history.locator('summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await history.evaluate(element => element.open), false);
  await page.screenshot({ path: join(evidence, 'tasks-desktop.png'), fullPage: true });
  const historyId = await history.getAttribute('id');
  const historyJob = records.find(job => `job-${job.id}` === historyId);
  await history.locator('summary').click();
  await history.getByRole('button', { name: '查看文章', exact: true }).click();
  await page.waitForURL(`**/#articles?accountId=${historyJob.accountId}`);
  await page.goto(`${origin}/#jobs`);
  await page.getByRole('heading', { name: '采集任务', exact: true }).waitFor();

  await page.locator(`[id="job-${waiting.id}"]`).getByRole('button', { name: '前往连接微信', exact: true }).click();
  await page.waitForURL(`**/#accounts?accountId=${second.id}&fromJob=${waiting.id}`);
  const target = page.locator(`[id="account-${second.id}"]`);
  await target.locator('[aria-label="更新本地任务乙号的头像"]').waitFor();
  await page.waitForFunction(id => document.activeElement?.id === `account-${id}`, second.id);
  assert.equal(await page.locator('.account-item[data-focused=true]').count(), 1);
  assert.equal(await page.getByRole('button', { name: '返回任务', exact: true }).count(), 1);
  const add = page.getByRole('button', { name: '添加公众号', exact: true });
  await add.focus();
  const nextPoll = page.waitForResponse(response => response.url() === `${origin}/api/accounts`, { timeout: 7000 });
  await nextPoll;
  assert.equal(await add.evaluate(element => document.activeElement === element), true, 'Refresh must not steal focus back to the targeted account.');
  await target.getByRole('button', { name: '连接微信', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[role="alert"]')?.textContent?.includes('网络请求未完成'));
  assert.equal(await target.getByRole('button', { name: '返回任务', exact: true }).isVisible(), true);
  assert.deepEqual(captures, [second.biz]);
  await target.getByRole('button', { name: '连接微信', exact: true }).click();
  await target.getByRole('button', { name: '重新连接', exact: true }).waitFor();
  assert.deepEqual(captures, [second.biz, second.biz]);
  assert.equal(resumeRequests, 0); assert.equal(sourceRequests, 0);
  assert.equal(app.archive.store.job(waiting.id).status, 'waiting_session');
  await page.screenshot({ path: join(evidence, 'reconnect-desktop.png'), fullPage: true });
  await target.getByRole('button', { name: '返回任务', exact: true }).click();
  await page.waitForURL(`**/#jobs?id=${waiting.id}`);
  await page.waitForFunction(id => document.activeElement?.id === `job-${id}`, waiting.id);
  assert.equal(await page.locator('.job-item[data-focused=true]').getAttribute('id'), `job-${waiting.id}`);
  await refresh.focus();
  await page.waitForResponse(response => response.url() === `${origin}/api/jobs?scope=open`, { timeout: 7000 });
  assert.equal(await refresh.evaluate(element => document.activeElement === element), true, 'Polling must not steal focus on the task page.');
  await page.goBack();
  await page.waitForURL(`**/#accounts?accountId=${second.id}&fromJob=${waiting.id}`);
  await page.waitForFunction(id => document.activeElement?.id === `account-${id}`, second.id);
  await page.goForward(); await page.waitForURL(`**/#jobs?id=${waiting.id}`);

  for (const hash of [`accounts?accountId=missing&fromJob=${waiting.id}`, `accounts?accountId=${first.id}&fromJob=${waiting.id}`, `accounts?accountId=${second.id}&fromJob=missing`]) {
    await page.goto(`${origin}/#${hash}`);
    await page.getByRole('heading', { name: '公众号', exact: true }).waitFor();
    assert.equal(await page.locator('.account-item[data-focused=true]').count(), 0);
    assert.equal(await page.getByRole('button', { name: '返回任务', exact: true }).count(), 0);
  }
  await page.goto(`${origin}/#jobs?id=missing`);
  await page.getByRole('heading', { name: '采集任务', exact: true }).waitFor();
  assert.equal(await page.locator('[data-focused=true]').count(), 0);
  await page.goto(`${origin}/#jobs?id=${records[7].id}`);
  const focusedHistory = page.locator(`[id="job-${records[7].id}"]`);
  await page.waitForFunction(id => document.activeElement?.id === `job-${id}`, records[7].id);
  assert.equal(await focusedHistory.evaluate(element => element.open), true, 'A directly targeted completed task opens its detail.');

  sessions.clear();
  await refresh.click();
  await page.locator(`[id="job-${waiting.id}"]`).getByRole('button', { name: '前往连接微信', exact: true }).waitFor();
  const mobile = [];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`${origin}/#jobs`);
    await page.getByRole('heading', { name: '采集任务', exact: true }).waitFor();
    let geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(geometry.scrollWidth <= geometry.width + 1);
    await page.screenshot({ path: join(evidence, `tasks-${width}.png`), fullPage: true });
    await page.locator(`[id="job-${waiting.id}"]`).getByRole('button', { name: '前往连接微信', exact: true }).click();
    await page.waitForFunction(id => document.activeElement?.id === `account-${id}`, second.id);
    assert.equal(await target.getByRole('button', { name: '返回任务', exact: true }).isVisible(), true);
    geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(geometry.scrollWidth <= geometry.width + 1);
    await page.screenshot({ path: join(evidence, `reconnect-${width}.png`), fullPage: true });
    mobile.push(geometry);
  }
  let accountFixtures = [{ ...app.archive.accounts()[0], connection: 'connected', lastCheckedAt: '2026-10-24T08:00:00.000Z', coverage: { count: 2, complete: false, oldest: '2026-10-01', newest: '2026-10-24' } }];
  await page.route(url => url.pathname === '/api/accounts', route => route.fulfill({ json: accountFixtures }));
  await page.goto(`${origin}/?accountReview=single#accounts`);
  await page.getByRole('button', { name: '重新连接', exact: true }).waitFor();
  assert.equal(await page.locator('.library-summary').count(), 0, 'One account needs only its own counts.');
  assert.equal(await page.locator('.account-metadata .status').count(), 0);
  assert.equal(await page.locator('.page-tip').count(), 0, 'Connected accounts do not need the connection prerequisite reminder.');
  assert.equal(await page.getByText('历史清单为部分覆盖', { exact: true }).isVisible(), true);
  assert.equal(await page.getByText('2026-10-01 — 2026-10-24', { exact: true }).isVisible(), true);
  const lastCheck = page.locator('.account-last-check');
  assert.equal(await lastCheck.evaluate(element => element.open), false);
  assert.equal(await lastCheck.locator('time').isVisible(), false);
  await lastCheck.locator('summary').focus(); await page.keyboard.press('Enter');
  assert.equal(await lastCheck.locator('time').isVisible(), true, 'Last check is available through the native disclosure.');
  accountFixtures = app.archive.accounts().map((account, index) => ({ ...account, connection: index ? 'blocked' : 'expired', lastCheckedAt: undefined }));
  await page.goto(`${origin}/?accountReview=attention#accounts`);
  await page.getByText('需要重新连接', { exact: true }).waitFor();
  assert.equal(await page.getByText('微信访问受阻', { exact: true }).isVisible(), true);
  assert.equal(await page.locator('.library-summary').count(), 1);
  assert.equal(await page.locator('.account-last-check').count(), 0, 'Never-checked accounts must not show empty timestamps.');
  assert.equal(await page.locator('.page-tip').isVisible(), true);
  assert.ok((await page.locator('.page-tip').innerText()).includes('请在电脑微信中打开目标公众号的任意一篇文章'));
  accountFixtures = accountFixtures.map(account => ({ ...account, connection: 'connected' }));
  await page.goto(`${origin}/?accountReview=connected#accounts`);
  await page.getByRole('button', { name: '重新连接', exact: true }).first().waitFor();
  assert.equal(await page.locator('.account-metadata .status').count(), 0);
  assert.equal(await page.locator('.page-tip').count(), 0);
  assert.equal(await page.locator('.library-summary').count(), 1);
  assert.deepEqual(errors, []); assert.ok(external.every(host => host === 'me.kis.v2.scr.kaspersky-labs.com'), `Unexpected blocked external request: ${external.join(', ')}`);
  assert.equal(resumeRequests, 0); assert.equal(sourceRequests, 0);
  const report = { passed: true, checks: ['active/attention/completed task groups', 'completed tasks are compact keyboard-expandable rows with no progressbar', 'history expansion survives refresh', 'reconnect targets matching account and failed connection preserves return action', 'only requested account session captured', 'explicit return targets original job without auto-resume', 'polling never steals focus', 'browser back/forward restores context', 'unknown and mismatched route IDs stay harmless', 'direct completed-job route expands details', '320/390px task and reconnect layout', 'account prerequisite and aggregate visibility follow connection/account count', 'account last-check details are keyboard accessible and omit empty time', 'expired/blocked account warnings and historical partial coverage stay visible'], captures: captures.length, resumeRequests, sourceRequests, externalBlocked: external, mobile };
  report.historyAlignment = historyAlignment;
  report.checks.push('1440/760/390/320px expanded history text alignment, wrapping and correct account navigation');
  await writeFile(join(evidence, 'browser-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); passed = true;
} finally {
  await browser.close(); await app.close();
  assert.ok(temporary.startsWith(`${evidence}${sep}fixture-`));
  if (passed) await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
}
