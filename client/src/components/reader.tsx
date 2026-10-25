import { useEffect, useRef, useState, type RefObject } from 'react';
import { ArrowLeft, BookOpen, CheckCheck, ExternalLink, Images, List, Maximize2, Search } from 'lucide-react';
import type { Article, ArticleDetail } from '../../../shared/types';
import type { ArchiveModel } from '../hooks/use-archive';
import { useUIStore } from '../store/ui-store';
import { navigate } from '../lib/route';
import { api } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { SelectControl } from './ui/select-control';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from './ui/dialog';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from './ui/resizable';
import { articleLabels, EmptyState, LoadingState, LocalImage, Status } from './common';

const positionWrites = new Map<string, Promise<unknown>>();
function savePosition(id: string, mode: 'body' | 'gallery', top: number) {
  const request = (positionWrites.get(id) || Promise.resolve()).catch(() => {}).then(() => api(`/reading-positions/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ mode, top }), keepalive: true }));
  positionWrites.set(id, request);
  void request.finally(() => { if (positionWrites.get(id) === request) positionWrites.delete(id); }).catch(() => {});
  return request;
}
function useReadingPosition(sheet: RefObject<HTMLElement | null>, id: string, mode: 'body' | 'gallery', wide: boolean) {
  const [error, setError] = useState<'read' | 'save' | null>(null);
  const [revision, setRevision] = useState(0);
  const retrySave = useRef<(() => void) | null>(null);
  useEffect(() => {
    const article = sheet.current;
    if (!article) return;
    const pane = article.closest<HTMLElement>('.reader-scroll');
    const target = pane || window;
    const top = () => Math.max(0, Math.min(10_000_000, Math.round(pane ? pane.scrollTop : window.scrollY)));
    let current = true, ready = false, moved = false, dirty = false, savedTop = 0, intendedTop = 0, writeVersion = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setError(null);
    const restore = () => {
      if (!ready || moved) return;
      if (pane) pane.scrollTo({ top: intendedTop, behavior: 'instant' });
      else window.scrollTo({ top: intendedTop, behavior: 'instant' });
    };
    const flush = () => {
      if (timer) clearTimeout(timer);
      if (!dirty) return;
      dirty = false;
      const version = ++writeVersion;
      void savePosition(id, mode, savedTop)
        .then(() => { if (current && version === writeVersion) setError(null); })
        .catch(() => { if (current && version === writeVersion) setError('save'); });
    };
    const scroll = () => {
      if (!moved) return;
      savedTop = top(); dirty = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, 150);
    };
    const interact = () => { moved = true; };
    retrySave.current = () => { if (current) { savedTop = top(); dirty = true; flush(); } };
    const controller = new AbortController();
    const observer = new ResizeObserver(restore);
    observer.observe(article);
    target.addEventListener('scroll', scroll, { passive: true });
    target.addEventListener('wheel', interact, { passive: true });
    target.addEventListener('touchstart', interact, { passive: true });
    target.addEventListener('pointerdown', interact, { passive: true });
    target.addEventListener('keydown', interact);
    article.addEventListener('load', restore, true);
    window.addEventListener('pagehide', flush);
    void (async () => {
      try {
        await positionWrites.get(id)?.catch(() => {});
        const positions = await api<{ body: number; gallery: number }>(`/reading-positions/${encodeURIComponent(id)}`, { signal: controller.signal });
        if (!current) return;
        if (!positions || !['body', 'gallery'].every(key => typeof positions[key as 'body' | 'gallery'] === 'number' && Number.isFinite(positions[key as 'body' | 'gallery']) && positions[key as 'body' | 'gallery'] >= 0 && positions[key as 'body' | 'gallery'] <= 10_000_000)) throw new Error('Invalid reading position');
        ready = true; intendedTop = positions[mode]; restore();
      } catch { if (current && !moved) setError('read'); }
    })();
    return () => {
      flush(); current = false; controller.abort(); observer.disconnect();
      retrySave.current = null;
      target.removeEventListener('scroll', scroll);
      target.removeEventListener('wheel', interact); target.removeEventListener('touchstart', interact);
      target.removeEventListener('pointerdown', interact); target.removeEventListener('keydown', interact);
      article.removeEventListener('load', restore, true); window.removeEventListener('pagehide', flush);
    };
  }, [sheet, id, mode, wide, revision]);
  return {
    error: error === 'save' ? '阅读位置暂时无法保存。' : error === 'read' ? '阅读位置暂时无法恢复。' : '',
    retryLabel: error === 'save' ? '重试保存位置' : '重新读取位置',
    retry: () => { if (error === 'save') retrySave.current?.(); else setRevision(value => value + 1); },
  };
}

function useWideReader() {
  const [wide, setWide] = useState(() => window.matchMedia('(min-width: 1100px)').matches);
  useEffect(() => { const query = window.matchMedia('(min-width: 1100px)'); const update = () => setWide(query.matches); query.addEventListener('change', update); return () => query.removeEventListener('change', update); }, []);
  return wide;
}
function ReaderDocument({ article, model, wide }: { article: ArticleDetail; model: ArchiveModel; wide: boolean }) {
  const mode = useUIStore(state => state.readerMode);
  const setMode = useUIStore(state => state.setReaderMode);
  const sheet = useRef<HTMLElement>(null);
  const position = useReadingPosition(sheet, article.id, mode, wide);
  const [lightbox, setLightbox] = useState<{ src: string; seq: number; original: boolean } | null>(null);
  const preview = useRef<HTMLDivElement>(null);
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => { setImageFailed(false); setLightbox(null); }, [article.id]);
  const completeAssets = article.assets.filter(asset => asset.localUrl && asset.status === 'complete');
  const lightboxIndex = completeAssets.findIndex(asset => asset.seq === lightbox?.seq);
  const moveImage = (step: number) => {
    const asset = completeAssets[lightboxIndex + step];
    if (asset) setLightbox({ src: asset.localUrl!, seq: asset.seq, original: false });
  };
  const repairLabel = ['downloading', 'unavailable'].includes(article.status) ? null : imageFailed ? '修复图片' : article.status === 'partial' ? '补全内容' : article.status === 'discovered' ? '下载文章' : null;
  const imageButton = (seq: number, src: string, gallery = false) => <Button variant="ghost" className={gallery ? 'gallery-image' : 'reader-image-button'} aria-label={`放大第 ${seq} 张图片`} onClick={() => setLightbox({ src, seq, original: false })}><LocalImage src={src} alt={`${article.title}，第 ${seq} 张图片`} onFailure={() => setImageFailed(true)} />{gallery && <span>{String(seq).padStart(2, '0')}</span>}</Button>;
  return <><article className="reader-sheet" ref={sheet}><header className="reader-heading"><Button variant="link" className="reader-account" onClick={() => model.browseAccount(article.accountId)}>{model.accountName(article.accountId)}</Button><h1>{article.title}</h1><div className="reader-meta"><time>{article.publishedAt || '发布时间待获取'}</time>{article.imageCount > 0 && <span>{article.savedImageCount} / {article.imageCount} 张图片</span>}{article.status !== 'complete' && <Status value={article.status}>{articleLabels[article.status]}</Status>}</div></header>
    {(article.status !== 'complete' || imageFailed) && <div className="reader-warning" role="status"><p>{imageFailed ? '本地图片无法读取。' : '这篇文章尚未完整保存，缺失内容会单独标记。'}</p>{repairLabel && <Button variant="outline" disabled={Boolean(model.busy)} onClick={() => model.recheck(article)}><CheckCheck aria-hidden="true" />{repairLabel}</Button>}</div>}
    {position.error && <div className="reader-position-error"><div className="reader-warning" role="status"><p>{position.error}</p><Button variant="outline" onClick={position.retry}>{position.retryLabel}</Button></div></div>}
    <Tabs value={mode} onValueChange={value => setMode(value === 'gallery' ? 'gallery' : 'body')}><div className="reader-mode"><TabsList aria-label="阅读视图"><TabsTrigger value="body"><BookOpen aria-hidden="true" />正文</TabsTrigger><TabsTrigger value="gallery"><Images aria-hidden="true" />图集</TabsTrigger></TabsList></div>
      <TabsContent value="body"><div className="reader-body">{article.blocks.length ? article.blocks.map((block, index) => {
        if (block.type === 'text') return <p key={index}>{block.text}</p>;
        const asset = article.assets.find(item => item.seq === block.seq);
        return asset?.localUrl && asset.status === 'complete' ? <figure key={index}>{imageButton(asset.seq, asset.localUrl)}<figcaption>{String(asset.seq).padStart(2, '0')} / {String(article.imageCount).padStart(2, '0')}</figcaption></figure> : <div className="image-missing" key={index}>第 {block.seq} 张图片尚未完整保存</div>;
      }) : <p className="reader-empty-copy">正文还未保存到本地。可以返回文章目录选择采集。</p>}</div></TabsContent>
      <TabsContent value="gallery"><div className="reader-gallery">{completeAssets.map(asset => <div key={asset.seq}>{imageButton(asset.seq, asset.localUrl!, true)}</div>)}{!completeAssets.length && <p className="reader-empty-copy">{article.status === 'complete' && article.imageCount === 0 ? '这篇文章没有图片。' : '这篇文章还没有保存到本地的图片。'}</p>}</div></TabsContent>
    </Tabs>
    <footer className="reader-footer">{(article.status !== 'complete' || imageFailed) && <span>{imageFailed ? '本地图片无法读取' : article.status === 'discovered' ? '正文尚未保存到本地' : '归档尚未完整'}</span>}{article.url && <a href={article.url} target="_blank" rel="noopener noreferrer">查看原文<ExternalLink aria-hidden="true" className="size-3.5" /></a>}</footer>
  </article><Dialog open={Boolean(lightbox)} onOpenChange={open => { if (!open) setLightbox(null); }}>
    <DialogContent className="lightbox-dialog" aria-describedby={undefined} onKeyDown={event => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || completeAssets.length < 2 || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      if (lightbox?.original && preview.current && preview.current.scrollWidth > preview.current.clientWidth + 1) return;
      event.preventDefault(); moveImage(event.key === 'ArrowLeft' ? -1 : 1);
    }}>
      <DialogHeader><DialogTitle>图片 {String(lightbox?.seq || '').padStart(2, '0')}</DialogTitle></DialogHeader>
      {lightbox && <><div ref={preview} className="lightbox" data-original={lightbox.original} tabIndex={0} role="region" aria-label="图片预览"><LocalImage key={lightbox.src} src={lightbox.src} alt={`第 ${lightbox.seq} 张本地图片`} onFailure={() => setImageFailed(true)} /></div>
        <div className="lightbox-controls">{completeAssets.length > 1 && <div className="lightbox-navigation"><Button type="button" variant="ghost" disabled={lightboxIndex <= 0} onClick={() => moveImage(-1)}>上一张</Button><span aria-live="polite" aria-atomic="true">{lightboxIndex + 1} / {completeAssets.length}</span><Button type="button" variant="ghost" disabled={lightboxIndex >= completeAssets.length - 1} onClick={() => moveImage(1)}>下一张</Button></div>}
          <Button type="button" variant="ghost" className="lightbox-action" aria-pressed={lightbox.original} onClick={() => setLightbox({ ...lightbox, original: !lightbox.original })}><Maximize2 aria-hidden="true" className="size-4" />{lightbox.original ? '适应窗口' : '查看原图'}</Button>
        </div>
      </>}
    </DialogContent>
  </Dialog></>;
}
function matchingArticles(articles: Article[], model: ArchiveModel) {
  const { q, accountId } = model.libraryFilters;
  const title = q.trim().toLocaleLowerCase();
  return articles.filter(article => (!accountId || article.accountId === accountId) && article.title.toLocaleLowerCase().includes(title));
}
function LibraryFilters({ model }: { model: ArchiveModel }) {
  const { libraryFilters: filters, setLibraryFilters } = model;
  const sources = [...new Set(model.library.map(article => article.accountId))];
  return <form className="library-filters" aria-label="阅读筛选" onSubmit={event => event.preventDefault()}>
    <label className="search-field"><span className="sr-only">搜索已下载文章</span><Search aria-hidden="true" /><Input type="search" maxLength={500} value={filters.q} placeholder="搜索已下载文章…" onChange={event => setLibraryFilters(current => ({ ...current, q: event.target.value }))} /></label>
    {sources.length > 1 && <SelectControl label="筛选阅读公众号" value={filters.accountId} onValueChange={accountId => setLibraryFilters(current => ({ ...current, accountId }))} options={[{ value: '', label: '全部公众号' }, ...sources.map(id => ({ value: id, label: model.accountName(id) }))]} />}
    {(filters.q || filters.accountId) && <Button type="button" variant="ghost" size="sm" aria-label="清空阅读筛选" onClick={() => setLibraryFilters({ q: '', accountId: '' })}>清空</Button>}
  </form>;
}
function ReaderCatalogue({ articles, selectedId, model }: { articles: Article[]; selectedId: string; model: ArchiveModel }) {
  const mode = useUIStore(state => state.readerMode);
  const multipleAccounts = new Set(articles.map(article => article.accountId)).size > 1;
  const matches = matchingArticles(articles, model);
  return <aside className="reader-catalogue" aria-label="阅读目录"><div className="reader-catalogue-heading"><List aria-hidden="true" /><h2>阅读目录</h2><span>{matches.length === articles.length ? articles.length : `${matches.length} / ${articles.length}`}</span></div>
    <LibraryFilters model={model} />
    <div className="reader-catalogue-list">{model.libraryLoading && <p role="status">正在读取阅读目录…</p>}{model.libraryError && <div role="alert"><p>{model.libraryError}</p><Button variant="outline" onClick={model.reloadLibrary}>重新读取目录</Button></div>}{matches.map(article => <Button variant="ghost" key={article.id} aria-current={article.id === selectedId ? 'page' : undefined} className={`reader-catalogue-item ${article.id === selectedId ? 'current' : ''}`} onClick={() => model.openReader(article, mode)}><span>{article.title}</span>{multipleAccounts && <span className="reader-catalogue-source">{model.accountName(article.accountId)}</span>}<small>{article.publishedAt.slice(0, 10)}</small></Button>)}{!matches.length && !model.libraryLoading && !model.libraryError && <p className="reader-empty-copy" role="status">没有匹配的文章</p>}</div></aside>;
}
export function ReaderPage({ model }: { model: ArchiveModel }) {
  const wide = useWideReader();
  const layout = useUIStore(state => state.readerLayout);
  const setLayout = useUIStore(state => state.setReaderLayout);
  const readingId = model.route.params.get('id');
  const matches = matchingArticles(model.library, model);
  if (readingId && (model.readerLoading || model.detail?.id !== readingId) && !model.readerError) return <LoadingState label="正在打开本地文章…" />;
  if (readingId && model.readerError) return <div role="alert" className="reader-warning"><p>{model.readerError}</p><Button variant="outline" onClick={model.reloadReader}>重新读取</Button><Button variant="outline" onClick={() => navigate('reader')}>返回阅读室</Button></div>;
  if (!readingId || !model.detail) return <><div className="page-heading"><div><h1>阅读室</h1></div><span className="text-muted-foreground">{model.libraryLoading ? '' : `${matches.length === model.library.length ? model.library.length : `${matches.length} / ${model.library.length}`} 篇完整归档`}</span></div>{model.libraryError && <div role="alert" className="reader-warning"><p>{model.libraryError}</p><Button variant="outline" onClick={model.reloadLibrary}>重新读取目录</Button></div>}{model.library.length ? <><LibraryFilters model={model} />{matches.length ? <div className="reading-grid">{matches.map(article => <Button variant="ghost" className="reading-card" key={article.id} onClick={() => model.openReader(article)}><div className="reading-cover">{article.coverUrl ? <LocalImage src={article.coverUrl} alt="" /> : <BookOpen aria-hidden="true" className="size-10" />}{article.imageCount > 0 && <span>{article.imageCount} 图</span>}</div><div className="reading-card-copy"><span>{model.accountName(article.accountId)}</span><h2>{article.title}</h2><div><time>{article.publishedAt.slice(0, 10) || '本地归档'}</time></div></div></Button>)}</div> : <p className="reader-empty-copy" role="status">没有匹配的文章</p>}</> : model.libraryLoading ? <LoadingState label="正在读取阅读目录…" /> : model.libraryError ? null : <EmptyState title="阅读室正在等第一篇文章" description="采集文章后，就可以在这里阅读。"><Button onClick={() => navigate('articles')}>前往文章目录</Button></EmptyState>}</>;
  const catalogue = model.library.some(article => article.id === model.detail!.id) ? model.library : [model.detail, ...model.library];
  return <><div className="reader-toolbar"><Button variant="ghost" onClick={model.backToDirectory}><ArrowLeft aria-hidden="true" />返回目录</Button></div>{wide ? <ResizablePanelGroup orientation="horizontal" defaultLayout={layout} onLayoutChanged={setLayout} className="reader-split" aria-label="阅读目录与正文分栏"><ResizablePanel id="catalogue" defaultSize="28%" minSize="18%" maxSize="45%"><ReaderCatalogue articles={catalogue} selectedId={model.detail.id} model={model} /></ResizablePanel><ResizableHandle withHandle aria-label="调整阅读目录宽度" /><ResizablePanel id="content" defaultSize="72%" minSize="55%"><div className="reader-scroll"><ReaderDocument article={model.detail} model={model} wide /></div></ResizablePanel></ResizablePanelGroup> : <ReaderDocument article={model.detail} model={model} wide={false} />}</>;
}
