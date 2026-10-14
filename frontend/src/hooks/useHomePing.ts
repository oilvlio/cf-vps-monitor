import { useEffect, useState } from 'react';
import { fetchHomePingSummary, type HomePingSummary } from '../utils/homePing';

const HOME_PING_REFRESH_MS = 60_000;

// 首页卡片的延迟 / 丢包色块：一次请求拿全部节点，之后每分钟刷新；页面不可见时不拉。
export function useHomePing(enabled: boolean, includeHidden: boolean): HomePingSummary | null {
  const [summary, setSummary] = useState<HomePingSummary | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let controller: AbortController | null = null;

    const load = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      controller?.abort();
      controller = new AbortController();
      fetchHomePingSummary({ includeHidden, signal: controller.signal })
        .then((next) => { if (!cancelled) setSummary(next); })
        .catch(() => { /* 色块是附加信息，失败时保留上一次的数据即可 */ });
    };

    load();
    const timer = window.setInterval(load, HOME_PING_REFRESH_MS);
    document.addEventListener('visibilitychange', load);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [enabled, includeHidden]);

  return summary;
}
