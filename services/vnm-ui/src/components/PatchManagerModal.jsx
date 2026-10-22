import { useCallback, useEffect, useState } from 'react';
import api from '../hooks/useApi';
import ImportDialog from './ImportDialog';
import ImportFileDropzone from './ImportFileDropzone';

const secondary = 'px-4 py-2 text-sm font-medium rounded-lg bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const primary = 'px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
export default function PatchManagerModal({ gameId, title, onClose, onChanged, onBuild, hasBuild = false }) {
  const base = `/games/${gameId}/patches`;
  const [data, setData] = useState(null), [patches, setPatches] = useState([]);
  const [preview, setPreview] = useState(null), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false), [remove, setRemove] = useState(null);
  const reload = useCallback(async () => { const next = await api.get(base); setData(next); setPatches(next.patches); setConfirmed(false); }, [base]);
  useEffect(() => { let active = true; api.get(base).then(next => { if (active) { setData(next); setPatches(next.patches); } }).catch(e => active && setError(e.message)); return () => { active = false; }; }, [base]);
  const dirty = data && JSON.stringify(patches.map(p => [p.id, p.enabled])) !== JSON.stringify(data.patches.map(p => [p.id, p.enabled]));
  const locked = Boolean(busy) || data?.building;
  const close = useCallback(() => {
    if (preview) api.delete(`${base}/${preview.packageId}`).catch(() => {});
    onClose();
  }, [base, preview, onClose]);
  async function action(label, fn) { setBusy(label); setError(''); try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(''); } }
  const select = file => {
    if (!file) return;
    if (!/\.(rpy|zip)$/i.test(file.name)) { setError('Select a .rpy or .zip patch package.'); return; }
    if (file.size > 256 * 1024 * 1024) { setError('Patch upload exceeds 256 MiB.'); return; }
    action('Uploading and inspecting…', async () => { const form = new FormData(); form.append('file', file); setPreview(await api.upload(base + '/preview', form)); setConfirmed(false); });
  };
  function move(index, direction) { setPatches(current => { const next = [...current]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; return next; }); setConfirmed(false); }
  async function changed() { await reload(); await onChanged?.(); }
  return <ImportDialog title="Patches" subtitle={title} onClose={close} busy={Boolean(busy)} wide>
    <div className="px-6 py-5 space-y-5 text-sm text-gray-700 dark:text-gray-300">
      <p>Patches are shared by all players. Changes apply on the next build; original game files stay untouched. Use patches intended for this game and version.</p>
      {error && <div role="alert" className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/40 p-3 text-red-700 dark:text-red-300">{error}</div>}
      {busy && <p role="status" className="text-emerald-700 dark:text-emerald-400">{busy}</p>}
      {data?.building && <p role="status" className="rounded-lg bg-amber-50 dark:bg-amber-950/40 p-3 text-amber-800 dark:text-amber-200">A build is queued or running. Patch changes are locked until it finishes. <button className="underline" disabled={Boolean(busy)} onClick={() => action('Refreshing…', reload)}>Refresh status</button></p>}
      {data?.needsBuild && <p role="status" className="rounded-lg bg-amber-50 dark:bg-amber-950/40 p-3 text-amber-800 dark:text-amber-200">{hasBuild ? 'Rebuild needed. The current build uses an earlier patch configuration.' : 'Build needed. Installed patches will be included in the first build.'}</p>}
      {!data && !error && <p role="status">Loading patches…</p>}
      {preview ? <section className="space-y-4" aria-label="Patch preview">
        <div><h3 className="font-semibold text-gray-900 dark:text-white break-all">{preview.name}</h3><p className="text-xs mt-1">Choose the folder whose contents belong inside this game’s <code>game/</code> directory.</p></div>
        <label className="block font-medium">Package folder<select aria-label="Package folder" value={preview.root ?? '__choose__'} disabled={locked} className="mt-2 block w-full p-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800" onChange={event => action('Updating preview…', async () => { setPreview(await api.post(`${base}/${preview.packageId}/preview`, { root: event.target.value })); setConfirmed(false); })}>
          {preview.root === null && <option value="__choose__" disabled>Select a folder</option>}
          {preview.roots.map(root => <option key={root} value={root}>{root || 'Package root'} → game/</option>)}
        </select></label>
        <div className="max-h-64 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700"><table className="w-full text-left text-xs"><caption className="text-left px-3 py-2 font-medium">{preview.files.length} {preview.files.length === 1 ? 'file' : 'files'} to install</caption><thead className="bg-gray-50 dark:bg-gray-800"><tr><th className="p-3">Destination</th><th className="p-3">Action</th></tr></thead><tbody>{preview.files.map(file => <tr key={file.source} className="border-t border-gray-100 dark:border-gray-800"><td className="p-3 break-all">{file.path}</td><td className="p-3 min-w-28">{file.conflict ? `Cannot install: ${file.conflict}` : file.replaces ? `Replaces ${file.replaces}` : 'Add file'}</td></tr>)}</tbody></table></div>
        {preview.instructions.map(instruction => <details key={instruction.name} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3"><summary className="cursor-pointer font-medium break-all">{instruction.name}</summary><pre className="mt-3 whitespace-pre-wrap break-words text-xs font-sans">{instruction.text}</pre></details>)}
        {preview.excluded.length > 0 && <details className="rounded-lg border border-gray-200 dark:border-gray-700 p-3"><summary className="cursor-pointer font-medium">{preview.excluded.length} excluded files</summary><ul className="mt-2 max-h-44 overflow-y-auto space-y-2 text-xs">{preview.excluded.map(file => <li key={file.source} className="break-all"><strong>{file.source}</strong>: {file.reason}</li>)}</ul></details>}
        <ul className="space-y-1 text-xs text-gray-500 dark:text-gray-400">{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
        <label className="flex items-start gap-3"><input type="checkbox" checked={confirmed} disabled={locked} onChange={event => setConfirmed(event.target.checked)} className="mt-1 accent-emerald-600" /><span>I reviewed the destinations, replacements and exclusions. Install these files on the next build.</span></label>
        <div className="flex flex-wrap justify-end gap-2"><button className={secondary} disabled={Boolean(busy)} onClick={() => action('Discarding preview…', async () => { await api.delete(`${base}/${preview.packageId}`); setPreview(null); setConfirmed(false); })}>Discard preview</button><button className={primary} disabled={locked || !confirmed || !preview.canInstall} onClick={() => action('Installing patch…', async () => { await api.post(base, { packageId: preview.packageId, root: preview.root, revision: preview.revision, confirmed: true }); setPreview(null); await changed(); })}>Install patch</button></div>
      </section> : <>
        <section className="space-y-3" aria-label="Installed patches"><h3 className="font-semibold text-gray-900 dark:text-white">Installed patches</h3>
          {data && !patches.length && <p className="text-gray-500 dark:text-gray-400">No patches installed.</p>}
          {patches.length > 0 && <p className="text-xs text-gray-500 dark:text-gray-400">Applied from top to bottom. Later enabled patches replace earlier files with the same path.</p>}
          {patches.map((patch, index) => {
            const earlier = patches.slice(0, index).filter(p => p.enabled && patch.enabled && p.files.some(file => patch.files.some(other => other.toLowerCase().replace(/(\.rpym?)c$/, '$1') === file.toLowerCase().replace(/(\.rpym?)c$/, '$1'))));
            return <div key={patch.id} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2">
              <div className="flex items-start gap-3"><input aria-label={`Enable ${patch.name}`} type="checkbox" checked={patch.enabled} disabled={locked} onChange={event => { setPatches(current => current.map(p => p.id === patch.id ? { ...p, enabled: event.target.checked } : p)); setConfirmed(false); }} className="mt-1 accent-emerald-600" /><div className="flex-1 min-w-0"><p className="font-medium break-all">{patch.name}</p><p className="text-xs text-gray-500 dark:text-gray-400">{patch.files.length} {patch.files.length === 1 ? 'file' : 'files'} · {patch.enabled ? 'Enabled' : 'Disabled'}</p></div></div>
              {earlier.length > 0 && <p className="text-xs text-amber-700 dark:text-amber-300">Overrides files from {earlier.map(p => p.name).join(', ')}</p>}
              <div className="flex flex-wrap gap-2"><button className={secondary} aria-label={`Move ${patch.name} up`} disabled={locked || index === 0} onClick={() => move(index, -1)}>↑ Move up</button><button className={secondary} aria-label={`Move ${patch.name} down`} disabled={locked || index === patches.length - 1} onClick={() => move(index, 1)}>↓ Move down</button><button className={secondary} disabled={locked || dirty} onClick={() => setRemove(patch)}>Remove</button></div>
              <details className="text-xs"><summary className="cursor-pointer">Files</summary><ul className="mt-2 max-h-36 overflow-y-auto space-y-1">{patch.files.map(file => <li key={file} className="break-all">{file}</li>)}</ul></details>
            </div>;
          })}
          {remove && <div className="rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 space-y-3"><p>Remove <strong>{remove.name}</strong> from future builds? Rebuild afterward to remove its effects. Existing saves may depend on this patch.</p><div className="flex gap-2"><button className={secondary} disabled={locked} onClick={() => setRemove(null)}>Keep patch</button><button className={secondary} disabled={locked} onClick={() => action('Removing patch…', async () => { await api.delete(`${base}/${remove.id}?revision=${data.revision}`); setRemove(null); await changed(); })}>Confirm removal</button></div></div>}
          {dirty && <div className="space-y-3"><label className="flex items-start gap-3"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} className="mt-1 accent-emerald-600" /><span>Apply this order and enabled state. Later enabled patches take precedence.</span></label><div className="flex gap-2"><button className={secondary} disabled={locked} onClick={() => { setPatches(data.patches); setConfirmed(false); }}>Discard changes</button><button className={primary} disabled={locked || !confirmed} onClick={() => action('Saving patch configuration…', async () => { await api.put(base, { patches: patches.map(({ id, enabled }) => ({ id, enabled })), revision: data.revision, confirmed: true }); await changed(); })}>Save changes</button></div></div>}
        </section>
        <ImportFileDropzone accept=".rpy,.zip" label="Drop patch here or click to browse" hint="A .rpy script or .zip package · up to 256 MiB · preview before installation" onSelect={select} disabled={locked || !data || dirty || Boolean(remove)} />
      </>}
    </div>
    <div className="flex flex-wrap justify-end gap-3 px-6 py-4 border-t border-gray-200 dark:border-gray-800"><button className={secondary} disabled={Boolean(busy)} onClick={close}>Close</button>{data?.needsBuild && !preview && !dirty && <button className={primary} disabled={locked} onClick={() => { onClose(); onBuild(); }}>{hasBuild ? 'Rebuild' : 'Build'}</button>}</div>
  </ImportDialog>;
}
