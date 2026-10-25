import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { assertCleanPayload, installerIdentity } from '../scripts/package-installer.mjs';

test('installer test identities cannot use or replace the production uninstall registration', () => {
  assert.deepEqual(installerIdentity(), { appId: 'Shiye.Desktop', name: '拾页' });
  const first = installerIdentity(randomUUID()), second = installerIdentity(randomUUID());
  assert.notEqual(first.appId, second.appId);
  assert.ok(first.appId.startsWith('Shiye.InstallTest.'));
  for (const value of ['', 'Shiye.Desktop', '../directory', '"\n[UninstallDelete]']) assert.throws(() => installerIdentity(value));
});

test('installer rejects a payload containing local libraries, bindings, databases or links', async t => {
  const parent = resolve('data/desktop-verification'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'installer-payload-'));
  t.after(async () => { assert.ok(root.startsWith(`${parent}${sep}installer-payload-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  await writeFile(join(root, '拾页.exe'), 'program fixture');
  await mkdir(join(root, 'resources/backend'), { recursive: true });
  await writeFile(join(root, 'resources/backend/package.json'), '{}');
  await assertCleanPayload(root);
  for (const name of ['data', 'pictures', 'library', 'backups', 'library.json', '.env', 'archive.sqlite-wal', '.shiye-service.lock']) {
    await writeFile(join(root, 'resources/backend', name), 'private fixture');
    await assert.rejects(assertCleanPayload(root), /User data cannot enter the installer/);
    await rm(join(root, 'resources/backend', name));
  }
  await symlink(join(root, 'resources'), join(root, 'linked'), 'junction');
  await assert.rejects(assertCleanPayload(root), /must not contain links/);
});

test('installer has Chinese user-level settings and no data deletion or force-close actions', async () => {
  const source = await readFile('desktop/installer.iss', 'utf8');
  for (const required of [/^PrivilegesRequired=lowest$/m, /^CloseApplications=no$/m, /^RestartApplications=no$/m,
    /^DefaultDirName=\{localappdata\}\\Programs\\Shiye$/m, /ChineseSimplified\.isl/, /skipifsilent/,
    /function PrepareToInstall/, /function InitializeUninstall/]) assert.match(source, required);
  assert.doesNotMatch(source, /\[(?:UninstallDelete|InstallDelete)\]|DelTree|ForceCloseApplications|taskkill|TerminateProcess/i);
  assert.doesNotMatch(source, /Source:.*(?:library|pictures|data)\\/i);
});
