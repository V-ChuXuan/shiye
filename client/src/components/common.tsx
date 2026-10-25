import { useEffect, useState, type ReactNode } from 'react';
import { AlertCircle, BookOpen, ImageOff, X } from 'lucide-react';
import type { ArticleStatus, JobStatus } from '../../../shared/types';
import { Alert, AlertDescription } from './ui/alert';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Skeleton } from './ui/skeleton';
import type { Notice } from '../hooks/use-archive';

export const articleLabels: Record<ArticleStatus, string> = { discovered: '待采集', downloading: '采集中', partial: '待补全', complete: '已归档', unavailable: '不可访问' };
export const jobLabels: Record<JobStatus, string> = { queued: '排队中', running: '进行中', paused: '已暂停', waiting_session: '等待连接', blocked: '访问受阻', partial: '待补全', completed: '已完成', failed: '未完成' };
export const connectionLabels = { connected: '微信已连接', disconnected: '尚未连接', expired: '需要重新连接', blocked: '微信访问受阻' };

export function Status({ value, children }: { value: string; children: ReactNode }) {
  return <Badge variant="outline" className={`status status-${value}`}>{children}</Badge>;
}
export function NoticeBanner({ notice, onClose }: { notice: Notice; onClose?: () => void }) {
  return <Alert variant={notice.type === 'error' ? 'destructive' : 'default'} className={`notice notice-${notice.type}`} role={notice.type === 'error' ? 'alert' : 'status'}>
    {notice.type === 'error' && <AlertCircle aria-hidden="true" />}<AlertDescription>{notice.text}</AlertDescription>
    {onClose && <Button variant="ghost" size="icon-sm" aria-label="关闭消息" onClick={onClose}><X aria-hidden="true" /></Button>}
  </Alert>;
}
export function EmptyState({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return <div className="empty-state"><BookOpen aria-hidden="true" className="size-9 text-primary" /><h2>{title}</h2><p>{description}</p>{children && <div className="empty-actions">{children}</div>}</div>;
}
export function LoadingState({ label = '正在读取本地文库…' }: { label?: string }) {
  return <div role="status" aria-label={label} className="loading-state"><span className="sr-only">{label}</span><Skeleton className="h-7 w-48" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>;
}
export function LocalImage({ src, alt, onFailure, className = '', compact = false }: { src: string; alt: string; onFailure?: () => void; className?: string; compact?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return failed ? <span className={`image-load-error${compact ? ' image-load-error-compact' : ''}`} role="status" aria-label={compact ? '封面暂不可用' : undefined} title={compact ? '封面暂不可用' : undefined}><ImageOff aria-hidden="true" /><span className={compact ? 'sr-only' : undefined}>{compact ? '封面暂不可用' : '本地图片暂时无法读取'}</span>{!compact && <small>{alt}</small>}</span> : <img className={className} src={src} alt={alt} loading="lazy" onError={() => { setFailed(true); onFailure?.(); }} />;
}
