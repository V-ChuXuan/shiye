import { BookOpen, ClipboardList, Info, List, RefreshCw, Rss, Settings } from 'lucide-react';
import { LazyMotion, domAnimation, m, MotionConfig, useReducedMotion } from 'motion/react';
import { lazy, Suspense, type ReactNode } from 'react';
import { useArchive } from './hooks/use-archive';
import { focusMainContent, navigate, type View } from './lib/route';
import { AccountsPage } from './components/accounts';
import { ArticlesPage } from './components/articles';
import { JobsPage } from './components/jobs';
import { LoadingState, NoticeBanner } from './components/common';
import { Button } from './components/ui/button';

const navigation = [
  { view: 'accounts', label: '公众号', icon: Rss },
  { view: 'articles', label: '文章目录', icon: List },
  { view: 'jobs', label: '采集任务', icon: ClipboardList },
  { view: 'reader', label: '阅读室', icon: BookOpen },
  { view: 'settings', label: '设置', icon: Settings },
  { view: 'about', label: '关于', icon: Info },
] as const;
const ReaderPage = lazy(() => import('./components/reader').then(module => ({ default: module.ReaderPage })));
const ArchiveDialogs = lazy(() => import('./components/dialogs').then(module => ({ default: module.ArchiveDialogs })));
const SettingsPage = lazy(() => import('./components/settings').then(module => ({ default: module.SettingsPage })));
const AboutPage = lazy(() => import('./components/about').then(module => ({ default: module.AboutPage })));

export default function App() {
  const model = useArchive();
  const reducedMotion = useReducedMotion();
  const activeCount = model.jobs.filter(job => ['running', 'queued'].includes(job.status)).length;
  const pages: Record<View, ReactNode> = {
    accounts: <AccountsPage model={model} />, articles: <ArticlesPage model={model} />,
    jobs: <JobsPage model={model} />, reader: <ReaderPage model={model} />,
    settings: <SettingsPage model={model} />, about: <AboutPage />,
  };
  return <MotionConfig reducedMotion="user"><LazyMotion features={domAnimation}><div className="app-shell">
    <button type="button" onClick={focusMainContent} className="skip-link">跳到主内容</button>
    <aside className="sidebar"><button type="button" onClick={() => navigate('accounts')} className="brand" aria-label="拾页，返回公众号"><span className="brand-mark"><img src="/brand/shiye-mark.png" width="42" height="42" alt="" draggable={false} /></span><span><strong>拾页</strong></span></button><nav className="main-nav" aria-label="主导航">{navigation.map(item => <button type="button" key={item.view} data-view={item.view} onClick={() => navigate(item.view)} aria-label={item.label} aria-current={model.route.view === item.view ? 'page' : undefined} className={model.route.view === item.view ? 'active' : ''}><item.icon aria-hidden="true" /><span>{item.label}</span>{item.view === 'jobs' && activeCount > 0 && <span className="nav-count">{activeCount}</span>}</button>)}</nav></aside>
    <main id="main-content" tabIndex={-1} className="main-area"><div className={`page-content ${model.route.view === 'reader' && model.detail ? 'reading-page' : ''} ${['settings', 'about'].includes(model.route.view) ? 'utility-page' : ''}`}>
      {model.serviceError && <div className="service-error" role="alert"><div><strong>暂时无法连接本地服务</strong><p>{model.serviceError}</p></div><Button variant="outline" onClick={() => void model.refresh()}><RefreshCw aria-hidden="true" />重新连接</Button></div>}
      {model.notice && !model.modal && <NoticeBanner notice={model.notice} onClose={() => model.setNotice(null)} />}
      <m.div key={model.route.view} initial={reducedMotion ? false : { opacity: 0.65 }} animate={{ opacity: 1 }} transition={{ duration: reducedMotion ? 0 : 0.12 }} className="view-content"><Suspense fallback={<LoadingState />}>{pages[model.route.view]}</Suspense></m.div>
    </div></main>{model.modal && <Suspense fallback={<span role="status" className="sr-only">正在打开操作面板…</span>}><ArchiveDialogs model={model} /></Suspense>}
  </div></LazyMotion></MotionConfig>;
}
