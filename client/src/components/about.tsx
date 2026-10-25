import { useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { AppInfo } from '../../../shared/types';
import { api } from '../lib/api';
import { LoadingState } from './common';
import { Button } from './ui/button';

export function AboutPage() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<AppInfo>('/about', { signal: controller.signal }).then(setInfo).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '暂时无法读取版本信息。');
    });
    return () => controller.abort();
  }, [retry]);
  return <><div className="page-heading"><div><h1>关于拾页</h1></div></div>
    {error ? <div className="settings-read-error"><p role="alert" className="inline-error">{error}</p><Button variant="outline" onClick={() => setRetry(value => value + 1)}>重新读取版本</Button></div> : !info ? <LoadingState label="正在读取版本信息…" /> : <div className="about-page">
      <section className="about-identity"><img src="/brand/shiye-mark.png" width="72" height="72" alt="" /><div><h2>{info.name}</h2><p className="about-version">版本 {info.version}</p></div></section>
      <details className="about-credits"><summary><ChevronRight aria-hidden="true" />开源致谢</summary><ul><li><a href="https://github.com/shadcn-ui/ui" target="_blank" rel="noopener noreferrer">shadcn/ui Base Nova</a></li><li><a href="https://github.com/lucide-icons/lucide" target="_blank" rel="noopener noreferrer">Lucide</a></li><li><a href="https://github.com/pmndrs/zustand" target="_blank" rel="noopener noreferrer">Zustand</a></li><li><a href="https://github.com/motiondivision/motion" target="_blank" rel="noopener noreferrer">Motion</a></li><li><a href="https://github.com/bvaughn/react-resizable-panels" target="_blank" rel="noopener noreferrer">react-resizable-panels</a></li></ul></details>
    </div>}
  </>;
}
