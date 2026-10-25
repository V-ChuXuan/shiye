import { useEffect, useState } from 'react';
import { ArrowLeft, Link2, Plus, RefreshCw } from 'lucide-react';
import type { Account, Job, UpdatePolicy } from '../../../shared/types';
import { api } from '../lib/api';
import { formatDateTime, formatNumber } from '../lib/format';
import type { ArchiveModel } from '../hooks/use-archive';
import { navigate } from '../lib/route';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { SelectControl } from './ui/select-control';
import { connectionLabels, EmptyState, LoadingState, Status } from './common';

function AccountRow({ account, model, focused, returnJob }: { account: Account; model: ArchiveModel; focused: boolean; returnJob?: Job }) {
  const [policy, setPolicy] = useState(account.updatePolicy);
  const [minutes, setMinutes] = useState(account.intervalMinutes);
  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => { setPolicy(account.updatePolicy); setMinutes(account.intervalMinutes); }, [account.updatePolicy, account.intervalMinutes]);
  useEffect(() => setAvatarFailed(false), [account.avatarSource, account.avatarUrl]);
  const busy = Boolean(model.busy);
  const changed = policy !== account.updatePolicy || minutes !== account.intervalMinutes;
  return <article className="account-item" id={`account-${account.id}`} tabIndex={-1} data-focused={focused} aria-label={`公众号${account.name}`}>
    <div className="account-main"><Button variant="ghost" className="account-avatar" aria-label={`更新${account.name}的头像`} title="更新头像" disabled={busy} onClick={() => { void model.act(`profile:${account.id}`, () => api(`/accounts/${account.id}/profile`, { method: 'POST', body: '{}' }), '公众号头像已更新。').then(saved => { if (saved) setAvatarFailed(false); }); }}>{account.avatarUrl && !avatarFailed ? <img key={account.avatarSource || account.avatarUrl} src={account.avatarUrl} alt="" onError={() => setAvatarFailed(true)} /> : <span aria-hidden="true">{account.name.slice(0, 1)}</span>}</Button><div><Button variant="link" className="account-name" onClick={() => model.browseAccount(account.id)}>{account.name}</Button><div className="account-metadata">{['expired', 'blocked'].includes(account.connection) && <Status value={account.connection}>{connectionLabels[account.connection]}</Status>}<span>{formatNumber(account.articleCount)} 篇已发现 · {formatNumber(account.archivedCount)} 篇完整归档</span></div></div></div>
    <div className="account-coverage"><p>{account.coverage.complete ? '已到达来源历史末尾' : account.coverage.count ? '历史清单为部分覆盖' : '等待首次发现文章'}</p>{account.coverage.oldest && <span>{account.coverage.oldest.slice(0, 10)} — {account.coverage.newest?.slice(0, 10)}</span>}{account.lastCheckedAt && <details className="account-last-check"><summary>最近检查</summary><time>{formatDateTime(account.lastCheckedAt)}</time></details>}</div>
    <div className="account-actions"><Button variant="outline" disabled={busy} onClick={() => void model.act(`connect:${account.id}`, () => api(`/accounts/${account.id}/connect`, { method: 'POST', body: '{}' }), returnJob ? '已连接微信，可以返回原任务继续。' : '已读取目标公众号会话。现在可以发现文章。')}><Link2 aria-hidden="true" />{model.busy === `connect:${account.id}` ? '读取会话中…' : account.connection === 'connected' ? '重新连接' : '连接微信'}</Button><Button disabled={busy} onClick={() => model.openModal({ type: 'discover', account })}><RefreshCw aria-hidden="true" />发现文章</Button>{returnJob && <Button variant="ghost" onClick={() => navigate('jobs', { id: returnJob.id })}><ArrowLeft aria-hidden="true" />返回任务</Button>}</div>
    <details className="schedule"><summary>更新策略 <span>{account.updatePolicy === 'manual' ? '手动更新' : account.updatePolicy === 'discover' ? '定时发现' : '定时发现并采集'}</span></summary><form className="schedule-form" onSubmit={event => { event.preventDefault(); void model.act(`policy:${account.id}`, () => api(`/accounts/${account.id}`, { method: 'PATCH', body: JSON.stringify({ updatePolicy: policy, intervalMinutes: minutes }) }), '更新策略已保存。'); }}>
      <label>更新方式<SelectControl label="更新方式" value={policy} disabled={busy} onValueChange={value => setPolicy(value as UpdatePolicy)} options={[{ value: 'manual', label: '手动更新' }, { value: 'discover', label: '定时发现新文章' }, { value: 'download', label: '定时发现并自动采集' }]} /></label>
      {policy !== 'manual' && <label>检查间隔（分钟）<Input type="number" min="5" max="10080" required value={minutes} disabled={busy} onChange={event => setMinutes(Number(event.target.value))} /></label>}
      <Button type="submit" variant="outline" disabled={busy || !changed}>保存策略</Button><p className="field-hint">会话约15分钟有效；启用或重新连接后先检查，之后按间隔更新。</p>
    </form></details>
  </article>;
}
export function AccountsPage({ model }: { model: ArchiveModel }) {
  const requestedAccount = model.route.params.get('accountId');
  const requestedJob = model.route.params.get('fromJob');
  const account = model.accounts.find(item => item.id === requestedAccount);
  const returnJob = model.jobs.find(job => job.id === requestedJob && job.accountId === account?.id);
  const focusedId = account && (!requestedJob || returnJob) ? account.id : null;
  useEffect(() => {
    if (!focusedId) return;
    const element = document.getElementById(`account-${focusedId}`);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [focusedId, returnJob?.id]);
  return <><div className="page-heading"><div><h1>公众号</h1></div><Button onClick={() => model.openModal({ type: 'add' })}><Plus aria-hidden="true" />添加公众号</Button></div>
    {model.summary && model.accounts.length > 1 && <div className="library-summary" aria-label="文库概况"><span>{formatNumber(model.summary.accountCount)} 个公众号</span><span>{formatNumber(model.summary.archivedCount)} 篇完整归档</span><span>{formatNumber(model.summary.imageCount)} 张本地图片</span></div>}
    {model.initialLoading ? <LoadingState /> : model.accounts.length ? <div className="account-list">{model.accounts.map(account => <AccountRow key={account.id} account={account} model={model} focused={focusedId === account.id} returnJob={focusedId === account.id ? returnJob : undefined} />)}</div> : <EmptyState title="这里将是你的个人文库" description="粘贴一篇公众号文章链接，建立文章目录。"><Button onClick={() => model.openModal({ type: 'add' })}><Plus aria-hidden="true" />添加第一个公众号</Button></EmptyState>}
    {model.accounts.some(account => account.connection !== 'connected') && <div className="page-tip"><Link2 aria-hidden="true" /><p>连接前，请在电脑微信中打开目标公众号的任意一篇文章。连接只在本次运行中有效。</p></div>}
  </>;
}
