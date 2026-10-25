import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { readLibraryRoot, saveLibraryRoot, existingLibrary, checkLibraryWritable } = require('../desktop/config.cjs');
const desktopSource = fs.readFileSync('desktop/main.cjs', 'utf8');
function startup(raw: string | undefined, selected?: string, options: { explicit?: string; remembered?: string; failService?: boolean; cancelPicker?: boolean; unwritable?: number; packaged?: boolean } = {}) {
  const root = resolve('data/library-config-startup'), writes: string[] = [], opened: string[] = [], checked: string[] = [], messages: string[] = [];
  const executable = join(root, '软件/拾页.exe');
  const issue = Object.assign(new Error('文库记录无法读取'), { code: 'library_config_invalid', original: Buffer.from(raw || '') });
  const realConfig = require('../desktop/config.cjs');
  const config = { ...realConfig, readLibraryRoot: () => { if (raw === undefined) return options.remembered; throw issue; },
    checkLibraryWritable: (value: string) => { checked.push(value); if (checked.length <= (options.unwritable || 0)) throw new Error('permission denied'); },
    existingLibrary: (value: string) => { assert.equal(value, selected); return value; },
    saveLibraryRoot: (_file: string, value: string) => { writes.push(value); } };
  const context = vm.createContext({ require: (name: string) => {
    if (name === './config.cjs') return config;
    if (name === 'node:fs') return { readFileSync: () => raw, mkdirSync() {}, writeFileSync: (_file: string, content: string) => { writes.push(JSON.parse(content).root); } };
    if (name === 'electron') return { app: { setName() {}, requestSingleInstanceLock: () => false, quit() {}, isPackaged: options.packaged !== false, getPath: () => root },
      dialog: { showMessageBox: async (value: { message: string }) => { messages.push(value.message); assert.equal(options.explicit, undefined, 'Explicit roots do not prompt again.'); return { response: selected || options.cancelPicker ? 0 : 1 }; },
        showOpenDialog: async () => ({ canceled: !selected || options.cancelPicker, filePaths: selected ? [selected] : [] }) } };
    return require(name);
  }, process: { argv: options.explicit ? [`--library-root=${options.explicit}`] : [], execPath: executable, env: {}, resourcesPath: resolve('data/library-config-resources') }, __dirname: resolve('desktop'), AbortSignal, setTimeout, clearTimeout });
  vm.runInContext(desktopSource, context);
  context.opened = opened;
  context.failService = options.failService;
  vm.runInContext("service = async () => { opened.push(paths.root); if (failService) throw new Error('fixture startup failed'); return 'http://127.0.0.1:1'; };", context);
  const start = desktopSource.slice(desktopSource.indexOf("configPath = join(app.getPath('userData')"), desktopSource.indexOf('session.defaultSession.setPermissionRequestHandler'));
  return { run: () => vm.runInContext(`(async () => { ${start} })()`, context) as Promise<void>, writes, opened, root, checked, messages };
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'library-config-')), library = join(root, '原文库 空格');
  await mkdir(join(library, 'data'), { recursive: true }); await writeFile(join(library, 'data/archive.sqlite'), 'sqlite fixture');
  t.after(async () => { assert.ok(root.startsWith(`${parent}${sep}library-config-`)); await rm(root, { recursive: true, force: true, maxRetries: 5 }); });
  return { root, library, file: join(root, 'profile/library.json') };
}

test('only a missing library record is first start; malformed, inaccessible and unavailable records stay intact', async t => {
  const f = await fixture(t); assert.equal(readLibraryRoot(f.file), undefined);
  await mkdir(join(f.root, 'profile'));
  for (const raw of ['{', '', 'null', '[]', '{}', '{"root":1}', '{"root":"relative"}', JSON.stringify({ root: join(f.root, 'missing') })]) {
    await writeFile(f.file, raw);
    assert.throws(() => readLibraryRoot(f.file), /文库记录/);
    assert.equal(await readFile(f.file, 'utf8'), raw);
  }
  const good = JSON.stringify({ root: f.library }); await writeFile(f.file, good);
  assert.equal(readLibraryRoot(f.file), f.library); assert.equal(existingLibrary(f.library), f.library);
  assert.throws(() => existingLibrary(f.root), /文库/);
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', ((file: unknown, ...args: unknown[]) => {
    if (file === f.file) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return Reflect.apply(original, fs, [file, ...args]);
  }) as typeof fs.readFileSync);
  assert.throws(() => readLibraryRoot(f.file), /文库记录/);
  t.mock.restoreAll(); assert.equal(await readFile(f.file, 'utf8'), good);
});

test('library binding saves atomically and preserves old bytes when writing or replacing fails', async t => {
  const f = await fixture(t); saveLibraryRoot(f.file, f.library);
  const before = await readFile(f.file, 'utf8');
  for (const method of ['writeFileSync', 'fsyncSync', 'renameSync'] as const) {
    t.mock.method(fs, method, (() => { throw new Error(`${method} fixture failure`); }) as never);
    assert.throws(() => saveLibraryRoot(f.file, join(f.root, 'another')), /fixture failure/);
    t.mock.restoreAll();
    assert.equal(await readFile(f.file, 'utf8'), before);
    assert.deepEqual(await readdir(join(f.root, 'profile')), ['library.json']);
  }
  saveLibraryRoot(f.file, join(f.root, 'another'));
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).root, join(f.root, 'another'));
});

