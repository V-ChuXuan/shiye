import { useEffect, useState, type ReactNode } from 'react';
import { Download, FolderOpen, Link2, Search } from 'lucide-react';
import type { AppSettings, ImportResult, Job } from '../../../shared/types';
import type { ArchiveModel } from '../hooks/use-archive';
import { api } from '../lib/api';
import { navigate } from '../lib/route';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { NoticeBanner } from './common';

function Frame({ model, title, caption, children }: { model: ArchiveModel; title: string; caption?: string; children: ReactNode }) {
  return <Dialog open onOpenChange={open => { if (!open) model.closeModal(); }}><DialogContent className="form-dialog" showCloseButton={!model.busy}><DialogHeader><DialogTitle>{title}</DialogTitle>{caption && <DialogDescription>{caption}</DialogDescription>}</DialogHeader>{model.notice?.type === 'error' && <NoticeBanner notice={model.notice} />}{children}</DialogContent></Dialog>;
}
function AddDialog({ model }: { model: ArchiveModel }) {
  const [url, setUrl] = useState('');
  return <Frame model={model} title="添加一个公众号" caption="从一篇文章识别公众号，建立可持续更新的目录。"><form onSubmit={event => { event.preventDefault(); void model.act('add', async () => { await api('/accounts', { method: 'POST', body: JSON.stringify({ url: url.trim() }) }); model.setModal(null); navigate('accounts'); }, '公众号已添加。连接微信后可以发现历史文章。'); }}><label>公众号文章链接<Input type="url" autoFocus required disabled={Boolean(model.busy)} value={url} onChange={event => setUrl(event.target.value)} placeholder="https://mp.weixin.qq.com/s/…" /></label><p className="field-hint">在微信文章右上角选择「复制链接」。这一步只识别公众号，不会下载整号历史。</p><div className="dialog-actions"><Button type="button" variant="outline" disabled={Boolean(model.busy)} onClick={model.closeModal}>取消</Button><Button type="submit" disabled={Boolean(model.busy)}>{model.busy === 'add' ? '识别中…' : '识别并添加'}</Button></div></form></Frame>;
}
function ImportDialog({ model }: { model: ArchiveModel }) {
  const [path, setPath] = useState('');
  const [limit, setLimit] = useState('20');
  const [report, setReport] = useState<ImportResult | null>(null);
  const [canChooseDirectory, setCanChooseDirectory] = useState<boolean | null>(null);
  const busy = Boolean(model.busy);
  useEffect(() => {
    const controller = new AbortController();
    void api<AppSettings>('/settings', { signal: controller.signal }).then(settings => setCanChooseDirectory(settings.canChooseDirectory)).catch(() => {
      if (!controller.signal.aborted) setCanChooseDirectory(false);
    });
    return () => controller.abort();
  }, []);
  async function chooseDirectory() {
    await model.act('choose-legacy-directory', async () => {
      const selected = await api<{ path: string | null }>('/settings/choose-directory', { method: 'POST', body: '{}' });
      if (selected.path !== null) { setPath(selected.path); setReport(null); }
    });
  }
  return <Frame model={model} title="迁移旧版资料"><form onSubmit={event => {
    event.preventDefault();
    void model.act('import', async () => setReport(await api<ImportResult>('/import', { method: 'POST', body: JSON.stringify({ path: path.trim(), ...(limit ? { limit: Number(limit) } : {}) }) })));
  }}>
    {canChooseDirectory !== false && <Button type="button" variant="outline" className="legacy-choose-directory" disabled={busy || canChooseDirectory === null} onClick={() => void chooseDirectory()}><FolderOpen aria-hidden="true" />{model.busy === 'choose-legacy-directory' ? '等待选择…' : '选择文件夹'}</Button>}
    <label htmlFor="legacy-directory">旧归档文件夹<Input id="legacy-directory" autoFocus={canChooseDirectory === false} required disabled={busy} value={path} onChange={event => { setPath(event.target.value); setReport(null); }} placeholder="E:\资料\archive" autoComplete="off" spellCheck={false} aria-describedby="legacy-directory-help" /></label>
    <p id="legacy-directory-help" className="field-hint">选择含 index.jsonl 的旧 archive 文件夹；只复制资料，原文件保留。</p>
    <label>本次最多迁移篇数<Input type="number" min="1" max="10000" disabled={busy} value={limit} onChange={event => setLimit(event.target.value)} placeholder="留空使用默认上限" /></label>
    {report && <div className="import-report" role="status"><strong>本次迁移结果</strong><p>{report.accounts} 个公众号 · {report.articles} 篇文章 · {report.images} 张图片{report.skipped ? ` · 跳过 ${report.skipped} 篇` : ''}</p>{report.errors.length > 0 && <div className="import-errors">{report.errors.slice(0, 5).map((error, index) => <p key={index}>{error}</p>)}{report.errors.length > 5 && <p>另有 {report.errors.length - 5} 条未完成记录。</p>}</div>}</div>}
    <div className="dialog-actions"><Button type="button" variant="outline" disabled={busy} onClick={() => { model.closeModal(); if (report?.articles) navigate('reader'); }}>{report?.articles ? '去阅读室' : '取消'}</Button><Button type="submit" disabled={busy || !path.trim()}><FolderOpen aria-hidden="true" />{model.busy === 'import' ? '正在复制与校验…' : '开始迁移'}</Button></div>
  </form></Frame>;
}
function ConfirmDialog({ model }: { model: ArchiveModel }) {
  const groups = [...new Set(model.selection.map(article => article.accountId))];
  return <Frame model={model} title={`采集选中的 ${model.selection.length} 篇文章`} caption="任务会固定保存当前选择，中断后可以继续。"><div className="selection-review">{groups.map(id => <div key={id}><span>{model.accountName(id)}</span><strong>{model.selection.filter(article => article.accountId === id).length} 篇</strong></div>)}</div><p className="field-hint">只处理选中的文章。复用已验证的本地图片，遇到微信验证或访问限制时保存进度并暂停。</p><div className="dialog-actions"><Button variant="outline" disabled={Boolean(model.busy)} onClick={model.closeModal}>再看一下</Button><Button disabled={!model.selection.length || Boolean(model.busy)} onClick={() => void model.createJobs()}><Download aria-hidden="true" />{model.busy === 'create-jobs' ? '建立任务中…' : '确认建立任务'}</Button></div></Frame>;
}
function DiscoverDialog({ model }: { model: ArchiveModel }) {
  const [maxPages, setMaxPages] = useState(20);
  const [maxArticles, setMaxArticles] = useState(100);
  if (model.modal?.type !== 'discover') return null;
  const selectedAccount = model.modal.account;
  const account = model.accounts.find(item => item.id === selectedAccount.id) || selectedAccount;
  return <Frame model={model} title={`发现「${account.name}」的文章`} caption="先取得清单，之后再选择需要保存的范围。"><form onSubmit={event => { event.preventDefault(); void model.act(`discover:${account.id}`, async () => { await api<Job>(`/accounts/${account.id}/discover`, { method: 'POST', body: JSON.stringify({ maxPages, maxArticles }) }); model.setModal(null); navigate('jobs'); }, '文章发现任务已建立，不会自动下载清单。'); }}>{account.connection !== 'connected' && <div className="connection-instruction"><Link2 aria-hidden="true" /><p>先在电脑微信打开该公众号的一篇文章，再点击公众号页的「连接微信」。</p></div>}<label>本次最多发现篇数<Input type="number" autoFocus min="1" max="10000" required disabled={Boolean(model.busy)} value={maxArticles} onChange={event => setMaxArticles(Number(event.target.value))} /></label><label>最多检查批次<Input type="number" min="1" max="200" required disabled={Boolean(model.busy)} value={maxPages} onChange={event => setMaxPages(Number(event.target.value))} /></label><p className="field-hint">每批最多10条推送，可能包含多篇文章。达到任一上限就暂停，可从任务中心继续；微信要求验证时暂停。</p><div className="dialog-actions"><Button type="button" variant="outline" disabled={Boolean(model.busy)} onClick={model.closeModal}>取消</Button><Button type="submit" disabled={Boolean(model.busy)}><Search aria-hidden="true" />{model.busy.startsWith('discover:') ? '建立任务中…' : '开始发现文章'}</Button></div></form></Frame>;
}
export function ArchiveDialogs({ model }: { model: ArchiveModel }) {
  switch (model.modal?.type) {
    case 'add': return <AddDialog model={model} />;
    case 'import': return <ImportDialog model={model} />;
    case 'confirm': return <ConfirmDialog model={model} />;
    case 'discover': return <DiscoverDialog model={model} />;
    default: return null;
  }
}
