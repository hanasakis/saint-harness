import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Copy, ClipboardPaste, MessageSquarePlus, Quote } from 'lucide-react';
import type { SelectionQuote } from '../shared/types';

type Props = { threadId?: string; title: string; children: ReactNode; onQuote: (quote: SelectionQuote) => void; onSide: (quote: SelectionQuote) => void; onPaste: () => void; onError: (message: string) => void; disabled?: boolean };
export function SelectionActions({ threadId, title, children, onQuote, onSide, onPaste, onError, disabled }: Props) {
  const scope = useRef<HTMLDivElement>(null), menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ quote: SelectionQuote; x: number; y: number }>();
  function selected() {
    const selection = window.getSelection();
    if (!threadId || !selection?.rangeCount || selection.isCollapsed || !selection.toString().trim()) return;
    const range = selection.getRangeAt(0);
    if (!scope.current?.contains(range.startContainer) || !scope.current.contains(range.endContainer)) return;
    const start = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    const row = start?.closest<HTMLElement>('[data-message-entry]');
    if (!row) return;
    return { threadId, title, text: selection.toString(), entryId: row.dataset.messageEntry || undefined };
  }
  function open(x: number, y: number) { const quote = selected(); if (!quote) return false; setMenu({ quote, x, y }); return true; }
  useEffect(() => { setMenu(undefined); }, [threadId]);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const el = menuRef.current, box = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(menu.x, innerWidth - box.width - 8))}px`;
    el.style.top = `${Math.max(36, Math.min(menu.y, innerHeight - box.height - 8))}px`;
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (menu && ['Escape','Tab'].includes(e.key)) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); scope.current?.focus({ preventScroll: true }); } setMenu(undefined); }
      if (!menu && (e.key === 'ContextMenu' || e.shiftKey && e.key === 'F10') && selected()) {
        const rect = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
        e.preventDefault(); e.stopPropagation(); open(rect.left, rect.bottom + 6);
      }
    };
    const dismiss = () => setMenu(undefined);
    const outside = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) dismiss(); };
    document.addEventListener('keydown', key, true); document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss);
    return () => { document.removeEventListener('keydown', key, true); document.removeEventListener('pointerdown', outside); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss); };
  }, [menu, threadId, title]);
  function add(side: boolean) {
    if (!menu) return;
    if (menu.quote.text.length > 20000) { onError('一次最多引用 20,000 个字符，请缩小选区'); setMenu(undefined); return; }
    (side ? onSide : onQuote)(menu.quote); setMenu(undefined); window.getSelection()?.removeAllRanges();
  }
  return <div className="selectionscope" ref={scope} tabIndex={-1} onContextMenu={e => { if (open(e.clientX, e.clientY)) { e.preventDefault(); e.stopPropagation(); } }}>
    {children}
    {menu && createPortal(<div className="contextmenu glass selectionmenu" role="menu" aria-label="选中文字菜单" ref={menuRef} style={{ left: menu.x, top: menu.y }} onContextMenu={e => e.preventDefault()} onKeyDown={e => {
      if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
      e.preventDefault(); const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')), i = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }}>
      <div className="editmenuheading">选中文字 <span>{menu.quote.text.length.toLocaleString()} 字符</span></div>
      <button role="menuitem" onClick={() => { void window.saint.invoke('selection.copy', { text: menu.quote.text }).catch(() => onError('复制失败，请重试')); setMenu(undefined); }}><Copy/><span>复制</span><kbd>Ctrl C</kbd></button>
      <button role="menuitem" onClick={() => { setMenu(undefined); onPaste(); }}><ClipboardPaste/><span>粘贴到输入框</span><kbd>Ctrl V</kbd></button>
      <hr/>
      <button role="menuitem" onClick={() => add(false)}><Quote/><span>添加到聊天<small>Add to chat</small></span></button>
      <button role="menuitem" disabled={disabled || !menu.quote.entryId} onClick={() => add(true)}><MessageSquarePlus/><span>在侧边对话中提问<small>Ask in side chat</small></span></button>
      {!menu.quote.entryId && <p className="editmenuhint">这条消息保存后即可创建侧边分支。</p>}
    </div>, document.body)}
  </div>;
}
