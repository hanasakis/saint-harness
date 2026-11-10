import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TextQuote, X } from 'lucide-react';
import type { SelectionQuote } from '../shared/types';

export function QuoteSelection({ quotes, onChange }: { quotes: SelectionQuote[]; onChange: (quotes: SelectionQuote[]) => void }) {
  const [open, setOpen] = useState(false), id = useId();
  const chip = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const hide = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 140); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !quotes.length) return;
    const position = () => {
      if (!chip.current || !popup.current) return;
      const a = chip.current.getBoundingClientRect(), p = popup.current, r = p.getBoundingClientRect();
      p.style.left = `${Math.max(8, Math.min(a.left, innerWidth - r.width - 8))}px`;
      p.style.top = `${Math.max(40, a.top - r.height - 9)}px`;
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    position(); document.addEventListener('keydown', key, true); window.addEventListener('resize', position); window.addEventListener('scroll', position, true);
    return () => { document.removeEventListener('keydown', key, true); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [open, quotes]);
  if (!quotes.length) return null;
  return <div className="quoteselections">
    <div className="quotechip" ref={chip} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={e => { if (!popup.current?.contains(e.relatedTarget as Node)) hide(); }}>
      <button aria-label={`查看 ${quotes.length} 段引用`} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(v => !v)}><TextQuote/>{quotes.length} 段引用</button>
      <button className="removequote" aria-label="移除全部引用" onClick={() => { onChange([]); setOpen(false); }}><X/></button>
    </div>
    {open && createPortal(<div className="quotepopover glass" id={id} ref={popup} role="region" aria-label="Selected text 选中文字" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) hide(); }}>
      <div className="quoteheading"><TextQuote/><strong>Selected text</strong><span>选中文字</span></div>
      <div className="quotelist">{quotes.map((quote, i) => <section key={i}><div className="quotesource"><span>{i + 1}. {quote.title}</span><button aria-label={`移除第 ${i + 1} 段引用`} onClick={() => onChange(quotes.filter((_, at) => at !== i))}><X/></button></div><p>{quote.text}</p></section>)}</div>
    </div>, document.body)}
  </div>;
}
