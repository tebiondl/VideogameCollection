import { useEffect, useRef, useState } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { DlcEditor } from './DlcEditor';
import { discoveryApi, errorMessage, fromIgdb, payload } from '../lib/discovery';
import type { WantedDraft, IgdbGame } from '../lib/discovery';
import { fetchWithAuth } from '../lib/api';
import { TagMultiSelect } from './TagMultiSelect';
import './DiscoveryDialog.css';

export function WantedGameEditor({ initial, title, onClose, onSave }: { initial: WantedDraft; title: string; onClose: () => void; onSave: (game: WantedDraft) => Promise<void> }) {
  const [draft, setDraft] = useState(initial);
  const [query, setQuery] = useState(initial.name);
  const [results, setResults] = useState<IgdbGame[]>([]);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [availableTags, setAvailableTags] = useState<{ id: number; name: string }[]>([]);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    fetchWithAuth('/videogames/tags').then(response => response.ok ? response.json() : []).then(setAvailableTags).catch(() => {});
  }, []);
  const field = <K extends keyof WantedDraft>(key: K, value: WantedDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  async function search() {
    setSearching(true); setError('');
    try { setResults(await discoveryApi<IgdbGame[]>(`/igdb/search?q=${encodeURIComponent(query)}`)); }
    catch (e) { setError(errorMessage(e)); }
    finally { setSearching(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSave(payload(draft)); onClose(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="discovery-dialog discovery" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="wanted-editor-title">
    <div className="disc-section-heading"><h2 id="wanted-editor-title">{title}</h2><button className="disc-icon-button" aria-label="Close editor" disabled={busy} onClick={onClose}><X /></button></div>
    <p className="disc-muted">Find metadata with Twitch / IGDB, then edit any field before saving.</p>
    <div className="disc-inline"><input aria-label="Search IGDB" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search a game or DLC…" onKeyDown={e => { if (e.key === 'Enter' && query.trim()) { e.preventDefault(); void search(); } }} /><button type="button" className="btn btn-secondary" disabled={searching || !query.trim()} onClick={search}>{searching ? <Loader2 className="spin" size={16} /> : <Search size={16} />} Search IGDB</button></div>
    {results.length > 0 && <div className="disc-search-results">{results.map(game => <button type="button" key={game.igdb_id} onClick={() => { setDraft(fromIgdb(game, draft)); setResults([]); }}><span>{game.name} {game.is_dlc ? '· DLC' : ''}</span><small>{game.release_year || 'TBA'} · {game.platforms.join(', ')}</small></button>)}</div>}
    {error && <p className="disc-alert error" role="alert">{error}</p>}
    <form onSubmit={save} className="disc-form">
      <div className="disc-form-grid">
        <label className="wide">Name<input autoFocus required maxLength={300} value={draft.name} onChange={e => field('name', e.target.value)} /></label>
        <label>Platform<input list="wanted-platforms" value={draft.platform} onChange={e => field('platform', e.target.value)} placeholder="e.g. Nintendo Switch" /><datalist id="wanted-platforms">{['Nintendo Switch', 'Nintendo Switch 2', 'PC', 'PlayStation 5', 'Xbox Series X|S'].map(platform => <option key={platform}>{platform}</option>)}</datalist></label>
        <label>Format<select value={draft.format} onChange={e => field('format', e.target.value)}>{['Any', 'Physical', 'Digital'].map(format => <option key={format}>{format}</option>)}</select></label>
        <label>Status<select value={draft.status} onChange={e => field('status', e.target.value)}>{['Wanted', 'Watching', 'Preordered', 'Acquired'].map(status => <option key={status}>{status}</option>)}</select></label>
        <label>Anticipation (1–10)<input type="number" min={1} max={10} value={draft.hype ?? ''} onChange={e => field('hype', e.target.value ? Number(e.target.value) : null)} /></label>
        <label>Target price<input type="number" min={0} step="0.01" value={draft.target_price ?? ''} onChange={e => field('target_price', e.target.value ? Number(e.target.value) : null)} /></label>
        <label>Currency<select value={draft.currency} onChange={e => field('currency', e.target.value)}>{['EUR', 'USD', 'GBP', 'JPY'].map(currency => <option key={currency}>{currency}</option>)}</select></label>
        <label>Release date<input type="date" value={draft.release_date || ''} onChange={e => field('release_date', e.target.value || null)} /></label>
        <label>Publication year<input type="number" min={1970} max={2200} value={draft.publication_year ?? ''} onChange={e => field('publication_year', e.target.value ? Number(e.target.value) : null)} /></label>
        <div className="wide disc-field">Your tags<TagMultiSelect availableTags={availableTags} selectedTagsString={draft.tags || ''} onChange={value => field('tags', value)} /></div>
        <label className="disc-check"><input type="checkbox" checked={draft.is_dlc} onChange={e => field('is_dlc', e.target.checked)} /> This entry is a DLC / expansion</label>
        <label>Parent game<input value={draft.parent_game_name || ''} onChange={e => field('parent_game_name', e.target.value)} placeholder="For standalone DLC entries" /></label>
        <label className="wide">Description<textarea rows={3} value={draft.description || ''} onChange={e => field('description', e.target.value)} /></label>
        <label className="wide">Personal notes<textarea rows={3} value={draft.comments || ''} onChange={e => field('comments', e.target.value)} /></label>
        <label className="wide">Cover image URL<input type="url" value={draft.image_url || ''} onChange={e => field('image_url', e.target.value)} /></label>
        <label className="wide">Store / source URL<input type="url" value={draft.store_url || ''} onChange={e => field('store_url', e.target.value)} /></label>
        <label>IGDB ID<input type="number" min={1} value={draft.igdb_id ?? ''} onChange={e => field('igdb_id', e.target.value ? Number(e.target.value) : null)} /></label>
        <label>Steam app ID<input type="number" min={1} value={draft.steam_appid ?? ''} onChange={e => field('steam_appid', e.target.value ? Number(e.target.value) : null)} /></label>
      </div>
      <div><h3>Included DLCs</h3><p className="disc-muted">Keep DLCs inside this game, or save them as separate entries using the DLC checkbox.</p><DlcEditor value={draft.dlcs || ''} onChange={value => field('dlcs', value)} gameName={draft.name} getPortalContainer={() => dialog.current || document.body} /></div>
      <p className="disc-muted">“Acquired” tracks your intent here. Use “Move to collection” on the saved entry to also create an owned game.</p>
      <div className="disc-actions"><button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save game'}</button></div>
    </form>
  </dialog>;
}
