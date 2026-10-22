import { useEffect, useRef } from 'react';

const stack = [];
export default function ImportDialog({ open = true, title, subtitle, onClose, busy = false, children, wide = false }) {
  const card = useRef(null);
  useEffect(() => {
    if (!open) return;
    const token = {}, previous = document.activeElement, overflow = document.body.style.overflow;
    stack.push(token);
    document.body.style.overflow = 'hidden';
    card.current?.focus();
    const key = event => {
      if (stack.at(-1) !== token) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); if (!busy) onClose(); }
      if (event.key === 'Tab') {
        const targets = [...card.current.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
        const first = targets[0], last = targets.at(-1);
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === card.current)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === card.current)) { event.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => { stack.splice(stack.indexOf(token), 1); window.removeEventListener('keydown', key, true); document.body.style.overflow = stack.length ? 'hidden' : previous?.isConnected ? overflow : ''; if (previous?.isConnected) previous.focus(); };
  }, [open, busy, onClose]);
  if (!open) return null;
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 dark:bg-black/70 backdrop-blur-sm modal-safe-pad motion-safe:animate-fade-in" onClick={() => !busy && onClose()} role="dialog" aria-modal="true" aria-label={title}>
    <div ref={card} tabIndex={-1} onClick={event => event.stopPropagation()} className={`relative w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[90dvh] overflow-y-auto bg-white dark:bg-gray-900 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700/50 motion-safe:animate-scale-in outline-none`}>
      <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-4 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-3 min-w-0"><div className="w-10 h-10 shrink-0 rounded-lg bg-emerald-500/10 dark:bg-emerald-500/20 flex items-center justify-center text-emerald-600 dark:text-emerald-400"><svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" strokeWidth="2" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-9L12 3m0 0 4.5 4.5M12 3v13.5" /></svg></div>
          <div className="min-w-0"><h2 className="text-lg font-bold text-gray-900 dark:text-white">{title}</h2><p className="text-xs text-gray-500 dark:text-gray-400 break-words">{subtitle}</p></div></div>
        {!busy && <button type="button" className="w-9 h-9 shrink-0 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors" onClick={onClose} aria-label="Close modal">✕</button>}
      </div>
      {children}
    </div>
  </div>;
}
