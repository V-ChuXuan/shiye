import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronLeft, ChevronRight, CircleAlert, CircleX, Download, FileText, Images, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import type { Article } from '../../../shared/types';
import { navigate } from '../lib/route';
import { useUIStore } from '../store/ui-store';
import type { ArchiveModel } from '../hooks/use-archive';
import { EmptyState, LoadingState, LocalImage } from './common';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';
import { SelectControl } from './ui/select-control';
import { DatePicker } from './ui/date-picker';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

const listStates = {
  complete: { icon: CheckCircle2, label: '已下载' }, discovered: { icon: Download, label: '待采集' },
  downloading: { icon: LoaderCircle, label: '采集中' }, partial: { icon: CircleAlert, label: '待补全' },
  unavailable: { icon: CircleX, label: '不可访问' },
} as const;

function CoverThumbnail({ article, onPreview }: { article: Article; onPreview: () => void }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => setFailed(false), [article.coverSource, article.coverUrl]);
  return <Button variant="ghost" className="article-thumb article-cover-button" aria-label={`${failed ? '重试' : '预览'}《${article.title}》的封面`} title={failed ? '重新加载封面' : '预览封面'} onClick={() => {
    if (failed) { setFailed(false); setAttempt(value => value + 1); } else onPreview();
  }}><LocalImage key={`${article.coverSource || article.coverUrl}:${attempt}`} src={article.coverUrl!} alt="" compact onFailure={() => setFailed(true)} /></Button>;
}

function ArticleAction({ article, model }: { article: Article; model: ArchiveModel }) {
  const pending = model.busy === `download:${article.id}`;
  const hasImages = article.imageCount > 0;
  const action = article.status === 'complete' ? hasImages ? '查看图集' : '阅读全文' : article.status === 'discovered' ? '下载' : article.status === 'partial' ? '补全' : undefined;
  const Icon = pending ? LoaderCircle : article.status === 'complete' ? hasImages ? Images : FileText : listStates[article.status].icon;
  const content = <span className={`article-state article-state-${article.status}`}><Icon aria-hidden="true" /><span>{pending ? '提交中' : action || listStates[article.status].label}</span></span>;
  return action ? <Button variant="link" className="article-state-action" aria-label={`${action}《${article.title}》`} aria-busy={pending} disabled={Boolean(model.busy)} onClick={() => {
    if (article.status === 'complete') model.openReader(article, hasImages ? 'gallery' : 'body');
    else void model.downloadArticle(article);
  }}>{content}</Button> : content;
}

