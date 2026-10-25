import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const portable = path => path.split(sep).join('/');
function within(root, path) {
  const child = relative(root, path);
  return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith(`..${sep}`));
}

// Resolve installed files rather than package.json exports, which many packages hide.
async function packageDirectory(name, from, root, optional) {
  assert.ok(/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) && !['.', '..'].includes(name), `Invalid package name: ${name}`);
  let location = from;
  while (within(root, location)) {
    const candidate = join(location, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) {
      const actual = await realpath(candidate);
      assert.ok(within(join(root, 'node_modules'), actual), `Dependency ${name} is outside project node_modules`);
      return actual;
    }
    if (location === root) break;
    location = dirname(location);
  }
  assert.ok(optional, `Missing dependency ${name}`);
  return undefined;
}

async function readContained(root, file) {
  assert.ok(within(root, await realpath(file)), `Legal source outside project/package: ${file}`);
  const contents = await readFile(file);
  assert.ok(contents.toString('utf8').trim(), `Empty legal source: ${file}`);
  return contents;
}

async function legalFiles(directory) {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const file = join(path, entry.name);
      const legal = /^(?:licen[sc]es?|copying|notice)(?:[._-]|$)/i.test(entry.name);
      if (entry.isSymbolicLink()) {
        assert.ok(!legal, `Linked legal source is not supported: ${file}`);
      } else if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && legal) files.push(file);
    }
  }
  await visit(directory);
  return files.sort();
}

/**
 * Copy complete installed license texts for production packages and generated CSS.
 * Build tools are excluded unless their output contains code (for example Tailwind).
 * Explicit, version-pinned upstream supplements cover packages whose npm tarballs
 * omit the license text. SPDX names or README links alone never satisfy the check.
 * @param {{root: string, destination: string, additionalPackages?: string[], supplements?: {name: string, version: string, file: string, source: string}[]}} options
 */
export async function collectDistributionLicenses({ root, destination, additionalPackages = [], supplements = [] }) {
  root = await realpath(root);
  destination = resolve(destination);
  const metadata = JSON.parse((await readContained(root, join(root, 'package.json'))).toString('utf8'));
  const records = [], sources = [], seen = new Set();
  async function dependency(name, from = root, optional = false) {
    const directory = await packageDirectory(name, from, root, optional);
    if (!directory || seen.has(directory)) return;
    seen.add(directory);
    const manifest = JSON.parse((await readContained(directory, join(directory, 'package.json'))).toString('utf8'));
    assert.ok(typeof manifest.name === 'string' && typeof manifest.version === 'string', `Invalid package metadata: ${name}`);
    const files = await legalFiles(directory);
    const path = portable(relative(root, directory));
    const record = { name: manifest.name, version: manifest.version, license: manifest.license ?? null, path, licenseFiles: [] };
    let hasLicense = false;
    for (const file of files) {
      const output = portable(join('licenses', path, relative(directory, file)));
      sources.push({ output, contents: await readContained(directory, file) });
      record.licenseFiles.push(output);
      if (/^(?:licen[sc]es?|copying)(?:[._-]|$)/i.test(file.split(sep).at(-1))) hasLicense = true;
    }
    if (!hasLicense) {
      const supplement = supplements.find(item => item.name === manifest.name && item.version === manifest.version);
      assert.ok(supplement, `Missing license text for ${manifest.name}@${manifest.version} (${path})`);
      assert.ok(!isAbsolute(supplement.file) && within(root, resolve(root, supplement.file)), `Supplement outside project: ${supplement.file}`);
      const output = portable(join('licenses', path, 'LICENSE.upstream'));
      sources.push({ output, contents: await readContained(root, resolve(root, supplement.file)) });
      record.licenseFiles.push(output);
      record.supplementSource = supplement.source;
    }
    records.push(record);
    for (const child of Object.keys(manifest.dependencies || {}).sort()) {
      await dependency(child, directory, Object.hasOwn(manifest.optionalDependencies || {}, child));
    }
    for (const child of Object.keys(manifest.optionalDependencies || {}).sort()) await dependency(child, directory, true);
  }
  for (const name of [...new Set([...Object.keys(metadata.dependencies || {}), ...additionalPackages])].sort()) await dependency(name);
  records.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  // Validate every input before creating a successful manifest or copying legal files.
  for (const [source, output] of [['LICENSE', 'LICENSE.shiye'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'], ['docs/shadcn-LICENSE.md', 'licenses/shadcn-LICENSE.md']]) {
    sources.push({ output, contents: await readContained(root, join(root, source)) });
  }
  for (const { output, contents } of sources) {
    const target = join(destination, output);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  await writeFile(join(destination, 'licenses/manifest.json'), `${JSON.stringify(records, null, 2)}\n`);
  return records;
}
