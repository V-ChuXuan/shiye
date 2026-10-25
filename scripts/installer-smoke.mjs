// Installs only a uniquely registered test build, never the production installer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright-core';
import { Store } from '../dist/server/store.js';
import { installerIdentity, packageInstaller } from './package-installer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
assert.equal(process.platform, 'win32');
const evidence = join(root, 'data/desktop-verification'); await mkdir(evidence, { recursive: true });
const fixture = await mkdtemp(join(evidence, 'installer-'));
const testId = randomUUID(), identity = installerIdentity(testId);
const target = join(fixture, '安装 中文 空格'), profile = join(fixture, 'profile');
const executable = join(target, '拾页.exe'), uninstaller = join(target, 'unins000.exe');
const library = join(target, 'library'), external = join(fixture, '外部图片');
const registration = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${identity.appId}_is1`;
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
const nextVersion = metadata.version.replace(/^(\d+)\.(\d+)\.(\d+)$/, (_match, major, minor, patch) => `${major}.${minor}.${Number(patch) + 1}`);
assert.notEqual(nextVersion, metadata.version);
const checks = [];
let application, installed = false;
function registryPresent() {
  const result = spawnSync('reg.exe', ['query', registration, '/reg:64'], { windowsHide: true, stdio: 'ignore' });
  if (result.error) throw result.error;
  return result.status === 0;
}
function powershell(script, env = {}) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${script}`],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, env: { ...process.env, ...env } });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
const programs = powershell("[Environment]::GetFolderPath('Programs')");
const desktop = powershell("[Environment]::GetFolderPath('Desktop')");
const shortcuts = [join(programs, `${identity.name}.lnk`), join(desktop, `${identity.name}.lnk`)];
const silent = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'];
function run(file, args, log, succeeds = true) {
  const result = spawnSync(file, [...args, `/LOG=${join(fixture, log)}`], { windowsHide: true, timeout: 180000, stdio: 'ignore' });
  assert.equal(result.error, undefined);
  if (succeeds) assert.equal(result.status, 0, `${log}: exit ${result.status}`);
  else assert.notEqual(result.status, 0, `${log}: an in-use application must not be changed`);
}
async function digest(file) { return createHash('sha256').update(await readFile(file)).digest('hex'); }
async function launch() {
  application = await electron.launch({ executablePath: executable, args: [`--user-data-dir=${profile}`], timeout: 30000 });
  const page = await application.firstWindow();
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.getByRole('heading', { name: '公众号', exact: true }).waitFor();
  const origin = new URL(page.url()).origin;
  const settings = await (await fetch(`${origin}/api/settings`)).json();
  assert.equal(resolve(settings.dataDirectory), join(library, 'data'));
  return { origin, settings };
}
async function quit() {
  if (!application) return;
  const closed = application.waitForEvent('close', { timeout: 30000 });
  await application.evaluate(({ app }) => { setTimeout(() => app.quit(), 10); });
  await closed; application = undefined;
  assert.equal(existsSync(join(library, 'data/.shiye-service.lock')), false);
}
async function assertShortcuts(present) {
  for (const shortcut of shortcuts) {
    assert.equal(existsSync(shortcut), present, shortcut);
    if (present) assert.equal(resolve(powershell("$link=(New-Object -ComObject WScript.Shell).CreateShortcut($env:SHIYE_TEST_SHORTCUT); [Console]::Out.Write($link.TargetPath)",
      { SHIYE_TEST_SHORTCUT: shortcut })), executable);
  }
}
assert.equal(registryPresent(), false);
for (const shortcut of shortcuts) assert.equal(existsSync(shortcut), false);
const first = await packageInstaller({ testId, outputDirectory: join(fixture, 'first') });
const upgraded = await packageInstaller({ testId, version: nextVersion, outputDirectory: join(fixture, 'upgrade') });
const installArgs = [...silent, `/DIR=${target}`, '/TASKS=desktopicon'];
try {
  run(first.executable, installArgs, 'fresh-install.log'); installed = true;
  assert.equal(registryPresent(), true); await assertShortcuts(true);
  assert.ok(existsSync(join(target, 'LICENSE.shiye')) && existsSync(join(target, 'licenses/manifest.json')));
  const initial = await launch();
  assert.equal(resolve(initial.settings.imageDirectory), join(library, 'pictures'));
  const programBefore = await digest(executable);
  run(upgraded.executable, installArgs, 'in-use-install.log', false);
  run(uninstaller, silent, 'in-use-uninstall.log', false);
  assert.equal(await digest(executable), programBefore);
  assert.equal((await fetch(`${initial.origin}/api/health`)).ok, true);
  checks.push('fresh Chinese-path install creates correct shortcuts and default install-directory/library; in-use upgrade/uninstall refuse without killing the app');
  await quit();
  assert.equal(JSON.parse(await readFile(join(profile, 'library.json'), 'utf8')).root, library);
  await mkdir(join(library, 'pictures/fixture'), { recursive: true }); await mkdir(join(external, 'fixture'), { recursive: true });
  const image = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const localImage = join(library, 'pictures/fixture/image.gif'), externalImage = join(external, 'fixture/image.gif');
  await writeFile(localImage, image); await writeFile(externalImage, image);
  const store = new Store(join(library, 'data'));
  const account = store.upsertAccount(`installer-${testId}`, '安装验收号');
  const article = store.upsertArticle({ accountId: account.id, biz: account.biz, title: '安装升级保留文章',
    url: 'https://mp.weixin.qq.com/s/installer-fixture', publishedAt: '2026-01-01', status: 'complete', imageCount: 2,
    blocks: [{ type: 'text', text: '安装、升级与卸载保留图文。' }, { type: 'image', seq: 1 }, { type: 'image', seq: 2 }] });
  for (const [seq, storageDirectory, file] of [[1, join(library, 'pictures'), 'fixture/image.gif'], [2, external, 'fixture/image.gif']])
    store.saveAsset(article.id, { seq, src: 'https://mmbiz.qpic.cn/installer-fixture/0', status: 'complete', file,
      storageDirectory, mime: 'image/gif', bytes: image.length, sha256: createHash('sha256').update(image).digest('hex') });
  store.close();
  const unknown = join(target, '自己保存的文件.txt'); await writeFile(unknown, '请保留这个用户文件。');
  const files = [join(library, 'data/archive.sqlite'), localImage, externalImage, unknown];
  const hashes = await Promise.all(files.map(digest));
  const unchanged = async () => assert.deepEqual(await Promise.all(files.map(digest)), hashes);
  run(upgraded.executable, installArgs, 'upgrade.log');
  await unchanged(); await assertShortcuts(true);
  const reopened = await launch();
  assert.equal((await (await fetch(`${reopened.origin}/api/articles?status=complete`)).json()).some(item => item.id === article.id), true);
  for (const seq of [1, 2]) {
    const response = await fetch(`${reopened.origin}/api/assets/${article.id}/${seq}`);
    assert.equal(response.ok, true, `Upgraded library image ${seq}: HTTP ${response.status}`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), image);
  }
  await quit();
  // SQLite may checkpoint on open, so compare the closed database from this point for uninstall/reinstall.
  hashes[0] = await digest(files[0]);
  checks.push('same-AppId higher-version upgrade retains closed database, local/external images, unknown files and remembered library');
  run(uninstaller, silent, 'uninstall.log'); installed = false;
  await unchanged(); await assertShortcuts(false);
  assert.equal(registryPresent(), false); assert.equal(existsSync(executable), false);
  assert.equal(existsSync(join(target, 'resources/app.asar')), false);
  checks.push('uninstall removes installed program, test registration and shortcuts while preserving library, external roots and unknown files byte-for-byte');
  run(upgraded.executable, installArgs, 'reinstall.log'); installed = true;
  await unchanged();
  const restored = await launch();
  const restoredImage = await fetch(`${restored.origin}/api/assets/${article.id}/2`);
  assert.equal(restoredImage.ok, true, `Reinstalled library external image: HTTP ${restoredImage.status}`);
  assert.deepEqual(Buffer.from(await restoredImage.arrayBuffer()), image);
  await quit(); hashes[0] = await digest(files[0]);
  run(uninstaller, silent, 'final-uninstall.log'); installed = false;
  await unchanged(); await assertShortcuts(false); assert.equal(registryPresent(), false);
  checks.push('reinstall reopens retained library and reads external image; final uninstall leaves no test shortcuts or uninstall registration');
  const result = { passed: true, checks, fixture, testId, productionIdentityUntouched: true, firstInstaller: first.executable, upgradedInstaller: upgraded.executable };
  await writeFile(join(evidence, 'installer-smoke-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await quit();
  if (installed && existsSync(uninstaller)) run(uninstaller, silent, 'cleanup-uninstall.log');
}
