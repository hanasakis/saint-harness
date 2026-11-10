import { useEffect, useLayoutEffect, useImperativeHandle, useRef, useState, type RefObject, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Scissors, ClipboardPaste, Undo2, Redo2, TextSelect } from 'lucide-react';
import type { Attachment } from '../shared/types';

type Props = {
  controller?: RefObject<{ paste: () => void } | null>;
  label?: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  value: string; placeholder: string; threadId?: string;
  onChange: (text: string) => void; onSend: () => void;
  onPaste: (operation: () => Promise<void>) => Promise<unknown>;
  onAttachments: (attachments: Attachment[]) => void;
  onError: (message: string) => void;
};
type Selection = { start: number; end: number; direction: 'forward' | 'backward' | 'none' };
type Position = Selection & { x: number; y: number };

export function ComposerInput({ controller, label = '任务输入', inputRef, value, placeholder, threadId, onChange, onSend, onPaste, onAttachments, onError }: Props) {
  const [menu, setMenu] = useState<Position>();
  const menuRef = useRef<HTMLDivElement>(null);
  const pasting = useRef(false);
  const current = useRef({ value, threadId }); current.current = { value, threadId };
  const selection = (): Selection => {
    const el = inputRef.current!;
    return { start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection };
  };
  useImperativeHandle(controller, () => ({ paste: () => { inputRef.current?.focus(); void paste(selection()); } }));
  function restore(range: Selection) {
    const el = inputRef.current;
    el?.focus({ preventScroll: true }); el?.setSelectionRange(range.start, range.end, range.direction);
  }
  async function paste(range: Selection, textOnly = false) {
    if (pasting.current) return;
    const original = current.current;
    pasting.current = true;
    try {
      await onPaste(async () => {
        const result = await window.saint.invoke<{ text: string; attachments: Attachment[] }>('composer.paste', { threadId: original.threadId, textOnly });
        if (current.current.threadId !== original.threadId) return;
        if (result.attachments.length) onAttachments(result.attachments);
        if (result.text) {
          // Keep text editing in Chromium's undo stack. If the user continued
          // typing during the read, insert at the new caret instead.
          if (current.current.value === original.value) restore(range);
          else inputRef.current?.focus({ preventScroll: true });
          document.execCommand('insertText', false, result.text);
        } else inputRef.current?.focus({ preventScroll: true });
      });
    } finally { pasting.current = false; }
  }
  function openMenu(x: number, y: number) { setMenu({ ...selection(), x, y }); }
  function key(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') || (e.shiftKey && e.key === 'Insert')) {
      e.preventDefault(); void paste(selection(), e.shiftKey && e.key !== 'Insert'); return;
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      e.preventDefault(); const box = e.currentTarget.getBoundingClientRect(); openMenu(box.left + 20, box.top + 25); return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!pasting.current) onSend(); }
  }
  useEffect(() => setMenu(undefined), [threadId]);
  useLayoutEffect(() => {
    const el = menuRef.current; if (!menu || !el) return;
    const box = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(menu.x, innerWidth - box.width - 8))}px`;
    el.style.top = `${Math.max(40, Math.min(menu.y, innerHeight - box.height - 8))}px`;
    el.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);
  useEffect(() => {
    if (!menu) return;
    const outside = (e: Event) => { if (!menuRef.current?.contains(e.target as Node)) setMenu(undefined); };
    const dismiss = () => setMenu(undefined);
    const escape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); } restore(menu); dismiss(); }
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape, true);
    window.addEventListener('resize', dismiss); window.addEventListener('blur', dismiss);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss); };
  }, [menu]);
  async function edit(command: 'undo' | 'redo' | 'cut' | 'copy' | 'selectAll' | 'paste') {
    if (!menu) return;
    restore(menu); setMenu(undefined);
    if (command === 'paste') await paste(menu);
    else try { await window.saint.invoke('composer.edit', { command }); } catch { onError('暂时无法完成编辑操作，请重试'); }
  }
  const commands = [
    { command: 'undo', label: '撤销', icon: Undo2, shortcut: 'Ctrl Z' },
    { command: 'redo', label: '重做', icon: Redo2, shortcut: 'Ctrl Y' },
    { command: 'cut', label: '剪切', icon: Scissors, shortcut: 'Ctrl X', disabled: menu?.start === menu?.end },
    { command: 'copy', label: '复制', icon: Copy, shortcut: 'Ctrl C', disabled: menu?.start === menu?.end },
    { command: 'paste', label: '粘贴', icon: ClipboardPaste, shortcut: 'Ctrl V' },
    { command: 'selectAll', label: '全选', icon: TextSelect, shortcut: 'Ctrl A', disabled: !value },
  ] as const;
  return <>
    <textarea ref={inputRef} aria-label={label} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} rows={2}
      onKeyDown={key} onPaste={e => { e.preventDefault(); void paste(selection()); }}
      onContextMenu={e => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY); }} />
    {menu && createPortal(<div className="contextmenu glass composermenu" role="menu" aria-label="输入编辑菜单" ref={menuRef} style={{ left: menu.x, top: menu.y }} onContextMenu={e => e.preventDefault()} onKeyDown={e => {
      if (!['ArrowDown','ArrowUp','Home','End'].includes(e.key)) return;
      e.preventDefault(); const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }}>
      <div className="editmenuheading">编辑输入</div>
      {commands.map(({ command, label, icon: Icon, shortcut, ...rest }) => <button key={command} role="menuitem" disabled={'disabled' in rest && rest.disabled} onClick={() => void edit(command)}><Icon /><span>{label}</span><kbd>{shortcut}</kbd></button>)}
      <p className="editmenuhint">可粘贴文字、图片或已复制的文件</p>
    </div>, document.body)}
  </>;
}
