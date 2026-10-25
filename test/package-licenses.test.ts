import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { collectDistributionLicenses } from '../scripts/package-licenses.mjs';

async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'shiye-package-licenses-'));
  t.after(async () => {
    assert.ok(directory.startsWith(`${resolve(tmpdir())}${sep}shiye-package-licenses-`));
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const root = join(directory, 'project'), destination = join(directory, 'distribution');
  async function file(path: string, contents: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  await file(join(root, 'package.json'), JSON.stringify({ name: 'shiye', version: '0.1.1', dependencies: { alpha: '1', beta: '1' } }));
  await file(join(root, 'LICENSE'), 'project MIT text');
  await file(join(root, 'THIRD_PARTY_NOTICES.md'), 'third party attribution');
  await file(join(root, 'docs/shadcn-LICENSE.md'), 'full shadcn MIT text');
  await file(join(destination, 'LICENSE'), 'original Electron license');
  await file(join(destination, 'LICENSES.chromium.html'), 'original Chromium notices');
  await file(join(destination, 'resources/runtime/LICENSE'), 'original Node license');
  async function pkg(path: string, name: string, dependencies = {}, files: Record<string, string> = { LICENSE: `${name} full text` }, extra = {}) {
    const directory = join(root, 'node_modules', path);
    await file(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT', dependencies, ...extra }));
    for (const [name, contents] of Object.entries(files)) await file(join(directory, name), contents);
    return directory;
  }
  return { root, destination, file, pkg, directory };
}

test('distribution includes complete legal texts, transitive/nested packages and deterministic unique records without replacing runtime licenses', async t => {
  const f = await fixture(t);
  await f.pkg('alpha', 'alpha', { shared: '1' }, { 'LiCeNcE.md': 'alpha original full text', NOTICE: 'alpha original NOTICE', 'vendor/COPYING': 'vendored full text' }, { exports: { '.': './index.js' }, optionalDependencies: { absent: '1', installed: '1' } });
  await f.pkg('beta', 'beta', { shared: '2' });
  await f.pkg('shared', 'shared');
  await f.pkg('beta/node_modules/shared', 'shared', {}, { LICENSE: 'nested version text' }, { version: '2.0.0' });
  await f.pkg('installed', 'installed');
  await f.pkg('tailwindcss', 'tailwindcss');
  const records = await collectDistributionLicenses({ root: f.root, destination: f.destination, additionalPackages: ['tailwindcss'] });
  assert.equal(records.length, 6);
  assert.deepEqual(records.filter(record => record.name === 'shared').map(record => record.version).sort(), ['1.0.0', '2.0.0']);
  const alpha = records.find(record => record.name === 'alpha')!;
  assert.equal(alpha.license, 'MIT');
  assert.equal(alpha.path, 'node_modules/alpha');
  assert.equal(await readFile(join(f.destination, alpha.licenseFiles[0]), 'utf8'), 'alpha original full text');
  for (const [path, text] of [['LICENSE.shiye', 'project MIT text'], ['THIRD_PARTY_NOTICES.md', 'third party attribution'], ['licenses/shadcn-LICENSE.md', 'full shadcn MIT text'], ['licenses/node_modules/alpha/NOTICE', 'alpha original NOTICE'], ['licenses/node_modules/alpha/vendor/COPYING', 'vendored full text'], ['LICENSE', 'original Electron license'], ['LICENSES.chromium.html', 'original Chromium notices'], ['resources/runtime/LICENSE', 'original Node license']]) {
    assert.equal(await readFile(join(f.destination, path), 'utf8'), text);
  }
  assert.deepEqual(JSON.parse(await readFile(join(f.destination, 'licenses/manifest.json'), 'utf8')), records);
  assert.equal(JSON.stringify(records).includes(f.root), false);
  assert.deepEqual(await collectDistributionLicenses({ root: f.root, destination: f.destination, additionalPackages: ['tailwindcss'] }), records);
});

test('missing license text and missing mandatory dependencies fail instead of trusting SPDX or README links', async t => {
  const f = await fixture(t);
  await f.pkg('alpha', 'alpha', {}, { 'README.md': 'License: MIT https://example.invalid/license', NOTICE: 'attribution only' });
  await f.pkg('beta', 'beta');
  await assert.rejects(collectDistributionLicenses({ root: f.root, destination: f.destination }), /Missing license text.*alpha@1.0.0/);
  await f.file(join(f.root, 'node_modules/alpha/LICENSE'), 'alpha full license');
  await f.file(join(f.root, 'node_modules/beta/package.json'), JSON.stringify({ name: 'beta', version: '1.0.0', dependencies: { missing: '1' } }));
  await assert.rejects(collectDistributionLicenses({ root: f.root, destination: f.destination }), /Missing dependency missing/);
});

test('explicit versioned supplemental license is copied and stale supplements fail', async t => {
  const f = await fixture(t);
  await f.pkg('alpha', 'alpha', {}, {});
  await f.pkg('beta', 'beta');
  await f.file(join(f.root, 'docs/licenses/alpha-LICENSE'), 'upstream authoritative full text');
  const supplement = { name: 'alpha', version: '1.0.0', file: 'docs/licenses/alpha-LICENSE', source: 'https://example.invalid/alpha/LICENSE' };
  const records = await collectDistributionLicenses({ root: f.root, destination: f.destination, supplements: [supplement] });
  const alpha = records.find(record => record.name === 'alpha')!;
  assert.equal(await readFile(join(f.destination, alpha.licenseFiles[0]), 'utf8'), 'upstream authoritative full text');
  assert.equal(alpha.supplementSource, supplement.source);
  await assert.rejects(collectDistributionLicenses({ root: f.root, destination: f.destination, supplements: [{ ...supplement, version: '0.0.1' }] }), /Missing license text.*alpha@1.0.0/);
  await f.file(join(f.directory, 'outside-LICENSE'), 'outside license');
  await assert.rejects(collectDistributionLicenses({ root: f.root, destination: f.destination, supplements: [{ ...supplement, file: '../outside-LICENSE' }] }), /Supplement outside project/);
  await f.file(join(f.root, supplement.file), '  \n');
  await assert.rejects(collectDistributionLicenses({ root: f.root, destination: f.destination, supplements: [supplement] }), /Empty legal source/);
});

test('package resolution and legal files cannot escape the project or package boundary', async t => {
  const f = await fixture(t);
  await f.pkg('beta', 'beta');
  const outside = join(f.directory, 'node_modules/alpha');
  await f.file(join(outside, 'package.json'), JSON.stringify({ name: 'alpha', version: '1', license: 'MIT' }));
  await f.file(join(outside, 'LICENSE'), 'external text');
  await assert.rejects(collectDistributionLicenses({ root: f.root, destination: f.destination }), /Missing dependency alpha/);
  await mkdir(join(f.root, 'node_modules'), { recursive: true });
  await symlink(outside, join(f.root, 'node_modules/alpha'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(collectDistributionLicenses({ root: f.root, destination: f.destination }), /outside project/);
  await rm(join(f.root, 'node_modules/alpha'));
  await f.pkg('alpha', 'alpha');
  await assert.rejects(collectDistributionLicenses({ root: f.root, destination: f.destination, additionalPackages: ['../alpha'] }), /Invalid package name/);
});
