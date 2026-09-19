import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { errorMessage } from '../lib/discovery';
import type { AcquireDraft, CopyOptions } from '../lib/discovery';
import { DlcEditor } from './DlcEditor';
import { TagMultiSelect } from './TagMultiSelect';

export function AcquireGameEditor({ initial, nonSteamOnly = false, onClose, onSave }: { initial: AcquireDraft; nonSteamOnly?: boolean; onClose: () => void; onSave: (draft: AcquireDraft) => Promise<void> }) {
  const [draft, setDraft] = useState(() => nonSteamOnly ? { ...initial, source: initial.source.toLowerCase() === 'steam' ? '' : initial.source, steam_appid: null, store_url: initial.store_url?.toLowerCase().includes('steampowered.com/app/') ? null : initial.store_url } : initial);
  const [tags, setTags] = useState<{ id: number; name: string }[]>([]);
  const [copyOptions, setCopyOptions] = useState<CopyOptions>({ platforms: [], sources: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    Promise.all([
      fetchWithAuth('/videogames/tags').then(response => response.ok ? response.json() : []),
      fetchWithAuth('/discovery/copy-options').then(response => response.ok ? response.json() : { platforms: [], sources: [] }),
    ]).then(([nextTags, options]) => {
      setTags(nextTags);
      setCopyOptions(options);
      if (nonSteamOnly) {
        const nonSteamSources = (options.sources as string[]).filter(value => value.toLowerCase() !== 'steam');
        setDraft(current => ({ ...current, source: current.source && current.source.toLowerCase() !== 'steam' ? current.source : nonSteamSources.find(value => value.toLowerCase() === 'retail') || nonSteamSources[0] || 'Other' }));
      }
    }).catch(() => {});
  }, [nonSteamOnly]);
  const field = <K extends keyof AcquireDraft>(key: K, value: AcquireDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const changePlatform = (platform: string) => setDraft(current => {
    const steamCompatible = ['pc', 'steam deck'].includes(platform.trim().toLowerCase());
    if (current.source.trim().toLowerCase() !== 'steam' || steamCompatible) return { ...current, platform };
    const source = copyOptions.sources.find(value => value.toLowerCase() === 'retail') || copyOptions.sources.find(value => value.toLowerCase() !== 'steam') || current.source;
    const store_url = current.store_url?.toLowerCase().includes('steampowered.com/app/') ? null : current.store_url;
    return { ...current, platform, source, store_url };
  });
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const submitted = nonSteamOnly ? { ...draft, source: draft.source.toLowerCase() === 'steam' ? 'Other' : draft.source, steam_appid: null, store_url: draft.store_url?.toLowerCase().includes('steampowered.com/app/') ? null : draft.store_url } : draft;
    try { await onSave(submitted); onClose(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  const sourceOptions = [...new Set([draft.source, ...copyOptions.sources].filter(Boolean))].filter(value => !nonSteamOnly || value.toLowerCase() !== 'steam');
  return <dialog ref={dialog} className="discovery-dialog discovery acquire-dialog" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="acquire-title">
    <div className="disc-section-heading"><div><p className="disc-eyebrow">REVIEW YOUR COPY</p><h2 id="acquire-title">{nonSteamOnly ? 'Add a non-Steam copy' : 'Move to collection'}</h2></div><button className="disc-icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X /></button></div>
    <p className="disc-muted">{nonSteamOnly ? 'Steam collection sync manages the Steam copy. Add the other platform or edition you bought here.' : 'Confirm the copy you bought and adjust the game or player information before adding it.'}</p>
    {error && <p className="disc-alert error" role="alert">{error}</p>}
    <form className="disc-form" onSubmit={submit}>
      <section className="disc-form-section"><h3>Owned copy</h3><div className="disc-form-grid">
        <label>Platform<select autoFocus required value={draft.platform} onChange={event => changePlatform(event.target.value)}>{[...new Set([draft.platform, ...copyOptions.platforms].filter(Boolean))].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Format<select value={draft.format} onChange={event => field('format', event.target.value)}>{['Any', 'Physical', 'Digital'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Source<select required value={draft.source} onChange={event => field('source', event.target.value)}>{sourceOptions.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Price paid<input type="number" min={0} step="0.01" value={draft.price ?? ''} onChange={event => field('price', event.target.value ? Number(event.target.value) : null)} /></label>
        <label>Currency<select value={draft.currency} onChange={event => field('currency', event.target.value)}>{['EUR', 'USD', 'GBP', 'JPY'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="wide">Store / source URL<input type="url" value={draft.store_url || ''} onChange={event => field('store_url', event.target.value || null)} /></label>
      </div></section>
      <section className="disc-form-section"><h3>Game information</h3><div className="disc-form-grid">
        <label className="wide">Name<input required maxLength={300} value={draft.name} onChange={event => field('name', event.target.value)} /></label>
        <label>Release date<input type="date" value={draft.release_date || ''} onChange={event => field('release_date', event.target.value || null)} /></label>
        <label>Publication year<input type="number" min={1970} max={2200} value={draft.publication_year ?? ''} onChange={event => field('publication_year', event.target.value ? Number(event.target.value) : null)} /></label>
        <label className="disc-check"><input type="checkbox" checked={draft.is_dlc} onChange={event => field('is_dlc', event.target.checked)} /> This is a DLC / expansion</label>
        <label>Parent game<input value={draft.parent_game_name || ''} onChange={event => field('parent_game_name', event.target.value || null)} /></label>
        <label className="wide">Description<textarea rows={3} value={draft.description || ''} onChange={event => field('description', event.target.value || null)} /></label>
        <label className="wide">Cover image URL<input type="url" value={draft.image_url || ''} onChange={event => field('image_url', event.target.value || null)} /></label>
      </div></section>
      <section className="disc-form-section"><h3>Player information</h3><div className="disc-form-grid">
        <label>Status<select value={draft.status} onChange={event => field('status', event.target.value)}>{['Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Playtime (hours)<input type="number" min={0} step="0.1" value={draft.playtime_hours ?? ''} onChange={event => field('playtime_hours', event.target.value ? Number(event.target.value) : null)} /></label>
        <label>Rating (1–10)<input type="number" min={1} max={10} value={draft.mark ?? ''} onChange={event => field('mark', event.target.value ? Number(event.target.value) : null)} /></label>
        <label>Anticipation (1–10)<input type="number" min={1} max={10} value={draft.hype ?? ''} onChange={event => field('hype', event.target.value ? Number(event.target.value) : null)} /></label>
        <label>Completion %<input type="number" min={0} max={100} value={draft.completion_percentage ?? ''} onChange={event => field('completion_percentage', event.target.value ? Number(event.target.value) : null)} /></label>
        <label>Completion date<input value={draft.completion_date || ''} onChange={event => field('completion_date', event.target.value || null)} placeholder="YYYY, YYYY-MM or YYYY-MM-DD" /></label>
        <div className="wide disc-field">Your tags<TagMultiSelect availableTags={tags} selectedTagsString={draft.tags || ''} onChange={value => field('tags', value || null)} /></div>
        <label className="wide">Comments / review<textarea rows={3} value={draft.comments || ''} onChange={event => field('comments', event.target.value || null)} /></label>
      </div><div><h3>Included DLCs</h3><DlcEditor value={draft.dlcs || ''} onChange={value => field('dlcs', value)} gameName={draft.name} getPortalContainer={() => dialog.current || document.body} /></div></section>
      <div className="disc-actions"><button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Moving…' : nonSteamOnly ? 'Add copy to collection' : 'Add to collection'}</button></div>
    </form>
  </dialog>;
}
