import { useEffect, useState } from 'react';

export type View = 'accounts' | 'articles' | 'jobs' | 'reader' | 'settings' | 'about';
const views: View[] = ['accounts', 'articles', 'jobs', 'reader', 'settings', 'about'];
export function getRoute(hash = typeof window === 'undefined' ? '' : window.location.hash) {
  const [path, query = ''] = hash.replace(/^#/, '').split('?');
  return { view: views.includes(path as View) ? path as View : 'accounts' as View, params: new URLSearchParams(query) };
}

export function useRoute() {
  const [route, setRoute] = useState(getRoute);
  useEffect(() => {
    const update = () => setRoute(getRoute());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  return route;
}

export function navigate(view: View, params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  window.location.hash = `${view}${query ? `?${query}` : ''}`;
}

export function focusMainContent(event?: { preventDefault: () => void }) {
  event?.preventDefault();
  document.getElementById('main-content')?.focus();
}
