import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compilerVersion = '7.1.0';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function installerIdentity(testId) {
  if (testId !== undefined) assert.match(testId, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  return testId ? { appId: `Shiye.InstallTest.${testId}`, name: `拾页安装验收-${testId}` } : { appId: 'Shiye.Desktop', name: '拾页' };
}

export async function assertCleanPayload(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    assert.ok(!(await lstat(file)).isSymbolicLink(), `Distribution must not contain links: ${file}`);
    assert.ok(!/^(?:data|pictures|library|backups?|\.env(?:\..*)?|library\.json|window\.json)$/i.test(entry.name) &&
      !/\.(?:sqlite|db)(?:-|$)/i.test(entry.name) && !/^\.shiye-/i.test(entry.name), `User data cannot enter the installer: ${file}`);
    if (entry.isDirectory()) await assertCleanPayload(file);
  }
}

export async function packageInstaller({ compiler = process.env.ISCC, testId, version, outputDirectory } = {}) {
  assert.equal(process.platform, 'win32');
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const report = JSON.parse(await readFile(join(root, 'data/desktop-verification/package-result.json'), 'utf8'));
  assert.equal(report.passed, true); assert.equal(report.version, metadata.version);
  assert.equal(report.userLibraryIncluded, false); assert.equal(report.nativeSqliteVerified, true);
  const payload = join(root, 'release', metadata.version, '拾页-win32-x64');
  assert.equal(resolve(report.executable), join(payload, '拾页.exe'));
  const packaged = JSON.parse(await readFile(join(payload, 'resources/backend/package.json'), 'utf8'));
  assert.equal(packaged.version, metadata.version);
  assert.ok(existsSync(join(payload, '拾页.exe')) && existsSync(join(payload, 'LICENSE.shiye')) && existsSync(join(payload, 'licenses/manifest.json')));
  await assertCleanPayload(payload);
  const identity = installerIdentity(testId);
  if (version !== undefined) assert.ok(testId, 'Only an isolated installer test may override the version.');
  version ||= metadata.version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
  compiler ||= [join(process.env.LOCALAPPDATA || '', 'Programs/Inno Setup 7/ISCC.exe'),
    join(process.env.ProgramFiles || '', 'Inno Setup 7/ISCC.exe')].find(file => existsSync(file));
  assert.ok(compiler && existsSync(compiler), 'Install Inno Setup 7.1.0, or set ISCC to its ISCC.exe.');
  const detected = spawnSync(compiler, ['--version'], { encoding: 'utf8', windowsHide: true });
  if (detected.error) throw detected.error;
  assert.equal(detected.status, 0, detected.stderr);
  assert.equal(detected.stdout.trim(), compilerVersion);
  const output = resolve(outputDirectory || join(root, 'release', metadata.version));
  for (const value of [payload, output, identity.name]) assert.ok(!/["\r\n]/.test(value));
  const filename = testId ? `installer-test-${testId}-${version}` : `shiye-${version}-setup-x64`;
  const executable = join(output, `${filename}.exe`);
  assert.ok(!existsSync(executable), 'Keep existing installers intact; choose a fresh output directory.');
  await mkdir(output, { recursive: true });
  execFileSync(compiler, ['--quiet-progress', `--define=AppVersion=${version}`, `--define=PayloadDir=${payload}`, `--define=OutputDir=${output}`,
    `--define=AppId=${identity.appId}`, `--define=AppName=${identity.name}`, `--define=OutputBaseName=${filename}`, join(root, 'desktop/installer.iss')],
  { cwd: root, stdio: 'inherit', windowsHide: true });
  const bytes = await readFile(executable);
  assert.equal(bytes.subarray(0, 2).toString('ascii'), 'MZ');
  const result = { passed: true, executable, version, payload, ...identity, sha256: sha256(bytes), bytes: bytes.length,
    compilerVersion, compilerSha256: sha256(await readFile(compiler)), userLibraryIncluded: false };
  await writeFile(join(root, `data/desktop-verification/installer-result${testId ? `-${testId}-${version}` : ''}.json`), JSON.stringify(result, null, 2));
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await packageInstaller()));
