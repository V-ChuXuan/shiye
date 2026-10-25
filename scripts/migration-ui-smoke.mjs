// Uses an isolated archive and fake folder picker, without WeChat or native windows.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createApp } from '../dist/server/app.js';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'); process.chdir(root);
const executablePath = process.env.WECHAT_ARCHIVE_BROWSER || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
assert.ok(executablePath);
const evidence = resolve('data/filter-verification/migration'); await mkdir(evidence, { recursive: true });
const temporary = await mkdtemp(join(evidence, 'fixture-')), legacy = join(temporary, 'legacy'), imageDirectory = join(temporary, 'pictures');
const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), originals = [], lines = [];
for (let index = 1; index <= 21; index++) {
  const dir = join(legacy, `article-${index}`), mid = String(12000 + index), title = `旧版资料${String(index).padStart(2, '0')}`;
  await mkdir(join(dir, 'images'), { recursive: true });
  const meta = { biz: 'MzkzNzg5Njc2MQ==', mid, idx: '1', account: '旧版迁移测试号', title, publishTime: '2026-10-24 12:00',
    url: `https://mp.weixin.qq.com/s?__biz=MzkzNzg5Njc2MQ%3D%3D&mid=${mid}&idx=1&sn=fixture`, imageCount: 1,
    images: [{ seq: 1, src: `https://mmbiz.qpic.cn/fixture/${index}/0`, file: '001.gif', bytes: image.length, sha1: createHash('sha1').update(image).digest('hex') }] };
  const files = [[join(dir, 'images/001.gif'), image], [join(dir, 'meta.json'), JSON.stringify(meta)], [join(dir, 'article.md'), [`# ${title}`, '', '---', '', '本地迁移资料，原文件保持不变。', '', '![](images/001.gif)', ''].join('\n')]];
  for (const [file, contents] of files) { await writeFile(file, contents); originals.push({ file, sha256: hash(contents) }); }
  lines.push(JSON.stringify({ ...meta, dir }));
}
const indexFile = join(legacy, 'index.jsonl'), indexText = lines.join('\n') + '\n'; await writeFile(indexFile, indexText); originals.push({ file: indexFile, sha256: hash(indexText) });
let pickerCalls = 0, sourceCalls = 0;
const forbidden = async () => { sourceCalls++; throw new Error('Migration must stay local.'); };
const source = { fetchArticle: forbidden, fetchImage: forbidden, fetchCover: forbidden, captureSession: forbidden, discoverPage: forbidden, hasSession: () => false, getGate: () => null, clearGate: () => {} };
const app = await createApp({ dataDir: join(temporary, 'app'), defaultImageDirectory: imageDirectory, source, schedulerEnabled: false,
  chooseDirectory: async () => { pickerCalls++; if (pickerCalls === 1) return null; if (pickerCalls === 2) return legacy; throw new Error('Picker fixture error'); } });
