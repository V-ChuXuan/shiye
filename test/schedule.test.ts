import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createApp } from '../server/app.js';
import type { Collector } from '../shared/types.js';

async function fixture(t: test.TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: new Date('2026-10-24T00:00:00Z') });
  const parent = resolve('data'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'schedule-test-'));
  let expires = Date.now() + 15 * 60_000, requests = 0, captures = 0, gate: string | null = null;
  let capture: (() => Promise<void>) | undefined;
  const source: Collector = {
    fetchArticle: async () => { throw Error('No article requested'); }, fetchImage: async () => { throw Error('No image requested'); },
    captureSession: async () => { captures++; await capture?.(); expires = Date.now() + 15 * 60_000; },
    hasSession: () => Date.now() < expires, getGate: () => gate, clearGate: () => { gate = null; },
    discoverPage: async () => { requests++; return { entries: [], nextOffset: 0, canContinue: false }; },
  };
  const app = await createApp({ dataDir: root, source, schedulerEnabled: true, staticDir: join(root, 'no-client') });
  t.after(async () => { await app.close(); assert.ok(root.startsWith(`${parent}${sep}schedule-test-`)); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const account = app.archive.store.upsertAccount('ScheduledAccount==', '自动更新测试');
  const tick = async (milliseconds: number) => { t.mock.timers.tick(milliseconds); await app.archive.idle(); };
  return { app, account, tick, requests: () => requests, captures: () => captures, expire() { expires = 0; },
    block() { gate = 'verification'; }, holdCapture(value: () => Promise<void>) { capture = value; } };
}

test('enabling scheduled discovery runs its first check inside the session window without changing the configured interval', async t => {
  const f = await fixture(t);
  await f.tick(30_000); assert.equal(f.requests(), 0);
  const before = Date.now(), account = f.app.archive.updateAccount(f.account.id, { updatePolicy: 'discover' });
  assert.equal(account.intervalMinutes, 60); assert.equal(Date.parse(account.nextCheckAt!), before); assert.equal(f.requests(), 0);
  await f.tick(30_000); assert.equal(f.requests(), 1);
  const due = f.app.archive.account(account.id).nextCheckAt!;
  assert.equal(Date.parse(due), Date.now() + 60 * 60_000);
  await f.tick(60 * 60_000); assert.equal(f.requests(), 1); assert.equal(f.app.archive.account(account.id).connection, 'expired');
  assert.equal(f.captures(), 0, 'Scheduling must never automatically capture or extend the source session.');
});

test('subsequent scheduled checks honor their interval and blocked or manual accounts never fetch', async t => {
  const f = await fixture(t);
  f.app.archive.updateAccount(f.account.id, { updatePolicy: 'discover', intervalMinutes: 5 });
  await f.tick(30_000); assert.equal(f.requests(), 1);
  await f.tick(4 * 60_000); assert.equal(f.requests(), 1);
  await f.tick(60_000); assert.equal(f.requests(), 2);
  f.block(); await f.tick(5 * 60_000); assert.equal(f.requests(), 2);
  f.app.archive.updateAccount(f.account.id, { updatePolicy: 'manual' });
  await f.tick(5 * 60_000); assert.equal(f.requests(), 2);
});

test('an explicit reconnect schedules the next check promptly and preserves account edits made while capturing', async t => {
  const f = await fixture(t);
  f.app.archive.updateAccount(f.account.id, { updatePolicy: 'discover', intervalMinutes: 60 });
  await f.tick(30_000); assert.equal(f.requests(), 1); f.expire();
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; }); f.holdCapture(() => held);
  const reconnect = f.app.archive.connect(f.account.id);
  f.app.archive.updateAccount(f.account.id, { name: '捕获期间改名', intervalMinutes: 10 });
  release(); const reconnected = await reconnect;
  assert.equal(reconnected.name, '捕获期间改名'); assert.equal(reconnected.intervalMinutes, 10);
  assert.equal(Date.parse(reconnected.nextCheckAt!), Date.now());
  await f.tick(30_000); assert.equal(f.requests(), 2); assert.equal(f.captures(), 1);
  f.app.archive.updateAccount(f.account.id, { updatePolicy: 'manual' });
  await f.app.archive.connect(f.account.id); await f.tick(30_000);
  assert.equal(f.requests(), 2, 'A manual account must remain manual after reconnecting.');
});
