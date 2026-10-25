import { useCallback, useEffect, useRef, useState } from 'react';
import type { Account, Article, ArticleDetail, ArticlePage, Job, JobPage, Summary } from '../../../shared/types';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/route';
import { useUIStore, type ReaderMode } from '../store/ui-store';

export type Notice = { type: 'success' | 'error'; text: string };
export type Modal = { type: 'add' | 'import' | 'confirm' } | { type: 'discover'; account: Account } | null;
const message = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请稍后重试。';

export function useArchive() {
  const route = useRoute();
  const filters = useUIStore(state => state.filters);
  const selected = useUIStore(state => state.selected);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [jobHistory, setJobHistory] = useState<JobPage | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [articles, setArticles] = useState<Article[]>([]);
  const [articleTotal, setArticleTotal] = useState(0);
  const [pagination, setPagination] = useState({ filterKey: '', page: 1 });
  const [library, setLibrary] = useState<Article[]>([]);
  const [libraryFilters, setLibraryFilters] = useState({ q: '', accountId: '' });
  const [detail, setDetail] = useState<ArticleDetail | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [articleLoading, setArticleLoading] = useState(false);
  const [readerLoading, setReaderLoading] = useState(false);
  const [libraryLoading, setLibraryLoading] = useState(true);
  const [serviceError, setServiceError] = useState('');
  const [articleError, setArticleError] = useState('');
  const [readerError, setReaderError] = useState('');
  const [readerRevision, setReaderRevision] = useState(0);
  const [libraryError, setLibraryError] = useState('');
  const [libraryRevision, setLibraryRevision] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [singleSelection, setSingleSelection] = useState<Article[] | null>(null);
  const [query, setQuery] = useState(filters.q);
  const busyRef = useRef(false);
  const refreshRequest = useRef(0);
  const articlesRequest = useRef(0);
  const historyRequest = useRef(0);
  const historyPage = useRef(1);
  const historyFocus = useRef<string | null>(null);
  const completedCount = useRef<number | undefined>(undefined);
  const returnRoute = useRef('articles');
  const routeId = route.params.get('id');
  const routeAccount = route.params.get('accountId') || '';
  const filterKey = JSON.stringify([filters.accountId, filters.since, filters.until, filters.status, query]);
  const articlePage = pagination.filterKey === filterKey ? pagination.page : 1;
  const articlePageSize = 50;

  useEffect(() => {
    if (route.view === 'articles' && route.params.has('accountId')) useUIStore.getState().setFilters({ accountId: routeAccount });
  }, [route.view, routeAccount]);
  useEffect(() => { const timer = setTimeout(() => setQuery(filters.q), 250); return () => clearTimeout(timer); }, [filters.q]);
  useEffect(() => {
    if (pagination.filterKey !== filterKey) { setPagination({ filterKey, page: 1 }); setArticleTotal(0); }
  }, [filterKey, pagination.filterKey]);
  useEffect(() => { setArticles([]); }, [filterKey, articlePage]);

  const refresh = useCallback(async () => {
    const requestId = ++refreshRequest.current;
    try {
      const [nextAccounts, nextJobs, nextSummary] = await Promise.all([api<Account[]>('/accounts'), api<Job[]>('/jobs?scope=open'), api<Summary>('/summary')]);
      if (requestId !== refreshRequest.current) return;
      setAccounts(nextAccounts); setJobs(nextJobs); setSummary(nextSummary); setServiceError('');
    } catch (error) { if (requestId === refreshRequest.current) setServiceError(message(error)); }
    finally { if (requestId === refreshRequest.current) setInitialLoading(false); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    return () => { clearInterval(timer); refreshRequest.current++; };
  }, [refresh]);

  const loadJobHistory = useCallback(async (page = historyPage.current, focus = historyFocus.current): Promise<void> => {
    const requestId = ++historyRequest.current;
    historyPage.current = page; historyFocus.current = focus;
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (focus) params.set('focus', focus);
      const result = await api<JobPage>(`/jobs/history?${params}`);
      if (requestId !== historyRequest.current) return;
      const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
      if (result.page > lastPage) { void loadJobHistory(lastPage, null); return; }
      historyPage.current = result.page; historyFocus.current = null;
      setJobHistory(result); setHistoryError('');
    } catch (error) { if (requestId === historyRequest.current) setHistoryError(message(error)); }
    finally { if (requestId === historyRequest.current) setHistoryLoading(false); }
  }, []);
  useEffect(() => {
    if (route.view !== 'jobs') return;
    historyPage.current = 1; historyFocus.current = routeId;
    setHistoryError('');
    void loadJobHistory();
    return () => { historyRequest.current++; };
  }, [route.view, routeId, loadJobHistory]);
  useEffect(() => {
    const previous = completedCount.current;
    completedCount.current = summary?.completedJobsCount;
    if (route.view === 'jobs' && summary && summary.completedJobsCount !== previous) void loadJobHistory();
  }, [summary?.completedJobsCount, route.view, loadJobHistory]);

  const loadArticles = useCallback(async () => {
    const requestId = ++articlesRequest.current;
    setArticleLoading(true);
    try {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...filters, q: query })) if (value) params.set(key, value);
      params.set('page', String(articlePage)); params.set('pageSize', String(articlePageSize));
      const result = await api<ArticlePage>(`/articles/page?${params}`);
      if (requestId === articlesRequest.current) {
        const lastPage = Math.max(1, Math.ceil(result.total / result.pageSize));
        if (articlePage > lastPage) { setPagination({ filterKey, page: lastPage }); return; }
        setArticles(result.items); setArticleTotal(result.total); setArticleError('');
      }
    } catch (error) { if (requestId === articlesRequest.current) setArticleError(message(error)); }
    finally { if (requestId === articlesRequest.current) setArticleLoading(false); }
  }, [filters.accountId, filters.since, filters.until, filters.status, query, articlePage, filterKey]);
  useEffect(() => {
    if (route.view !== 'articles') return;
    void loadArticles();
    const timer = setInterval(() => { if (!document.hidden) void loadArticles(); }, 6000);
    return () => { clearInterval(timer); articlesRequest.current++; };
  }, [loadArticles, route.view]);

  useEffect(() => {
    if (route.view !== 'reader' || !summary) return;
    const controller = new AbortController();
    let current = true;
    setLibraryLoading(true); setLibraryError('');
    void (async () => {
      try {
        const localLibrary: Article[] = [];
        for (let page = 1; ; page++) {
          const result = await api<ArticlePage>(`/articles/page?status=complete&page=${page}&pageSize=100`, { signal: controller.signal });
          localLibrary.push(...result.items);
          if (!result.items.length || page * result.pageSize >= result.total) break;
        }
        if (current) setLibrary([...new Map(localLibrary.map(item => [item.id, item])).values()]);
      } catch (error) { if (current) setLibraryError(message(error)); }
      finally { if (current) setLibraryLoading(false); }
    })();
    return () => { current = false; controller.abort(); };
  }, [route.view, summary?.archivedCount, summary?.imageCount, libraryRevision]);
  useEffect(() => {
    setDetail(null); setReaderError('');
    if (route.view !== 'reader' || !routeId) { setReaderLoading(false); return; }
    const controller = new AbortController();
    let current = true;
    setReaderLoading(true);
    void api<ArticleDetail>(`/articles/${encodeURIComponent(routeId)}`, { signal: controller.signal })
      .then(article => { if (current) setDetail(article); })
      .catch(error => { if (current) setReaderError(message(error)); })
      .finally(() => { if (current) setReaderLoading(false); });
    return () => { current = false; controller.abort(); };
  }, [route.view, routeId, readerRevision]);

  async function act(key: string, action: () => Promise<unknown>, success?: string): Promise<boolean> {
    if (busyRef.current) return false;
    busyRef.current = true; setBusy(key); setNotice(null);
    try {
      await action(); await refresh();
      if (route.view === 'articles') await loadArticles();
      if (success) setNotice({ type: 'success', text: success });
      return true;
    } catch (error) { setNotice({ type: 'error', text: message(error) }); return false; }
    finally { busyRef.current = false; setBusy(''); }
  }
  function openModal(next: Modal) { setNotice(null); setSingleSelection(null); setModal(next); }
  function closeModal() { if (!busyRef.current) { setModal(null); setSingleSelection(null); } }
  function browseAccount(accountId: string) {
    useUIStore.getState().setFilters({ accountId });
    navigate('articles', accountId ? { accountId } : {});
  }
  function openReader(article: Article, mode: ReaderMode = 'body') {
    if (route.view !== 'reader' || !routeId) returnRoute.current = window.location.hash.slice(1) || 'articles';
    useUIStore.getState().setReaderMode(mode);
    navigate('reader', { id: article.id });
  }
  async function downloadArticle(article: Article) {
    if (!['discovered', 'partial'].includes(article.status)) return;
    let job: Job | undefined;
    const success = await act(`download:${article.id}`, async () => {
      job = await api<Job>('/jobs', { method: 'POST', body: JSON.stringify({ accountId: article.accountId, articleIds: [article.id] }) });
      useUIStore.getState().removeSelected([article.id]);
    }, `已为《${article.title}》建立下载任务。`);
    if (success && job) navigate('jobs', { id: job.id });
  }
  function recheck(article: Article) { setNotice(null); setSingleSelection([article]); setModal({ type: 'confirm' }); }
  const selection = singleSelection || Object.values(selected);
  async function createJobs() {
    // Freeze this confirmation; a refresh or a later filter cannot change its IDs.
    const snapshot = [...selection];
    const success = await act('create-jobs', async () => {
      let created = 0;
      try {
        for (const accountId of new Set(snapshot.map(article => article.accountId))) {
          const ids = snapshot.filter(article => article.accountId === accountId).map(article => article.id);
          await api<Job>('/jobs', { method: 'POST', body: JSON.stringify({ accountId, articleIds: ids }) });
          created += ids.length; useUIStore.getState().removeSelected(ids);
        }
      } catch (error) {
        if (created) throw new Error(`已建立 ${created} 篇文章的任务，其余尚未建立。${message(error)}`);
        throw error;
      }
    }, `已为 ${snapshot.length} 篇文章建立采集任务。`);
    if (success) { setModal(null); setSingleSelection(null); navigate('jobs'); }
  }
  return {
    route, accounts, jobs, jobHistory, historyLoading, historyError, loadJobHistory, summary, articles, articleTotal, articlePage, articlePageSize, library, libraryFilters, setLibraryFilters, detail, initialLoading, articleLoading, readerLoading, libraryLoading,
    serviceError, articleError, readerError, libraryError, notice, setNotice, busy, modal, setModal, selection,
    reloadLibrary: () => setLibraryRevision(value => value + 1),
    reloadReader: () => setReaderRevision(value => value + 1),
    refresh, loadArticles, act, openModal, closeModal, browseAccount, openReader, downloadArticle, recheck, createJobs,
    changeArticlePage: (page: number) => {
      articlesRequest.current++; setArticleLoading(true);
      setPagination({ filterKey, page: Math.max(1, Math.min(page, Math.max(1, Math.ceil(articleTotal / articlePageSize)))) });
    },
    accountName: (id: string) => accounts.find(account => account.id === id)?.name || '公众号',
    backToDirectory: () => { window.location.hash = returnRoute.current; },
  };
}
export type ArchiveModel = ReturnType<typeof useArchive>;