test('an explicitly recovered record is preserved before replacement and refuses changed originals', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'profile'));
  const raw = Buffer.from('{ damaged 中文'); await writeFile(f.file, raw);
  let issue: unknown; try { readLibraryRoot(f.file); } catch (error) { issue = error; }
  saveLibraryRoot(f.file, f.library, issue);
  const backup = (await readdir(join(f.root, 'profile'))).find(file => file.startsWith('library.json.invalid-'));
  assert.ok(backup); assert.deepEqual(await readFile(join(f.root, 'profile', backup)), raw);
  assert.equal(readLibraryRoot(f.file), f.library);
  await writeFile(f.file, raw);
  try { readLibraryRoot(f.file); } catch (error) { issue = error; }
  await writeFile(f.file, '{ modified');
  assert.throws(() => saveLibraryRoot(f.file, f.library, issue), /已变化/);
  assert.equal(await readFile(f.file, 'utf8'), '{ modified');
});

test('canceling damaged-record recovery never opens or remembers the default library', async () => {
  const d = startup('{ damaged');
  await d.run().catch(error => { assert.equal(error.reported, true); });
  assert.deepEqual(d.opened, [], 'An unreadable binding must not silently open the default library.');
  assert.deepEqual(d.writes, []);
});

test('damaged-record recovery opens only the explicitly selected existing library', async () => {
  const selected = resolve('data/library-selected'), d = startup('{ damaged', selected);
  await d.run();
  assert.deepEqual(d.opened, [selected]); assert.deepEqual(d.writes, [selected]);
});

test('picker cancellation and failed services preserve damaged bindings; explicit roots do not ask again', async () => {
  const canceled = startup('{ damaged', undefined, { cancelPicker: true });
  await assert.rejects(canceled.run()); assert.deepEqual(canceled.opened, []); assert.deepEqual(canceled.writes, []);
  const selected = resolve('data/library-selected'), failed = startup('{ damaged', selected, { failService: true });
  await assert.rejects(failed.run(), /fixture startup failed/); assert.deepEqual(failed.writes, []);
  const explicit = startup('{ damaged', undefined, { explicit: selected });
  await explicit.run(); assert.deepEqual(explicit.opened, [selected]); assert.deepEqual(explicit.writes, [selected]);
});

test('unreadable originals or preservation failures cannot replace a binding', async t => {
  const f = await fixture(t); await mkdir(join(f.root, 'profile')); await writeFile(f.file, '{ damaged');
  assert.throws(() => saveLibraryRoot(f.file, f.library, new Error('unreadable')), /无法保留/);
  let issue: unknown; try { readLibraryRoot(f.file); } catch (error) { issue = error; }
  t.mock.method(fs, 'copyFileSync', () => { throw new Error('preservation denied'); });
  assert.throws(() => saveLibraryRoot(f.file, f.library, issue), /preservation denied/);
  t.mock.restoreAll(); assert.equal(await readFile(f.file, 'utf8'), '{ damaged');
  assert.deepEqual(await readdir(join(f.root, 'profile')), ['library.json']);
});

test('new packaged users save beside the executable while remembered and explicit roots retain priority', async () => {
  const fresh = startup(undefined); await fresh.run();
  const expected = join(fresh.root, '软件/library');
  assert.deepEqual(fresh.checked, [expected]); assert.deepEqual(fresh.opened, [expected]); assert.deepEqual(fresh.writes, [expected]);
  const rememberedRoot = resolve('data/remembered-existing-library'), remembered = startup(undefined, undefined, { remembered: rememberedRoot });
  await remembered.run(); assert.deepEqual(remembered.opened, [rememberedRoot]); assert.deepEqual(remembered.checked, []);
  const explicitRoot = resolve('data/explicit-existing-library'), explicit = startup(undefined, undefined, { remembered: rememberedRoot, explicit: explicitRoot });
  await explicit.run(); assert.deepEqual(explicit.opened, [explicitRoot]); assert.deepEqual(explicit.checked, []);
  const source = startup(undefined, undefined, { packaged: false }); await source.run();
  assert.deepEqual(source.opened, [resolve('.')]); assert.deepEqual(source.checked, []);
});

test('an unwritable default asks for a folder and checks its library before remembering it', async () => {
  const selected = resolve('data/selected-destination'), fresh = startup(undefined, selected, { unwritable: 1 });
  await fresh.run();
  assert.deepEqual(fresh.checked, [join(fresh.root, '软件/library'), join(selected, 'library')]);
  assert.deepEqual(fresh.opened, [join(selected, 'library')]); assert.deepEqual(fresh.writes, fresh.opened);
  assert.deepEqual(fresh.messages, ['无法在此位置保存文库']);
  const exit = startup(undefined, undefined, { unwritable: 1 });
  await assert.rejects(exit.run(), (error: { reported?: boolean }) => error.reported === true);
  assert.deepEqual(exit.opened, []); assert.deepEqual(exit.writes, []);
  const canceled = startup(undefined, selected, { unwritable: 1, cancelPicker: true });
  await assert.rejects(canceled.run()); assert.deepEqual(canceled.opened, []); assert.deepEqual(canceled.writes, []);
  const failed = startup(undefined, selected, { unwritable: 1, failService: true });
  await assert.rejects(failed.run(), /fixture startup failed/); assert.deepEqual(failed.writes, []);
});

test('the first-use write probe cleans only its own file on success or denied writes', async t => {
  const f = await fixture(t), directory = join(f.root, '新文库'); await mkdir(directory);
  await writeFile(join(directory, 'user.txt'), 'keep');
  checkLibraryWritable(directory); assert.deepEqual(await readdir(directory), ['user.txt']);
  t.mock.method(fs, 'writeFileSync', () => { throw new Error('write denied'); });
  assert.throws(() => checkLibraryWritable(directory), /write denied/);
  t.mock.restoreAll(); assert.deepEqual(await readdir(directory), ['user.txt']);
  assert.equal(await readFile(join(directory, 'user.txt'), 'utf8'), 'keep');
});
