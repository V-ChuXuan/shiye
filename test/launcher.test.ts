import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

const windows = process.platform === 'win32';
const system = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const batch = (text: string) => text.replace(/\r?\n/g, '\r\n');

async function fixture(t: test.TestContext, options: { node?: boolean; npm?: boolean; dependencies?: boolean; built?: boolean } = {}) {
  const parent = resolve('data/launcher-verification'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, '启动 空格-')), bin = join(root, 'bin');
  t.after(async () => {
    assert.ok(root.startsWith(`${parent}${sep}启动 空格-`));
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  await mkdir(bin);
  await copyFile('启动拾页.bat', join(root, '启动拾页.bat'));
  if (options.node !== false) await writeFile(join(bin, 'node.cmd'), batch('@echo off\nexit /b 0\n'));
  if (options.npm !== false) await writeFile(join(bin, 'npm.cmd'), batch('@echo off\necho %*>>"%LAUNCHER_COMMANDS%"\nif "%LAUNCHER_FAIL%"=="%1" exit /b 7\nexit /b 0\n'));
  if (options.dependencies !== false) await mkdir(join(root, 'node_modules/fastify'), { recursive: true });
  if (options.built !== false) {
    await mkdir(join(root, 'dist/server'), { recursive: true });
    await mkdir(join(root, 'dist/client'), { recursive: true });
    await writeFile(join(root, 'dist/server/index.js'), '');
    await writeFile(join(root, 'dist/client/index.html'), '');
  }
  const commands = join(root, 'commands.txt');
  function run(extra: Record<string, string> = {}) {
    return spawnSync(join(system, 'cmd.exe'), ['/d', '/c', `call "${join(root, '启动拾页.bat')}"`], {
      cwd: parent, encoding: 'utf8', input: '\r\n', timeout: 10000, windowsHide: true, windowsVerbatimArguments: true,
      env: { ...process.env, PATH: `${bin};${system}`, LAUNCHER_COMMANDS: commands, ...extra },
    });
  }
  async function calls() { return existsSync(commands) ? (await readFile(commands, 'utf8')).trim().split(/\r?\n/) : []; }
  return { root, run, calls };
}

test('Windows launcher stays UTF-8 without BOM and declares CRLF for Git checkout', async () => {
  const source = await readFile('启动拾页.bat');
  assert.equal(source.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), false);
  assert.equal(source.toString('utf8').replaceAll('\r\n', '').includes('\n'), false, 'cmd must not receive LF-only batch lines');
  assert.match(await readFile('.gitattributes', 'utf8'), /^\*\.bat text eol=crlf$/m);
});

test('real cmd starts the ready source once from a different Chinese spaced directory', { skip: !windows }, async t => {
  const f = await fixture(t), result = f.run();
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(await f.calls(), ['start -- --open']);
  assert.doesNotMatch(result.stdout + result.stderr, /not recognized|不是内部或外部命令/i);
});

for (const failure of ['install', 'run', 'start']) test(`real cmd preserves ${failure} failure and shows pause`, { skip: !windows }, async t => {
  const f = await fixture(t, { dependencies: failure !== 'install', built: failure !== 'run' });
  const result = f.run({ LAUNCHER_FAIL: failure });
  assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stdout + result.stderr);
  const calls = await f.calls();
  assert.equal(calls.length, 1); assert.ok(calls[0].startsWith(failure));
  assert.match(result.stdout, /启动失败/);
  assert.match(result.stdout, /Press any key|按任意键/i);
});

test('real cmd keeps a missing Node explanation visible instead of silently succeeding', { skip: !windows }, async t => {
  const f = await fixture(t, { node: false }), result = f.run();
  assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(await f.calls(), []);
  assert.match(result.stdout, /Node\.js 24 LTS/);
  assert.match(result.stdout, /Press any key|按任意键/i);
});

test('real cmd keeps a missing npm failure visible', { skip: !windows }, async t => {
  const f = await fixture(t, { npm: false }), result = f.run();
  assert.equal(result.error, undefined); assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(await f.calls(), []);
  assert.match(result.stdout, /启动失败/);
  assert.match(result.stdout, /Press any key|按任意键/i);
});

for (const versioned of [false, true]) test(`real cmd prefers the ${versioned ? 'current versioned' : 'legacy'} desktop without requiring Node or starting npm`, { skip: !windows }, async t => {
  const f = await fixture(t, { node: false, dependencies: false, built: false });
  const directory = join(f.root, versioned ? 'release/0.1.2/拾页-win32-x64' : 'release/拾页-win32-x64'); await mkdir(directory, { recursive: true });
  if (versioned) await writeFile(join(f.root, 'release/启动拾页.cmd'), batch('@echo off\nchcp 65001 >nul\nstart "" "%~dp00.1.2\\拾页-win32-x64\\拾页.exe"\nexit /b %errorlevel%\n'));
  const compiler = join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const source = join(f.root, 'probe.cs'), marker = join(f.root, 'desktop.txt');
  await writeFile(source, 'using System; using System.IO; class Probe { static void Main(string[] args) { File.WriteAllText(Environment.GetEnvironmentVariable("LAUNCHER_DESKTOP_PROBE"), Environment.CurrentDirectory + "\\n" + args.Length); } }');
  const compilation = spawnSync(compiler, ['/nologo', '/target:winexe', `/out:${join(directory, '拾页.exe')}`, source], { encoding: 'utf8', windowsHide: true });
  assert.equal(compilation.error, undefined); assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr);
  const result = f.run({ LAUNCHER_DESKTOP_PROBE: marker });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stdout + result.stderr);
  for (let attempt = 0; attempt < 50 && !existsSync(marker); attempt++) await new Promise(done => setTimeout(done, 100));
  assert.equal(await readFile(marker, 'utf8'), `${f.root}\n0`);
  assert.deepEqual(await f.calls(), []);
});

test('real cmd keeps a failed current desktop pointer visible instead of opening an older library', { skip: !windows }, async t => {
  const f = await fixture(t, { node: false });
  await mkdir(join(f.root, 'release'));
  await writeFile(join(f.root, 'release/启动拾页.cmd'), batch('@echo off\nexit /b 7\n'));
  const result = f.run();
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /启动失败/);
  assert.deepEqual(await f.calls(), []);
});
