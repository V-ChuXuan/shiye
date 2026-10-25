// Explicit development command: refresh only the listed, locally owned Nova sources.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const names = ['button', 'input', 'dialog', 'badge', 'table', 'skeleton', 'checkbox', 'progress', 'tabs', 'resizable', 'alert'];
const records = [];
for (const name of names) {
  const url = `https://ui.shadcn.com/r/styles/base-nova/${name}.json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  assert.ok(response.ok, `Registry failed for ${name}`);
  const item = await response.json();
  assert.equal(item.name, name);
  for (const file of item.files || []) {
    assert.equal(basename(file.path), `${name}.tsx`);
    const icons = new Set();
    let content = file.content.replace(/^import \{ IconPlaceholder \} from .+\r?\n/gm, '');
    content = content.replace(/<IconPlaceholder\b([\s\S]*?)\/>/g, (_, attributes) => {
      const icon = /\blucide="([A-Za-z]+Icon)"/.exec(attributes)?.[1];
      assert.ok(icon, `Missing Lucide mapping for ${name}`);
      icons.add(icon);
      const className = /\bclassName="([^"]*)"/.exec(attributes)?.[0] || '';
      return `<${icon} ${className} aria-hidden="true" />`;
    }).replaceAll('@/registry/base-nova/ui/', '@/components/ui/');
    if (icons.size) content = `import { ${[...icons].join(', ')} } from "lucide-react"\n${content}`;
    content = content.replaceAll('>Close<', '>关闭<').replaceAll('>\n          Close\n', '>\n          关闭\n');
    assert.ok(!/IconPlaceholder|@\/registry|@\/app\//.test(content), `Unconverted registry template: ${name}`);
    const destination = resolve(root, 'client/src/components/ui', `${name}.tsx`);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `// shadcn/ui Base Nova, MIT. Source: ${url}\n${content}`);
    records.push({ name, url, upstreamSha256: createHash('sha256').update(file.content).digest('hex') });
  }
}
await mkdir(resolve(root, 'docs'), { recursive: true });
const { localComponents = [] } = JSON.parse(await readFile(resolve(root, 'docs/ui-component-sources.json'), 'utf8').catch(() => '{}'));
assert.ok(Array.isArray(localComponents), 'Local component source records must be an array.');
await writeFile(resolve(root, 'docs/ui-component-sources.json'), JSON.stringify({ localComponents, style: 'base-nova', iconLibrary: 'lucide', changes: ['registry imports localized', 'IconPlaceholder replaced with Lucide', 'close label localized'], components: records }, null, 2));
const license = await fetch('https://api.github.com/repos/shadcn-ui/ui/contents/LICENSE.md', { headers: { Accept: 'application/vnd.github.raw+json', 'User-Agent': 'wechat-archive-source-sync' } });
assert.ok(license.ok, 'License fetch failed');
await writeFile(resolve(root, 'docs/shadcn-LICENSE.md'), await license.text());
console.log(`Saved ${records.length} official Base Nova components and source/license records.`);
