// Uses an isolated archive and an injected folder picker; no native window or WeChat request.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
await mkdir('data/settings-verification', { recursive: true });
const temporary = await mkdtemp(join(root, 'data', 'settings-smoke-'));
const dataDir = join(temporary, 'app'), initialDirectory = join(temporary, 'initial-pictures');
const selectedDirectory = join(temporary, 'selected-pictures');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
let pickerCalls = 0, sourceCalls = 0;
const forbidden = async () => { sourceCalls++; throw new Error('Settings must not request WeChat.'); };
const source = { fetchArticle: forbidden, fetchImage: forbidden, fetchCover: forbidden,
  captureSession: forbidden, discoverPage: forbidden, hasSession: () => false, getGate: () => null, clearGate: () => {} };
const options = { dataDir, source, schedulerEnabled: false, defaultImageDirectory: initialDirectory,
  chooseDirectory: async () => ++pickerCalls === 1 ? null : selectedDirectory };
let app = await createApp(options);
const biz = 'MzkzNzg5Njc2MQ==', account = app.archive.store.upsertAccount(biz, '保存位置测试号');
const article = app.archive.store.upsertArticle({ accountId: account.id, biz, mid: '701', idx: '1', title: '迁移后仍可阅读',
  url: `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=701&idx=1&sn=fixture`,
  publishedAt: '2026-10-24 12:00', imageCount: 1, blocks: [{ type: 'image', seq: 1 }] });