export function ArticlesPage({ model }: { model: ArchiveModel }) {
  const [preview, setPreview] = useState<Article | null>(null);
  const filters = useUIStore(state => state.filters);
  const selected = useUIStore(state => state.selected);
  const setFilters = useUIStore(state => state.setFilters);
  const selectedCount = Object.keys(selected).length;
  const eligible = model.articles.filter(article => !['complete', 'unavailable'].includes(article.status));
  const allSelected = eligible.length > 0 && eligible.every(article => Boolean(selected[article.id]));
  const partlySelected = !allSelected && eligible.some(article => Boolean(selected[article.id]));
  const visibleSelected = model.articles.filter(article => selected[article.id]).length;
  const missingCovers = model.articles.some(article => !article.coverUrl && article.status !== 'unavailable');
  const coverAccount = filters.accountId ? model.accounts.find(account => account.id === filters.accountId) : model.accounts.length === 1 ? model.accounts[0] : undefined;
  return <><div className="page-heading"><div><h1>文章目录</h1></div><Button variant="outline" disabled={model.articleLoading} onClick={() => void model.loadArticles()}><RefreshCw aria-hidden="true" />{model.articleLoading ? '刷新中…' : '刷新目录'}</Button></div>
    <form className="filter-bar" onSubmit={event => { event.preventDefault(); void model.loadArticles(); }}>
      <label className="search-field"><span className="sr-only">搜索文章标题</span><Search aria-hidden="true" /><Input type="search" value={filters.q} placeholder="搜索文章标题…" onChange={event => setFilters({ q: event.target.value })} /></label>
      <SelectControl label="筛选公众号" value={filters.accountId} onValueChange={model.browseAccount} options={[{ value: '', label: '全部公众号' }, ...model.accounts.map(account => ({ value: account.id, label: account.name }))]} />
      <SelectControl label="筛选归档状态" value={filters.status} onValueChange={status => setFilters({ status })} options={[{ value: '', label: '全部状态' }, ...Object.entries(listStates).map(([value, { label }]) => ({ value, label }))]} />
      <div className="date-range" role="group" aria-label="发布日期范围"><DatePicker label="开始日期" value={filters.since} max={filters.until || undefined} onValueChange={since => setFilters({ since })} /><span>至</span><DatePicker label="结束日期" value={filters.until} min={filters.since || undefined} onValueChange={until => setFilters({ until })} />{(filters.since || filters.until) && <Button type="button" variant="ghost" size="icon-sm" aria-label="清空日期" onClick={() => setFilters({ since: '', until: '' })}><X aria-hidden="true" /></Button>}</div>
      {Object.values(filters).some(Boolean) && <Button type="button" variant="ghost" size="icon" aria-label="清空筛选" onClick={() => { useUIStore.getState().resetFilters(); navigate('articles'); }}><X aria-hidden="true" /></Button>}
    </form>
    {missingCovers && <div className="cover-hint"><p>部分文章尚无封面。连接微信后重新发现文章可补齐封面，不会采集正文。{!coverAccount && '请先筛选一个公众号。'}</p><Button variant="outline" size="sm" disabled={!coverAccount || Boolean(model.busy)} onClick={() => { if (coverAccount) model.openModal({ type: 'discover', account: coverAccount }); }}>补充封面</Button></div>}
    <div className="catalogue-toolbar"><div className="catalogue-summary"><span>{model.articleTotal} 篇</span>{selectedCount > 0 && <details className="selection-details"><summary><strong aria-live="polite">已选 {selectedCount} 篇</strong></summary><p>本页 {visibleSelected} 篇 · 其他页或筛选外 {selectedCount - visibleSelected} 篇</p></details>}</div><div>{selectedCount > 0 && <Button variant="ghost" onClick={() => useUIStore.getState().clearSelection()}>清空选择</Button>}<Button disabled={!selectedCount || Boolean(model.busy)} onClick={() => model.openModal({ type: 'confirm' })}><Download aria-hidden="true" />{selectedCount ? `下载${selectedCount}篇` : '下载所选'}</Button></div></div>
    {model.articleError && <p role="alert" className="inline-error">{model.articleError}</p>}
    {model.articleLoading && !model.articles.length ? <LoadingState label="正在读取文章目录…" /> : model.articles.length ? <div className="article-table-wrap"><Table><TableHeader><TableRow><TableHead className="checkbox-cell"><Checkbox aria-label="选择当前页所有待采集文章" checked={allSelected} indeterminate={partlySelected} disabled={!eligible.length} onCheckedChange={checked => useUIStore.getState().selectVisible(eligible, checked)} /></TableHead><TableHead>文章</TableHead><TableHead className="date-col">发布时间</TableHead><TableHead className="image-col">图片</TableHead><TableHead className="article-status-col">状态</TableHead></TableRow></TableHeader><TableBody>{model.articles.map(article => <TableRow key={article.id} data-selected={Boolean(selected[article.id])} data-downloaded={article.status === 'complete'}><TableCell className="checkbox-cell">{article.status === 'complete' ? <span className="downloaded-marker" role="img" aria-label="已下载，无需重复采集" title="已下载，无需重复采集"><CheckCircle2 aria-hidden="true" /></span> : <Checkbox aria-label={`选择 ${article.title}`} checked={Boolean(selected[article.id])} disabled={article.status === 'unavailable'} onCheckedChange={() => useUIStore.getState().toggleArticle(article)} />}</TableCell><TableCell><div className="article-title-cell">{article.coverUrl ? <CoverThumbnail article={article} onPreview={() => setPreview(article)} /> : <span className="article-thumb thumb-placeholder" title="暂无封面，重新发现文章可补充"><FileText aria-hidden="true" /></span>}<div><Button variant="link" className="article-title" onClick={() => model.openReader(article)}>{article.title || '未命名文章'}</Button><span className="article-account">{model.accountName(article.accountId)}</span>{article.error && <span className="article-error">{article.error}</span>}</div></div></TableCell><TableCell className="date-col">{article.publishedAt.slice(0, 10) || '待获取'}</TableCell><TableCell className="image-col">{article.imageCount ? `${article.savedImageCount} / ${article.imageCount}` : '—'}</TableCell><TableCell className="article-status-col"><ArticleAction article={article} model={model} /></TableCell></TableRow>)}</TableBody></Table></div> : <EmptyState title={model.accounts.length ? '没有匹配的文章' : '还没有文章目录'} description={model.accounts.length ? '调整筛选条件，或回到公众号页发现文章。' : '添加公众号并发现文章。'}><Button variant="outline" onClick={() => navigate('accounts')}>前往公众号</Button></EmptyState>}
    {model.articleTotal > 0 && <nav className="catalogue-pagination" aria-label="文章分页"><span>{(model.articlePage - 1) * model.articlePageSize + 1}–{Math.min(model.articlePage * model.articlePageSize, model.articleTotal)} / {model.articleTotal} 篇</span><div><Button variant="outline" size="sm" disabled={model.articleLoading || model.articlePage === 1} onClick={() => model.changeArticlePage(model.articlePage - 1)}><ChevronLeft aria-hidden="true" />上一页</Button><span aria-live="polite">{model.articlePage} / {Math.max(1, Math.ceil(model.articleTotal / model.articlePageSize))}</span><Button variant="outline" size="sm" disabled={model.articleLoading || model.articlePage * model.articlePageSize >= model.articleTotal} onClick={() => model.changeArticlePage(model.articlePage + 1)}>下一页<ChevronRight aria-hidden="true" /></Button></div></nav>}
    <Dialog open={Boolean(preview)} onOpenChange={open => { if (!open) setPreview(null); }}><DialogContent className="cover-preview-dialog"><DialogHeader><DialogTitle>{preview?.title || '封面预览'}</DialogTitle><DialogDescription>{preview?.status === 'discovered' ? '仅预览封面，正文和图集尚未采集。' : '仅预览封面，不会发起采集任务。'}</DialogDescription></DialogHeader>{preview?.coverUrl && <LocalImage src={preview.coverUrl} alt={`${preview.title}的封面`} className="cover-preview-image" />}</DialogContent></Dialog>
  </>;
}
