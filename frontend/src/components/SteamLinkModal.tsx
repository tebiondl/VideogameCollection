import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, CopyPlus, Link2, Loader2, Search, X } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import './SteamLinkModal.css';

interface SteamCandidate {
  steam_appid: number;
  name: string;
  playtime_hours: number | null;
  image_url: string | null;
  store_url: string | null;
  similarity: number;
  current: boolean;
  linked_collection_count: number;
  duplicate_of_appid: number | null;
}

export function SteamLinkModal({ game, onClose, onLinked }: {
  game: { id: number; name: string };
  onClose: () => void;
  onLinked: (updatedGame: unknown) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<SteamCandidate[]>([]);
  const [currentAppid, setCurrentAppid] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
    fetchWithAuth(`/discovery/steam/collection-games/${game.id}/candidates`)
      .then(async response => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'Could not load the Steam library.');
        return response.json();
      })
      .then(data => { setItems(data.candidates); setCurrentAppid(data.current_steam_appid); })
      .catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load the Steam library.'));
  }, [game.id]);

  const visible = useMemo(() => {
    const key = query.trim().toLowerCase();
    return items.filter(item => !key || item.name.toLowerCase().includes(key) || String(item.steam_appid).includes(key));
  }, [items, query]);

  async function link(item: SteamCandidate, mode: 'primary' | 'duplicate') {
    setBusy(item.steam_appid); setError('');
    try {
      const response = await fetchWithAuth(`/discovery/steam/collection-games/${game.id}/link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steam_appid: item.steam_appid, mode }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'The Steam link could not be saved.');
      onLinked(await response.json());
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The Steam link could not be saved.');
    } finally { setBusy(null); }
  }

  return <dialog ref={dialog} className="discovery-dialog discovery steam-link-dialog" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="steam-link-title">
    <div className="disc-section-heading"><div><p className="disc-eyebrow">STEAM IDENTITY</p><h2 id="steam-link-title">Link {game.name}</h2></div><button className="disc-icon-button" onClick={onClose} disabled={busy !== null} aria-label="Close"><X /></button></div>
    <p className="disc-muted">Choose the closest game from the Steam account. One Steam game may be linked to several collection entries.</p>
    {currentAppid && <p className="disc-alert success"><Check size={16} /> Primary Steam app: {currentAppid}</p>}
    {error && <p className="disc-alert error" role="alert">{error}</p>}
    <label className="steam-link-search"><Search size={18} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search owned Steam games…" /></label>
    <div className="steam-link-list">
      {visible.map(item => <article key={item.steam_appid} className={`steam-link-row ${item.current ? 'current' : ''}`}>
        <div><strong>{item.name}</strong><small>App {item.steam_appid} · {item.playtime_hours ?? 0} hrs · {Math.round(item.similarity * 100)}% title match{item.linked_collection_count ? ` · linked to ${item.linked_collection_count}` : ''}</small></div>
        <div className="steam-link-actions">
          <button type="button" className="btn btn-primary" disabled={busy !== null || item.current} onClick={() => link(item, 'primary')}>{busy === item.steam_appid ? <Loader2 className="spinner" size={16} /> : <Link2 size={16} />}{item.current ? 'Linked' : currentAppid ? 'Change link' : 'Link'}</button>
          {currentAppid && !item.current && <button type="button" className="btn btn-secondary" disabled={busy !== null} onClick={() => link(item, 'duplicate')}><CopyPlus size={16} />Duplicate copy</button>}
        </div>
      </article>)}
      {!error && visible.length === 0 && <p className="disc-muted">No owned Steam games match this search. Run a collection sync to refresh the catalog.</p>}
    </div>
  </dialog>;
}
