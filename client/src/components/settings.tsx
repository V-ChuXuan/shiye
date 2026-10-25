import { useEffect, useState } from 'react';
import { CheckCircle2, ChevronRight, FolderOpen, Save } from 'lucide-react';
import type { AppSettings, SettingsUpdateResult } from '../../../shared/types';
import type { ArchiveModel } from '../hooks/use-archive';
import { api } from '../lib/api';
import { LoadingState } from './common';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Checkbox } from './ui/checkbox';

export function SettingsPage({ model }: { model: ArchiveModel }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [directory, setDirectory] = useState('');
  const [migrateExisting, setMigrateExisting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [feedback, setFeedback] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    void api<AppSettings>('/settings', { signal: controller.signal }).then(value => {
      setSettings(value); setDirectory(value.imageDirectory);
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '暂时无法读取设置。');
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [retry]);
  const busy = Boolean(model.busy);
  const directoryChanged = Boolean(settings && directory.trim() !== settings.imageDirectory);
  const showDirectoryHelp = directoryChanged || migrateExisting;
  async function chooseDirectory() {
    await model.act('choose-directory', async () => {
      const selected = await api<{ path: string | null }>('/settings/choose-directory', { method: 'POST', body: '{}' });
      if (selected.path !== null) { setDirectory(selected.path); setFeedback(''); setWarnings([]); }
    });
  }
  async function save() {
    setFeedback(''); setWarnings([]);
    await model.act('save-settings', async () => {
      const result = await api<SettingsUpdateResult>('/settings', { method: 'PUT', body: JSON.stringify({ imageDirectory: directory.trim(), migrateExisting }) });
      setSettings(result.settings); setDirectory(result.settings.imageDirectory); setWarnings(result.warnings);
      setFeedback(migrateExisting ? `保存位置已更新，已迁移 ${result.migratedImages} 张图片。` : '保存位置已更新。');
      setMigrateExisting(false);
    });
  }
  return <><div className="page-heading"><div><h1>设置</h1></div></div>
    {loading ? <LoadingState label="正在读取保存设置…" /> : error ? <div className="settings-read-error"><p role="alert" className="inline-error">{error}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>重新读取设置</Button></div> : settings && <section className="settings-panel" aria-labelledby="storage-heading">
      <div className="settings-panel-heading"><FolderOpen aria-hidden="true" /><div><h2 id="storage-heading">图片保存位置</h2></div></div>
      <form className="settings-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="sr-only" htmlFor="image-directory">正文图片保存位置</label>
        <div className="directory-field"><Input id="image-directory" value={directory} required autoComplete="off" spellCheck={false} disabled={busy} aria-describedby={showDirectoryHelp ? 'directory-help' : undefined} onChange={event => { setDirectory(event.target.value); setFeedback(''); setWarnings([]); }} />{settings.canChooseDirectory && <Button type="button" variant="outline" disabled={busy} onClick={() => void chooseDirectory()}><FolderOpen aria-hidden="true" />{model.busy === 'choose-directory' ? '等待选择…' : '选择文件夹'}</Button>}</div>
        {showDirectoryHelp && <p id="directory-help" className="field-hint">{migrateExisting ? '迁移后清理旧副本；失败时保留原图。' : '新下载使用此位置，已有图片保留在原处并可继续读取。'}</p>}
        <label className="migration-option" htmlFor="migrate-existing"><Checkbox id="migrate-existing" checked={migrateExisting} disabled={busy} aria-describedby={showDirectoryHelp ? 'directory-help' : undefined} onCheckedChange={checked => setMigrateExisting(checked === true)} /><span>同时迁移已有图片</span></label>
        <div className="settings-actions"><Button type="submit" disabled={busy || !directory.trim() || directory.trim() === settings.imageDirectory && !migrateExisting}><Save aria-hidden="true" />{model.busy === 'save-settings' ? migrateExisting ? '正在校验并迁移…' : '正在保存…' : migrateExisting ? '保存并迁移图片' : '保存位置'}</Button>{directory.trim() !== settings.defaultImageDirectory && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setDirectory(settings.defaultImageDirectory); setFeedback(''); setWarnings([]); }}>恢复默认</Button>}</div>
      </form>
      {feedback && <p role="status" className="settings-success"><CheckCircle2 aria-hidden="true" />{feedback}</p>}
      {warnings.length > 0 && <div role="status" className="settings-warning"><p>新位置已生效，以下旧文件副本尚未清理：</p><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
    </section>}
    <details className="settings-advanced"><summary><ChevronRight aria-hidden="true" />高级</summary><div className="legacy-migration"><Button variant="outline" disabled={busy} onClick={() => model.openModal({ type: 'import' })}><FolderOpen aria-hidden="true" />迁移旧版资料</Button></div></details>
  </>;
}