await app.archive.saveImage(article.id, { seq: 1, src: 'https://mmbiz.qpic.cn/fixture/settings/640', status: 'pending' }, png, 'png', 'image/png');
app.archive.store.setArticle(article.id, { status: 'complete' });
const oldAsset = app.archive.store.storedAssets(article.id)[0];
const originalPath = await app.archive.filePath(oldAsset.file);
await app.listen({ host: '127.0.0.1', port: 0 });
let origin = `http://127.0.0.1:${app.server.address().port}`;
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
  await page.goto(`${origin}/#settings`);
  await page.getByRole('heading', { name: '设置', exact: true }).waitFor();
  const directory = page.getByLabel('正文图片保存位置', { exact: true });
  await page.waitForFunction(path => document.querySelector('#image-directory')?.value === path, initialDirectory);
  assert.equal(await directory.inputValue(), initialDirectory);
  const migrate = page.getByRole('checkbox', { name: '同时迁移已有图片', exact: true });
  const restoreDefault = page.getByRole('button', { name: '恢复默认', exact: true });
  const directoryHelp = page.locator('#directory-help');
  assert.equal(await page.locator('.storage-paths').count(), 0);
  assert.equal(await page.locator('label[for="image-directory"]').getAttribute('class'), 'sr-only');
  assert.equal(await restoreDefault.count(), 0, 'Default directory needs no reset action.');
  assert.equal(await directoryHelp.count(), 0);
  assert.equal(await directory.getAttribute('aria-describedby'), null);
  assert.equal(await migrate.getAttribute('aria-describedby'), null);
  assert.equal(await migrate.isEnabled(), true, 'Migration remains available when the path is unchanged.');
  assert.equal(await migrate.isChecked(), false);
  assert.equal(await page.getByRole('button', { name: '保存位置', exact: true }).isDisabled(), true);
  await migrate.check();
  assert.match(await directoryHelp.innerText(), /迁移.*清理.*失败.*保留原图/);
  assert.equal(await migrate.getAttribute('aria-describedby'), 'directory-help');
  assert.equal(await directory.getAttribute('aria-describedby'), 'directory-help');
  assert.equal(await page.getByRole('button', { name: '保存并迁移图片', exact: true }).isEnabled(), true);
  await migrate.uncheck();
  assert.equal(await directoryHelp.count(), 0);
  const draftDirectory = join(temporary, 'draft-pictures');
  await directory.fill(draftDirectory);
  assert.match(await directoryHelp.innerText(), /新下载.*已有图片保留在原处/);
  assert.equal(await directory.getAttribute('aria-describedby'), 'directory-help');
  await restoreDefault.click();
  assert.equal(await directory.inputValue(), initialDirectory);
  assert.equal(await restoreDefault.count(), 0);
  assert.equal(await directoryHelp.count(), 0);
  assert.equal(await page.getByRole('button', { name: '保存位置', exact: true }).isDisabled(), true);
  await directory.fill(draftDirectory);
  let chosen = page.waitForResponse(response => response.url() === `${origin}/api/settings/choose-directory`);
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click(); await chosen;
  assert.equal(await directory.inputValue(), draftDirectory, 'Cancelling the folder picker must preserve the edited path.');
  chosen = page.waitForResponse(response => response.url() === `${origin}/api/settings/choose-directory`);
  await page.getByRole('button', { name: '选择文件夹', exact: true }).click(); await chosen;
  await page.waitForFunction(path => document.querySelector('#image-directory')?.value === path, selectedDirectory);
  assert.equal((await (await fetch(`${origin}/api/settings`)).json()).imageDirectory, initialDirectory, 'Selecting a folder alone must not save settings.');
  assert.equal(existsSync(originalPath), true);
  await page.getByRole('button', { name: '保存位置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '保存位置已更新。' }).waitFor();
  assert.equal(existsSync(originalPath), true, 'Default save must keep the registered old image in place.');
  const assetUrl = `/api/assets/${article.id}/1`;
  assert.deepEqual(Buffer.from(await (await fetch(`${origin}${assetUrl}`)).arrayBuffer()), png);
  assert.equal(await migrate.isChecked(), false);
  assert.equal(await directoryHelp.count(), 0, 'A successful save clears the pending-change explanation.');
  await restoreDefault.click();
  assert.equal(await directory.inputValue(), initialDirectory);
  assert.equal(await restoreDefault.count(), 0);
  assert.match(await directoryHelp.innerText(), /新下载.*已有图片保留在原处/);
  assert.equal((await (await fetch(`${origin}/api/settings`)).json()).imageDirectory, selectedDirectory, 'Restoring the input must still require saving.');
  await page.reload(); await directory.waitFor();
  await page.waitForFunction(path => document.querySelector('#image-directory')?.value === path, selectedDirectory);
  assert.equal(await migrate.isChecked(), false, 'Reload must not opt the user into migration.');
  await migrate.check();
  await page.getByRole('button', { name: '保存并迁移图片', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '已迁移 1 张图片' }).waitFor();
  const settings = await (await fetch(`${origin}/api/settings`)).json();
  assert.equal(settings.imageDirectory, selectedDirectory);
  assert.equal(existsSync(originalPath), false, 'A verified migration should clean only its registered old image.');
  const moved = await app.archive.filePath(app.archive.store.storedAssets(article.id)[0].file);
  assert.ok(moved.startsWith(`${selectedDirectory}${sep}`));
  assert.deepEqual(await readFile(moved), png);
  assert.deepEqual(Buffer.from(await (await fetch(`${origin}${assetUrl}`)).arrayBuffer()), png, 'The original asset URL must still serve the migrated image.');
  assert.equal(await migrate.isChecked(), false, 'A completed migration must reset the optional checkbox.');
  await page.screenshot({ path: 'data/settings-verification/settings-desktop.png', fullPage: true });
  await page.reload(); await directory.waitFor();
  await page.waitForFunction(path => document.querySelector('#image-directory')?.value === path, selectedDirectory);
  await directory.fill('not-an-absolute-path');
  const refused = page.waitForResponse(response => response.url() === `${origin}/api/settings` && response.request().method() === 'PUT');
  await page.getByRole('button', { name: '保存位置', exact: true }).click();
  assert.ok((await refused).status() >= 400);
  await page.getByRole('alert').waitFor();
  assert.equal(await directory.inputValue(), 'not-an-absolute-path');
  assert.equal((await (await fetch(`${origin}/api/settings`)).json()).imageDirectory, selectedDirectory);
  assert.equal(existsSync(moved), true);
  await page.getByRole('button', { name: '关闭消息', exact: true }).click();
  await page.getByRole('button', { name: '关于', exact: true }).click();
  const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
  await page.getByRole('heading', { name: '关于拾页', exact: true }).waitFor();
  await page.getByText(`版本 ${packageInfo.version}`, { exact: true }).waitFor();
  const credits = page.locator('.about-credits');
  assert.equal(await credits.getAttribute('open'), null, 'Credits start collapsed.');
  assert.equal(await credits.getByRole('link').count(), 0);
  assert.equal(await page.locator('.about-details').count(), 0);
  await credits.locator('summary').focus(); await page.keyboard.press('Enter');
  const creditLinks = credits.getByRole('link');
  assert.equal(await creditLinks.count(), 5);
  assert.deepEqual(await creditLinks.evaluateAll(links => links.map(link => link.getAttribute('href'))), [
    'https://github.com/shadcn-ui/ui', 'https://github.com/lucide-icons/lucide', 'https://github.com/pmndrs/zustand',
    'https://github.com/motiondivision/motion', 'https://github.com/bvaughn/react-resizable-panels',
  ]);
  await page.keyboard.press('Enter'); assert.equal(await credits.getAttribute('open'), null);
  await page.locator('.about-identity img').evaluate(image => image.decode());
  await page.screenshot({ path: 'data/settings-verification/about-desktop.png', fullPage: true });
  const layouts = [];
  for (const width of [900, 1100, 1440, 2048, 2560]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const label of ['设置', '关于']) {
      await page.getByRole('button', { name: label, exact: true }).click();
      const content = page.locator(label === '设置' ? '.settings-panel' : '.about-page');
      await content.waitFor();
      const main = await page.locator('.main-area').boundingBox(), box = await content.boundingBox();
      const heading = await page.getByRole('heading', { name: label === '设置' ? '设置' : '关于拾页', exact: true }).boundingBox();
      const left = box.x - main.x, right = main.x + main.width - box.x - box.width;
      layouts.push({ width, page: label, contentWidth: box.width, left, right });
      assert.ok(Math.abs(left - right) <= 2, `${label} must be centered at ${width}px: left=${left}, right=${right}.`);
      assert.ok(Math.abs(heading.x - box.x) <= 1, 'The heading must align with the content.');
      assert.ok(box.width >= Math.min(900, main.width - 64), 'Desktop content must use the available readable width.');
    }
  }
  await mkdir('data/layout-quality-verification', { recursive: true });
  await writeFile('data/layout-quality-verification/layouts.json', JSON.stringify(layouts, null, 2));
  await page.screenshot({ path: 'data/layout-quality-verification/about-wide.png', fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    for (const label of ['设置', '关于']) {
      const button = page.getByRole('button', { name: label, exact: true });
      assert.equal(await button.isVisible(), true);
      const box = await button.boundingBox(); assert.ok(box.width >= 44 && box.height >= 44, 'Low-frequency navigation needs a usable mobile target.');
      await button.click();
      await page.getByRole('heading', { name: label === '设置' ? '设置' : '关于拾页', exact: true }).waitFor();
      await page.locator(label === '设置' ? '.settings-panel' : '.about-page').waitFor();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} must not overflow at ${width}px.`);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'data/settings-verification/about-mobile.png', fullPage: true });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await directory.waitFor(); await page.screenshot({ path: 'data/settings-verification/settings-mobile.png', fullPage: true });
  await page.goto('about:blank');
  await app.close(); app = await createApp(options); await app.listen({ host: '127.0.0.1', port: 0 });
  origin = `http://127.0.0.1:${app.server.address().port}`;
  await page.goto(`${origin}/#settings`); await directory.waitFor();
  await page.waitForFunction(path => document.querySelector('#image-directory')?.value === path, selectedDirectory);
  assert.deepEqual(Buffer.from(await (await fetch(`${origin}${assetUrl}`)).arrayBuffer()), png);
  const fresh = app.archive.article(article.id);
  assert.equal(fresh.status, 'complete'); assert.equal(fresh.savedImageCount, 1); assert.equal(fresh.imageCount, 1);
  assert.equal(app.archive.jobs().length, 0); assert.equal(pickerCalls, 2); assert.equal(sourceCalls, 0);
  assert.equal(createHash('sha256').update(await readFile(moved)).digest('hex'), createHash('sha256').update(png).digest('hex'));
  assert.deepEqual(errors, []);
  assert.ok(external.every(host => host === 'me.kis.v2.scr.kaspersky-labs.com'), `Unexpected network: ${external.join(', ')}`);
  const report = { passed: true, checks: ['one accessible path input without duplicate path list', 'reset only for a non-default draft and does not save', 'consequence hint and accessible descriptions only for pending path or migration changes', 'unchanged path still allows explicit migration', 'native picker cancel and selection via injected fixture', 'selection does not save settings', 'default save keeps old images readable without moving', 'explicit checkbox migrates old images into the current root', 'migration is unchecked after success and reload', 'existing image URL still serves exact bytes', 'invalid path preserves current root and original state', 'settings survive browser reload and service restart', 'about displays actual package version and logo', 'credits start collapsed and keyboard disclosure exposes existing dependency links', 'settings/about content is centered and aligned at 900/1100/1440/2048/2560px', 'settings/about navigation has 44px targets at 320px and 390px', 'mobile pages do not overflow', 'migration preserves complete status and asset count'], layouts, migratedImages: 1, pickerCalls, sourceCalls, externalBlocked: external };
  await writeFile('data/settings-verification/result.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report)); passed = true;
} catch (error) {
  if (page) await page.screenshot({ path: 'data/settings-verification/failure.png' }).catch(() => {});
  throw error;
} finally {
  await browser.close(); await app.close();
  assert.ok(resolve(temporary).startsWith(`${resolve(root, 'data')}${sep}settings-smoke-`));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (!passed) console.error('Settings smoke failed; screenshots remain in data/settings-verification.');
}
