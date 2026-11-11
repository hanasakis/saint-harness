import { useEffect } from 'react';

export function usePopoverDismiss(open: unknown, selector: string, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const popup = document.querySelector(selector), target = event.target as Node;
      if (popup?.contains(target) || popup?.closest('.anchor')?.contains(target)) return;
      close();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', escape, true);
    window.addEventListener('blur', close);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); window.removeEventListener('blur', close); };
  }, [open, selector, close]);
}
