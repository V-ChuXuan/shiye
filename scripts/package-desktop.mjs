import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packager } from '@electron/packager';
import { collectDistributionLicenses } from './package-licenses.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
assert.equal(process.platform, 'win32', 'This package command builds the Windows application on Windows.');
assert.equal(process.arch, 'x64');
const metadata = JSON.parse(await readFile('package.json', 'utf8'));
assert.match(metadata.version, /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
const release = resolve('release'), out = join(release, metadata.version);
assert.ok(!existsSync(join(out, '拾页-win32-x64')), 'This version is already packaged; keep the existing application intact.');
const evidence = resolve('data/desktop-verification');
const runtime = join(evidence, 'runtime'); await mkdir(runtime, { recursive: true });
const nodeVersion = '24.22.1', nodeFile = join(runtime, 'node.exe');
const distribution = `https://nodejs.org/dist/v${nodeVersion}/`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let expected;
try {
  const cached = JSON.parse(await readFile(join(runtime, 'runtime.json'), 'utf8'));
  if (cached.nodeVersion === nodeVersion && cached.source === `${distribution}win-x64/node.exe` && /^[a-f0-9]{64}$/.test(cached.sha256) &&
    hash(await readFile(nodeFile)) === cached.sha256 && (await readFile(join(runtime, 'LICENSE'), 'utf8')).trim() &&
    execFileSync(nodeFile, ['-p', 'process.version'], { encoding: 'utf8', windowsHide: true }).trim() === `v${nodeVersion}`) expected = cached.sha256;
} catch { /* An incomplete or invalid cache must be verified through the official download path. */ }
if (expected) console.log('Using previously verified Node runtime');
else {
  const checksums = await fetch(`${distribution}SHASUMS256.txt`, { signal: AbortSignal.timeout(30000) }); assert.ok(checksums.ok);
  const sums = await checksums.text();
  expected = sums.split(/\r?\n/).find(line => line.trim().endsWith('win-x64/node.exe'))?.split(/\s+/)[0];
  assert.match(expected || '', /^[a-f0-9]{64}$/);
  if (!existsSync(nodeFile) || hash(await readFile(nodeFile)) !== expected) {
    console.log(`Downloading official Node ${nodeVersion} Windows runtime...`);
    const response = await fetch(`${distribution}win-x64/node.exe`, { signal: AbortSignal.timeout(180000) });
    assert.ok(response.ok); const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(hash(bytes), expected);
    await writeFile(`${nodeFile}.part`, bytes); await rename(`${nodeFile}.part`, nodeFile);
  }
  const license = await fetch(`https://api.github.com/repos/nodejs/node/contents/LICENSE?ref=v${nodeVersion}`, { headers: { 'User-Agent': 'shiye-package' }, signal: AbortSignal.timeout(30000) }); assert.ok(license.ok);
  const licenseFile = await license.json();
  assert.equal(licenseFile.encoding, 'base64');
  await writeFile(join(runtime, 'LICENSE'), Buffer.from(licenseFile.content, 'base64'));
  await writeFile(join(runtime, 'runtime.json'), JSON.stringify({ nodeVersion, source: `${distribution}win-x64/node.exe`, sha256: expected }, null, 2));
}
assert.equal(execFileSync(nodeFile, ['-p', 'process.version'], { encoding: 'utf8', windowsHide: true }).trim(), `v${nodeVersion}`);
await mkdir(out, { recursive: true });
const stage = await mkdtemp(join(release, 'staging-'));
try {
const shell = join(stage, 'shell'), backend = join(stage, 'backend');
await mkdir(join(shell, 'desktop'), { recursive: true }); await mkdir(backend, { recursive: true });
await writeFile(join(shell, 'package.json'), JSON.stringify({ name: 'shiye-desktop', productName: '拾页', version: metadata.version, main: 'desktop/main.cjs' }, null, 2));
for (const file of ['main.cjs', 'config.cjs']) await cp(join('desktop', file), join(shell, 'desktop', file));
await writeFile(join(backend, 'package.json'), JSON.stringify({ name: metadata.name, version: metadata.version, description: metadata.description, type: 'module' }, null, 2));
for (const directory of ['server', 'shared', 'client']) await cp(join('dist', directory), join(backend, 'dist', directory), { recursive: true });
await mkdir(join(backend, 'desktop'), { recursive: true });
for (const file of ['service.mjs', 'library.mjs']) await cp(join('desktop', file), join(backend, 'desktop', file));
await mkdir(join(backend, 'scripts'), { recursive: true });
for (const file of ['capture-session.ps1', 'choose-directory.ps1']) await cp(join('scripts', file), join(backend, 'scripts', file));
const copied = new Set();
async function dependency(name, from = root) {
  let location = from;
  while (!existsSync(join(location, 'node_modules', name, 'package.json'))) {
    const parent = dirname(location); assert.notEqual(parent, location, `Missing dependency ${name}`); location = parent;
  }
  const source = join(location, 'node_modules', name);
  if (copied.has(source)) return;
  const path = relative(root, source); assert.ok(path.startsWith(`node_modules${sep}`) && !path.startsWith('..'));
  copied.add(source);
  await cp(source, join(backend, path), { recursive: true, filter: file => file === source || basename(file) !== 'node_modules' });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  for (const child of Object.keys(manifest.dependencies || {})) await dependency(child, source);
}
for (const name of ['fastify', '@fastify/static', 'better-sqlite3']) await dependency(name);
const sqlite = execFileSync(nodeFile, ['--input-type=module', '-e', "import Database from 'better-sqlite3';const db=new Database(':memory:');db.exec('create table proof(value)');db.prepare('insert into proof values (?)').run('ok');if(db.prepare('select value from proof').get().value!=='ok')process.exit(1);db.close();console.log('sqlite-ok')"], { cwd: backend, encoding: 'utf8', windowsHide: true });
assert.match(sqlite, /sqlite-ok/);
console.log(`Packaging Electron; ${copied.size} backend packages, no user library...`);
const packaged = await packager({ dir: shell, name: '拾页', executableName: '拾页', platform: 'win32', arch: 'x64', electronVersion: metadata.devDependencies.electron, out: join(stage, 'application'), overwrite: false, asar: true, prune: false, extraResource: [backend, runtime], appCopyright: '拾页', win32metadata: { ProductName: '拾页', FileDescription: metadata.description, OriginalFilename: '拾页.exe' } });
const built = packaged[0], destination = join(out, '拾页-win32-x64');
assert.ok(built.startsWith(`${stage}${sep}`));
assert.ok(!existsSync(join(built, 'resources/backend/data')) && !existsSync(join(built, 'resources/backend/pictures')));
const licenses = await collectDistributionLicenses({
  root, destination: built, additionalPackages: ['tailwindcss'],
  supplements: [{ name: 'abstract-logging', version: '2.0.1', file: 'docs/licenses/abstract-logging-LICENSE.txt', source: 'https://jsumners.mit-license.org/' }],
});
assert.ok(!existsSync(destination), 'Keep the existing application intact.');
await rename(built, destination);
const report = { passed: true, version: metadata.version, executable: join(destination, '拾页.exe'), nodeVersion, nodeSha256: expected, electronVersion: metadata.devDependencies.electron, backendPackages: copied.size, licensePackages: licenses.length, nativeSqliteVerified: true, userLibraryIncluded: false, executableBytes: (await stat(join(destination, '拾页.exe'))).size };
await writeFile(join(evidence, 'package-result.json'), JSON.stringify(report, null, 2));
const launcher = join(release, '启动拾页.cmd');
await writeFile(`${launcher}.tmp`, `@echo off\r\nchcp 65001 >nul\r\nif not exist "%~dp0${metadata.version}\\拾页-win32-x64\\拾页.exe" exit /b 1\r\nstart "" "%~dp0${metadata.version}\\拾页-win32-x64\\拾页.exe"\r\nexit /b %errorlevel%\r\n`);
await rename(`${launcher}.tmp`, launcher);
console.log(JSON.stringify(report));
} finally {
  assert.equal(dirname(stage), release);
  assert.ok(basename(stage).startsWith('staging-'));
  await rm(stage, { recursive: true, force: true, maxRetries: 5 });
}
