import { useEffect, useRef } from 'react';
import { ChevronRight, Download, Pause, Play, RefreshCw, Search } from 'lucide-react';
import type { Job } from '../../../shared/types';
import { api } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { navigate } from '../lib/route';
import type { ArchiveModel } from '../hooks/use-archive';
import { Button } from './ui/button';
import { Progress } from './ui/progress';
import { EmptyState, jobLabels, Status } from './common';

function progressCopy(job: Job) {
  return job.kind === 'archive' ? `已完成 ${job.completed} / ${job.total} 篇${job.failed ? ` · ${job.failed} 篇待处理` : ''}` : `已发现 ${job.coverage?.count ?? job.completed} 篇 · ${job.coverage?.complete ? '已到来源末尾' : '部分清单'}`;
}

function JobActions({ job, model }: { job: Job; model: ArchiveModel }) {
  const resumable = ['paused', 'partial', 'failed', 'waiting_session', 'blocked'].includes(job.status);
  const needsConnection = resumable && (model.summary?.connectionBlocked || model.accounts.find(account => account.id === job.accountId)?.connection !== 'connected');
  return <div className="job-actions">{['running', 'queued'].includes(job.status) && <Button variant="outline" disabled={Boolean(model.busy)} onClick={() => void model.act(`pause:${job.id}`, () => api(`/jobs/${job.id}/pause`, { method: 'POST', body: '{}' }), '暂停请求已保存。')}><Pause aria-hidden="true" />暂停任务</Button>}{needsConnection ? <Button disabled={Boolean(model.busy)} onClick={() => navigate('accounts', { accountId: job.accountId, fromJob: job.id })}>前往连接微信</Button> : resumable && <Button disabled={Boolean(model.busy)} onClick={() => void model.act(`resume:${job.id}`, () => api(`/jobs/${job.id}/resume`, { method: 'POST', body: '{}' }), '任务已重新排队。')}><Play aria-hidden="true" />继续任务</Button>}<Button variant="ghost" onClick={() => model.browseAccount(job.accountId)}>查看文章</Button></div>;
}

export function JobsPage({ model }: { model: ArchiveModel }) {
  const active = model.jobs.filter(job => ['running', 'queued'].includes(job.status));
  const attention = model.jobs.filter(job => !['running', 'queued', 'completed'].includes(job.status));
  const completed = model.jobHistory?.items || [];
  const historyTotal = model.jobHistory?.total || 0;
  const historyPage = model.jobHistory?.page || 1;
  const historySize = model.jobHistory?.pageSize || 20;
  const lastFocused = useRef<string | null>(null);
  const requestedId = model.route.params.get('id');
  const focusedId = [...model.jobs, ...completed].some(job => job.id === requestedId) ? requestedId : null;
  useEffect(() => { lastFocused.current = null; }, [requestedId]);
  useEffect(() => {
    if (!focusedId || lastFocused.current === focusedId) return;
    lastFocused.current = focusedId;
    const element = document.getElementById(`job-${focusedId}`);
    if (element instanceof HTMLDetailsElement) element.open = true;
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [focusedId]);
  const renderJob = (job: Job) => <article className="job-item" key={job.id} id={`job-${job.id}`} tabIndex={-1} data-focused={focusedId === job.id} aria-label={`${job.accountName || model.accountName(job.accountId)}的${job.kind === 'discover' ? '发现文章' : '采集归档'}任务`}><div className="job-heading"><div className="job-title">{job.kind === 'discover' ? <Search aria-hidden="true" /> : <Download aria-hidden="true" />}<div><span>{job.kind === 'discover' ? '发现文章' : '采集归档'}</span><h3>{job.accountName || model.accountName(job.accountId)}</h3></div></div><Status value={job.status}>{jobLabels[job.status]}</Status></div><Progress value={Math.max(0, Math.min(100, job.progress))} aria-label={`${job.accountName} ${job.kind === 'discover' ? '发现' : '采集'}进度`} /><div className="job-progress-copy"><span>{progressCopy(job)}</span><time>{formatDateTime(job.updatedAt || job.createdAt)}</time></div><p className="job-message">{job.message}</p><JobActions job={job} model={model} /></article>;
  return <><div className="page-heading"><div><h1>采集任务</h1></div><Button variant="outline" onClick={() => { void model.refresh(); void model.loadJobHistory(); }}><RefreshCw aria-hidden="true" />刷新进度</Button></div>
    {(model.jobs.length || historyTotal || model.historyLoading || model.historyError) ? <div className="task-sections">{active.length > 0 && <section className="task-section" aria-labelledby="active-jobs-heading"><h2 id="active-jobs-heading">进行中 <span>{active.length}</span></h2><div className="job-list">{active.map(renderJob)}</div></section>}{attention.length > 0 && <section className="task-section" aria-labelledby="attention-jobs-heading"><h2 id="attention-jobs-heading">待处理 <span>{attention.length}</span></h2><div className="job-list">{attention.map(renderJob)}</div></section>}{(historyTotal > 0 || model.historyLoading || model.historyError) && <section className="task-section" aria-labelledby="completed-jobs-heading"><h2 id="completed-jobs-heading">已完成 <span>{model.jobHistory ? historyTotal : ''}</span></h2>{model.historyError && <div className="inline-error" role="alert">{model.historyError}<Button variant="ghost" size="sm" onClick={() => void model.loadJobHistory()}>重试读取历史</Button></div>}{model.historyLoading && <p role="status">正在读取任务历史…</p>}<div className="job-history" aria-busy={model.historyLoading}>{completed.map(job => <details className="job-history-item" key={job.id} id={`job-${job.id}`} tabIndex={-1} data-focused={focusedId === job.id}><summary className="job-history-summary"><ChevronRight className="job-history-chevron" aria-hidden="true" /><span className="job-history-title"><span>{job.kind === 'discover' ? '发现文章' : '采集归档'}</span><strong>{job.accountName || model.accountName(job.accountId)}</strong></span><span className="job-history-count">{progressCopy(job)}</span><time>{formatDateTime(job.updatedAt || job.createdAt)}</time></summary><div className="job-history-detail"><p className="job-message">{job.message}</p><JobActions job={job} model={model} /></div></details>)}</div>{historyTotal > 0 && <nav className="catalogue-pagination" aria-label="任务历史分页"><span>{(historyPage - 1) * historySize + 1}–{Math.min(historyPage * historySize, historyTotal)} / {historyTotal} 条</span><div><Button variant="outline" size="sm" disabled={model.historyLoading || historyPage === 1} onClick={() => void model.loadJobHistory(historyPage - 1, null)}>上一页</Button><span aria-live="polite">{historyPage} / {Math.max(1, Math.ceil(historyTotal / historySize))}</span><Button variant="outline" size="sm" disabled={model.historyLoading || historyPage * historySize >= historyTotal} onClick={() => void model.loadJobHistory(historyPage + 1, null)}>下一页</Button></div></nav>}</section>}</div> : <EmptyState title="采集桌上还没有任务" description="从文章目录勾选需要保存的内容，采集进度会记录在这里。"><Button onClick={() => navigate('articles')}>去选择文章</Button></EmptyState>}
  </>;
}
