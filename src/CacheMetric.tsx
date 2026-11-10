import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { SessionStats } from '../shared/types';
import { cacheHitRate } from '../shared/usage';
import { number } from './components';

export function CacheMetric({ stats }: { stats?: SessionStats }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null), tooltip = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId(), rate = cacheHitRate(stats);
  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const hide = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 120); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const a = anchor.current!.getBoundingClientRect(), el = tooltip.current!, t = el.getBoundingClientRect();
      el.style.left = `${Math.max(8, Math.min(a.left, innerWidth - t.width - 8))}px`;
      el.style.top = `${Math.max(40, a.top - t.height - 10)}px`;
    };
    position(); window.addEventListener('resize', position);
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', key);
    return () => { window.removeEventListener('resize', position); document.removeEventListener('keydown', key); };
  }, [open, stats]);
  return <>
    <button className="cachemetric" ref={anchor} aria-describedby={open ? id : undefined}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide} onClick={() => setOpen(v => !v)}>
      <span>缓存命中率</span><b>{rate == null ? '—' : `${rate.toFixed(1)}%`}</b>
    </button>
    {open && createPortal(<div id={id} ref={tooltip} role="tooltip" className="cachetooltip glass" onMouseEnter={show} onMouseLeave={hide}>
      <div className="cachetooltipheading"><strong>会话缓存</strong><span>{rate == null ? '暂无统计' : `${rate.toFixed(1)}% 命中`}</span></div>
      <p>复用的输入越多，缓存命中率越高。</p>
      <dl><div><dt>缓存读取</dt><dd>{number(stats?.tokens.cacheRead)} <small>tokens</small></dd></div><div><dt>缓存写入</dt><dd>{number(stats?.tokens.cacheWrite)} <small>tokens</small></dd></div></dl>
      <div className="cacheformula">缓存读取 ÷（普通输入 + 缓存读取 + 缓存写入）</div>
      <p className="cachefootnote">按当前会话累计。服务未报告缓存量时，无法区分未命中与不支持统计。</p>
    </div>, document.body)}
  </>;
}
