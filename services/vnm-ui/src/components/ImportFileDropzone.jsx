import { useRef, useState } from 'react';
export default function ImportFileDropzone({ accept, onSelect, hint, label = 'Drop archive here or click to browse', disabled = false, inputRef }) {
  const ownRef = useRef(null), input = inputRef || ownRef;
  const [over, setOver] = useState(false);
  return <div role="button" tabIndex={disabled ? -1 : 0} aria-disabled={disabled} aria-label={label}
    onClick={() => !disabled && input.current?.click()}
    onKeyDown={event => { if (!disabled && ['Enter', ' '].includes(event.key)) { event.preventDefault(); input.current?.click(); } }}
    onDragOver={event => { event.preventDefault(); if (!disabled) setOver(true); }}
    onDragLeave={() => setOver(false)}
    onDrop={event => { event.preventDefault(); setOver(false); if (!disabled) onSelect(event.dataTransfer.files?.[0]); }}
    className={`flex flex-col items-center gap-3 p-7 border-2 border-dashed rounded-xl transition-colors ${disabled ? 'opacity-50' : 'cursor-pointer'} ${over ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-500/10' : 'border-gray-300 dark:border-gray-600 hover:border-emerald-400 dark:hover:border-emerald-500 hover:bg-gray-50 dark:hover:bg-gray-800/50'}`}>
    <svg className="w-8 h-8 text-emerald-600 dark:text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth="1.5" stroke="currentColor" aria-hidden="true"><path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m-4 4 4-4 4 4M4 16v4h16v-4" /></svg>
    <div className="text-center"><p className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</p><p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{hint}</p></div>
    <input ref={input} type="file" accept={accept} disabled={disabled} className="hidden" aria-label="Select archive file" onChange={event => { onSelect(event.target.files?.[0]); event.target.value = ''; }} />
  </div>;
}
