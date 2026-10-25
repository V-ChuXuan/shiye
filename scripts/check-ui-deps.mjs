import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const direct = { ...manifest.dependencies, ...manifest.devDependencies };
const foundation = ['@base-ui/react', 'class-variance-authority', 'cn', 'lucide-react', 'motion', 'zustand', 'react-resizable-panels', 'tailwindcss', '@tailwindcss/vite'];
for (const name of foundation) {
  assert.match(direct[name] || '', /^\d+\.\d+\.\d+$/, `Pin the direct UI foundation version: ${name}`);
  assert.equal(lock.packages[`node_modules/${name}`]?.version, direct[name], `Lockfile disagrees with ${name}`);
}
const duplicates = /^(?:radix-ui|@radix-ui\/|antd$|@mui\/|@heroui\/|framer-motion$|react-icons$|recoil$|@reduxjs\/|clsx$|tailwind-merge$|@dnd-kit\/|dnd-kit$|@tanstack\/(?:react-query|react-table)$)/;
assert.deepEqual(Object.keys(direct).filter(name => duplicates.test(name)), [], 'An additional UI system needs an explicit, documented product use case.');
for (const name of ['@base-ui/react', 'lucide-react', 'zustand', 'react', 'react-dom']) {
  const versions = new Set(Object.entries(lock.packages).filter(([path]) => path.endsWith(`node_modules/${name}`)).map(([, value]) => value.version));
  assert.equal(versions.size, 1, `Multiple locked copies of ${name}: ${[...versions].join(', ')}`);
}
console.log('PASS: one UI primitive, icon library, state store, animation entry; UI versions pinned and core packages deduplicated.');