await app.listen({ host: '127.0.0.1', port: 0 }); const origin = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ executablePath, headless: true });
let passed = false, releaseImport;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const external = [], errors = [], imports = [];
  let holdImport = false, markHeld;
  const held = new Promise(done => { markHeld = done; }), pending = new Promise(done => { releaseImport = done; });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== origin) { external.push(url.hostname); return route.abort(); }
    if (url.pathname === '/api/import' && request.method() === 'POST') { imports.push(request.postDataJSON()); if (holdImport) { holdImport = false; markHeld(); await pending; } }
    return route.continue();
  });
  const page = await context.newPage(); page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
  for (const route of ['accounts', 'articles', 'reader']) {
    await page.goto(`${origin}/#${route}`);
    await page.getByRole('heading', { name: { accounts: '公众号', articles: '文章目录', reader: '阅读室' }[route], exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /导入已有归档|迁移旧版资料/ }).count(), 0); assert.equal(await page.locator('.sidebar-import').count(), 0);
  }
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.locator('.settings-panel').waitFor();
  const advanced = page.locator('.settings-advanced'), entry = page.getByRole('button', { name: '迁移旧版资料', exact: true });
  assert.equal(await advanced.evaluate(element => element.open), false); assert.equal(await entry.isVisible(), false);
  await advanced.locator('summary').focus(); await page.keyboard.press('Space'); assert.equal(await entry.isVisible(), true);
  await page.screenshot({ path: join(evidence, 'settings-advanced-desktop.png'), fullPage: true }); await entry.click();
  const dialog = page.getByRole('dialog'), folder = page.getByLabel('旧归档文件夹', { exact: true });
  await page.getByRole('heading', { name: '迁移旧版资料', exact: true }).waitFor();
  assert.equal(await dialog.locator('[data-slot=dialog-description]').count(), 0); assert.equal(await page.getByLabel('本次最多迁移篇数').inputValue(), '20');
  const chooser = dialog.getByRole('button', { name: '选择文件夹', exact: true });
  await page.waitForFunction(() => !document.querySelector('.legacy-choose-directory')?.disabled);
  const draft = join(temporary, 'draft-legacy'); await folder.fill(draft);
  let chosen = page.waitForResponse(response => response.url() === `${origin}/api/settings/choose-directory`); await chooser.click(); await chosen;
  assert.equal(await folder.inputValue(), draft);
  chosen = page.waitForResponse(response => response.url() === `${origin}/api/settings/choose-directory`); await chooser.click(); await chosen;
  await page.waitForFunction(value => document.querySelector('#legacy-directory')?.value === value, legacy);
  assert.equal(imports.length, 0); assert.equal((await (await fetch(`${origin}/api/settings`)).json()).imageDirectory, imageDirectory);
  await chooser.click(); await dialog.getByRole('alert').filter({ hasText: '无法打开系统目录选择器' }).waitFor(); assert.equal(await folder.inputValue(), legacy);
  await folder.fill('relative-invalid-path'); await dialog.getByRole('button', { name: '开始迁移', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '绝对路径' }).waitFor(); assert.equal((await (await fetch(`${origin}/api/summary`)).json()).articleCount, 0);
  await folder.fill(legacy); holdImport = true; await dialog.getByRole('button', { name: '开始迁移', exact: true }).click(); await held;
  assert.equal(await folder.isDisabled(), true); assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true); assert.equal(await dialog.getByRole('button', { name: '关闭', exact: true }).count(), 0);
  await page.keyboard.press('Escape'); assert.equal(await dialog.isVisible(), true); releaseImport();
  await dialog.getByRole('button', { name: '去阅读室', exact: true }).waitFor(); await dialog.getByRole('status').filter({ hasText: '20 篇文章' }).waitFor();
  assert.deepEqual(imports.at(-1), { path: legacy, limit: 20 });
  const summary = await (await fetch(`${origin}/api/summary`)).json(); assert.equal(summary.articleCount, 20); assert.equal(summary.archivedCount, 20); assert.equal(summary.imageCount, 20);
  assert.equal((await (await fetch(`${origin}/api/settings`)).json()).imageDirectory, imageDirectory);
  for (const original of originals) assert.equal(hash(await readFile(original.file)), original.sha256);
  await page.screenshot({ path: join(evidence, 'migration-result-desktop.png'), fullPage: true });
  await dialog.getByRole('button', { name: '去阅读室', exact: true }).click(); await page.locator('.reading-card').first().waitFor(); assert.equal(await page.locator('.reading-card').count(), 20);
  await page.route('**/api/settings', async route => { const response = await route.fetch(); return route.fulfill({ response, json: { ...await response.json(), canChooseDirectory: false } }); });
  await page.getByRole('button', { name: '设置', exact: true }).click(); await page.locator('.settings-panel').waitFor(); await advanced.locator('summary').click(); await entry.click();
  await page.waitForFunction(() => !document.querySelector('.legacy-choose-directory')); assert.equal(await folder.isEnabled(), true); await folder.fill(legacy);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' }); assert.equal(await entry.evaluate(element => document.activeElement === element), true); await page.unroute('**/api/settings');
  const layouts = [];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await entry.click(); await dialog.waitFor(); await chooser.waitFor();
    await page.screenshot({ path: join(evidence, `migration-${width}.png`), fullPage: true });
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, dialog: document.querySelector('[role=dialog]').getBoundingClientRect().toJSON() }));
    assert.ok(geometry.scrollWidth <= width + 1); assert.ok(geometry.dialog.x >= 0 && geometry.dialog.right <= width + 1); layouts.push(geometry);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  }
  assert.deepEqual(errors, []); assert.ok(external.every(host => host === 'me.kis.v2.scr.kaspersky-labs.com'), `Unexpected external request: ${external.join(', ')}`); assert.equal(sourceCalls, 0);
  const report = { passed: true, checks: ['Settings Advanced is the only legacy migration entry', 'Advanced starts collapsed and supports keyboard', 'No explanatory dialog subtitle', 'Picker cancel preserves typed path', 'Selection never imports or saves image settings', 'Picker failure keeps manual path', 'Invalid import leaves library unchanged', 'Pending import cannot close and disables controls', 'Default20 copies only20 of21 records', 'Original files and image settings unchanged', 'Unsupported picker permits manual input', 'Escape restores entry focus', '320/390px dialog fits'], pickerCalls, importRequests: imports.length, migrated: summary.articleCount, sourceCalls, originalFilesVerified: originals.length, layouts };
  await writeFile(join(evidence, 'browser-result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report)); passed = true;
} finally { releaseImport?.(); await browser.close(); await app.close(); assert.ok(temporary.startsWith(`${evidence}${sep}fixture-`)); if (passed) await rm(temporary, { recursive: true, force: true, maxRetries: 5 }); }
