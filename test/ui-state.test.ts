import test from 'node:test';
import assert from 'node:assert/strict';
import { createUIStore } from '../client/src/store/ui-store.js';
import { formatDateTime, formatNumber } from '../client/src/lib/format.js';
import { getRoute, focusMainContent } from '../client/src/lib/route.js';
import type { Article } from '../shared/types.js';

const article = (id: string, accountId = 'one', status: Article['status'] = 'partial'): Article => ({ id, accountId, biz: 'sample', title: id, url: 'https://mp.weixin.qq.com/s/sample', publishedAt: '2026-10-24', status, imageCount: 2, savedImageCount: 1, textLength: 3 });
const memory = () => { const data = new Map<string, string>(); return { data, storage: { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } } }; };

test('ISO task timestamps display in Shanghai while article dates remain unchanged', () => {
  assert.equal(formatDateTime('2026-10-24T04:00:00.000Z'), '2026-10-24 12:00');
  assert.equal(formatDateTime('2026-10-23T20:30:00.000Z'), '2026-10-24 04:30');
  assert.equal(formatDateTime('2026-10-24 08:05'), '2026-10-24 08:05');
  assert.equal(formatDateTime('2026-10-24'), '2026-10-24');
  assert.equal(formatDateTime(), '尚无记录');
  assert.equal(formatNumber(1424), '1,424');
});

test('skip navigation focuses the current page without touching its hash route', () => {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  let focused = false, prevented = false;
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: (id: string) => { assert.equal(id, 'main-content'); return { focus: () => { focused = true; } }; } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { hash: '#reader?id=article-1' } } });
  try {
    focusMainContent({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true); assert.equal(focused, true);
    assert.equal(window.location.hash, '#reader?id=article-1');
    assert.equal(getRoute().view, 'reader'); assert.equal(getRoute().params.get('id'), 'article-1');
    assert.equal(getRoute('#jobs').view, 'jobs'); assert.equal(getRoute('#missing').view, 'accounts');
    assert.equal(getRoute('#settings').view, 'settings'); assert.equal(getRoute('#about').view, 'about');
  } finally {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: previousDocument });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  }
});

test('selection survives filters, freezes snapshots and ignores unavailable/complete articles', () => {
  const store = createUIStore(memory().storage), one = article('one');
  store.getState().toggleArticle(one); one.title = 'mutated elsewhere';
  store.getState().setFilters({ accountId: 'two', q: 'new search' });
  assert.equal(store.getState().selected.one.title, 'one');
  store.getState().selectVisible([article('two', 'two'), article('complete', 'two', 'complete'), article('gone', 'two', 'unavailable')], true);
  assert.deepEqual(Object.keys(store.getState().selected).sort(), ['one', 'two']);
  store.getState().selectVisible([article('two', 'two')], false);
  assert.deepEqual(Object.keys(store.getState().selected), ['one']);
});

test('a partially submitted group removes only its acknowledged article IDs', () => {
  const store = createUIStore(memory().storage);
  store.getState().selectVisible([article('one'), article('two', 'two')], true);
  store.getState().removeSelected(['one']);
  assert.deepEqual(Object.keys(store.getState().selected), ['two']);
  store.getState().clearSelection(); assert.deepEqual(store.getState().selected, {});
});

test('only validated reader preferences are persisted, never filters, selection or business state', () => {
  const { storage, data } = memory(), store = createUIStore(storage);
  store.getState().setFilters({ q: 'private search' }); store.getState().toggleArticle(article('one'));
  store.getState().setReaderMode('gallery'); store.getState().setReaderLayout({ catalogue: 32, content: 68 });
  const persisted = JSON.parse(data.get('wechat-archive-ui')!);
  assert.deepEqual(persisted.state, { readerMode: 'gallery', readerLayout: { catalogue: 32, content: 68 } });
  const reopened = createUIStore(storage).getState();
  assert.equal(reopened.readerMode, 'gallery'); assert.deepEqual(reopened.readerLayout, { catalogue: 32, content: 68 });
  assert.equal(reopened.filters.q, ''); assert.deepEqual(reopened.selected, {});
  storage.setItem('wechat-archive-ui', JSON.stringify({ state: { readerMode: 'script', readerLayout: { catalogue: -999, content: 0 }, selected: { malicious: article('bad') }, filters: { q: 'restored private value' } }, version: 1 }));
  const invalid = createUIStore(storage).getState();
  assert.equal(invalid.readerMode, 'body'); assert.deepEqual(invalid.readerLayout, { catalogue: 28, content: 72 });
  assert.deepEqual(invalid.selected, {}); assert.equal(invalid.filters.q, '');
});

test('unavailable preference storage does not break selection or reader controls', () => {
  const store = createUIStore({
    getItem: () => { throw new Error('Storage access denied'); },
    setItem: () => { throw new Error('Storage quota exceeded'); },
    removeItem: () => { throw new Error('Storage access denied'); },
  });
  assert.doesNotThrow(() => store.getState().toggleArticle(article('one')));
  assert.doesNotThrow(() => store.getState().setReaderMode('gallery'));
  assert.equal(store.getState().selected.one.id, 'one');
  assert.equal(store.getState().readerMode, 'gallery');
});
