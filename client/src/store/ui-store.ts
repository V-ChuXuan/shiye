import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';
import type { Article } from '../../../shared/types.js';

export interface Filters { accountId: string; q: string; since: string; until: string; status: string }
export type ReaderMode = 'body' | 'gallery';
export interface UIState {
  filters: Filters;
  selected: Record<string, Article>;
  readerMode: ReaderMode;
  readerLayout: Record<string, number>;
  setFilters: (patch: Partial<Filters>) => void;
  resetFilters: () => void;
  toggleArticle: (article: Article) => void;
  selectVisible: (articles: Article[], checked: boolean) => void;
  clearSelection: () => void;
  removeSelected: (ids: string[]) => void;
  setReaderMode: (mode: ReaderMode) => void;
  setReaderLayout: (layout: Record<string, number>) => void;
}

const emptyFilters = (): Filters => ({ accountId: '', q: '', since: '', until: '', status: '' });
const defaultLayout = () => ({ catalogue: 28, content: 72 });
const eligible = (article: Article) => !['complete', 'unavailable'].includes(article.status);
function validLayout(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object') return;
  const { catalogue, content } = value as Record<string, unknown>;
  if (typeof catalogue !== 'number' || typeof content !== 'number' || !Number.isFinite(catalogue) || !Number.isFinite(content) || catalogue < 15 || catalogue > 60 || content < 40 || content > 85 || Math.abs(catalogue + content - 100) > 1) return;
  return { catalogue, content };
}

function defaultStorage(): StateStorage {
  try { if (typeof window !== 'undefined') return window.localStorage; } catch { /* Storage can be disabled by the browser. */ }
  const values = new Map<string, string>();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); }, removeItem: key => { values.delete(key); } };
}

export function createUIStore(storage: StateStorage = defaultStorage()) {
  return create<UIState>()(persist((set) => ({
    filters: emptyFilters(), selected: {}, readerMode: 'body', readerLayout: defaultLayout(),
    setFilters: patch => set(state => ({ filters: { ...state.filters, ...patch } })),
    resetFilters: () => set({ filters: emptyFilters() }),
    toggleArticle: article => set(state => {
      if (!eligible(article)) return state;
      const selected = { ...state.selected };
      if (selected[article.id]) delete selected[article.id];
      else selected[article.id] = { ...article };
      return { selected };
    }),
    selectVisible: (articles, checked) => set(state => {
      const selected = { ...state.selected };
      for (const article of articles) {
        if (!checked) delete selected[article.id];
        else if (eligible(article)) selected[article.id] = { ...article };
      }
      return { selected };
    }),
    clearSelection: () => set({ selected: {} }),
    removeSelected: ids => set(state => {
      const selected = { ...state.selected };
      for (const id of ids) delete selected[id];
      return { selected };
    }),
    setReaderMode: mode => { if (mode === 'body' || mode === 'gallery') set({ readerMode: mode }); },
    setReaderLayout: layout => { const next = validLayout(layout); if (next) set({ readerLayout: next }); },
  }), {
    name: 'wechat-archive-ui', version: 1,
    // Optional reader preferences must not disable controls when browser storage is blocked or full.
    storage: createJSONStorage(() => ({
      getItem: key => { try { return storage.getItem(key); } catch { return null; } },
      setItem: (key, value) => { try { return storage.setItem(key, value); } catch { /* Keep the current in-memory state. */ } },
      removeItem: key => { try { return storage.removeItem(key); } catch { /* Nothing else is persisted. */ } },
    })),
    partialize: state => ({ readerMode: state.readerMode, readerLayout: state.readerLayout }),
    merge: (persisted, current) => {
      const saved = persisted && typeof persisted === 'object' ? persisted as Record<string, unknown> : {};
      return { ...current, readerMode: saved.readerMode === 'gallery' ? 'gallery' : 'body', readerLayout: validLayout(saved.readerLayout) || defaultLayout() };
    },
  }));
}

export const useUIStore = createUIStore();
