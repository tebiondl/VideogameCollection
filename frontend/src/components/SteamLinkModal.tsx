import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Link2, Loader2, Search, X } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import './DiscoveryDialog.css';
import './SteamLinkModal.css';
import type { OwnedCopy } from '../lib/ownedCopies';

interface SteamCandidate {
  steam_appid: number;
  name: string;
  playtime_hours: number | null;
  image_url: string | null;
  store_url: string | null;
  similarity: number;
  current: boolean;
  linked_collection_count: number;
  stats_verified?: boolean;
  user_verified?: boolean;
  manual_verification_required?: boolean;
  is_dlc?: boolean;
  store_query?: string | null;
}

export function SteamLinkModal({ game, copy, onClose, onLinked }: {
  game: { id: number; name: string };
  copy: OwnedCopy;
  onClose: () => void;
  onLinked: (updatedGame: unknown) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [items, setItems] = useState<SteamCandidate[]>([]);
  const [currentAppid, setCurrentAppid] = useState<number | null>(null);
  const [query, setQuery] = useState(game.name);
  const [busy, setBusy] = useState<number | null>(null);
  const [searchingStore, setSearchingStore] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
    fetchWithAuth(`/discovery/steam/collection-games/${game.id}/copies/${encodeURIComponent(copy.id!)}/candidates`)
      .then(async response => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'Could not load the Steam library.');
        return response.json();
      })
      .then(data => { setItems(data.candidates); setCurrentAppid(data.current_steam_appid); })
      .catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load the Steam library.'));
  }, [game.id, copy.id]);

  const visible = useMemo(() => {
    const key = query.trim().toLowerCase();
    return items.filter(item => !key || item.store_query?.trim().toLowerCase() === key ||
      item.name.toLowerCase().includes(key) || String(item.steam_appid).includes(key));
  }, [items, query]);

  async function link(item: SteamCandidate) {
    setBusy(item.steam_appid); setError('');
    try {
      const response = await fetchWithAuth(`/discovery/steam/collection-games/${game.id}/copies/${encodeURIComponent(copy.id!)}/link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          steam_appid: item.steam_appid,
          allow_unverified: !!item.manual_verification_required,
          store_query: item.store_query || undefined,
        }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'The Steam link could not be saved.');
      onLinked(await response.json());
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The Steam link could not be saved.');
    } finally { setBusy(null); }
  }

  async function searchSteamStore() {
    const term = query.trim();
    if (!term) return;
    setSearchingStore(true); setError('');
    try {
      const response = await fetchWithAuth(`/discovery/steam/collection-games/${game.id}/copies/${encodeURIComponent(copy.id!)}/candidates?store_query=${encodeURIComponent(term)}`);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'Could not search the Steam Store.');
      const data = await response.json();
      setItems(data.candidates); setCurrentAppid(data.current_steam_appid);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not search the Steam Store.');
    } finally { setSearchingStore(false); }
  }

  return <dialog ref={dialog} className="discovery-dialog discovery steam-link-dialog" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="steam-link-title">
    <div className="disc-section-heading"><div><p className="disc-eyebrow">STEAM COPY IDENTITY</p><h2 id="steam-link-title">Link {game.name}</h2></div><button className="disc-icon-button" onClick={onClose} disabled={busy !== null} aria-label="Close"><X /></button></div>
    <p className="disc-muted">Link the {copy.platform || 'selected'} · {copy.format || 'Any'} copy. Other copies of this game keep their own platform, source, and Steam link.</p>
    {currentAppid && <p className="disc-alert success"><Check size={16} /> Primary Steam app: {currentAppid}</p>}
    {error && <p className="disc-alert error" role="alert">{error}</p>}
    <div className="steam-link-search"><Search size={18} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); searchSteamStore(); } }} placeholder="Game title, Steam AppID, or Store URL…" /><button type="button" className="btn btn-secondary" disabled={searchingStore || busy !== null || !query.trim()} onClick={searchSteamStore}>{searchingStore ? <Loader2 className="spinner" size={16} /> : <Search size={16} />} Search Steam Store</button></div>
    <div className="steam-link-list">
      {visible.map(item => <article key={item.steam_appid} className={`steam-link-row ${item.current ? 'current' : ''}`}>
        <div><strong>{item.name}</strong><small>App {item.steam_appid}{item.is_dlc ? ' · DLC' : ''} · {item.playtime_hours == null ? 'playtime unavailable' : `${item.playtime_hours} hrs`} · {Math.round(item.similarity * 100)}% title match{item.stats_verified ? ' · verified through Steam stats' : item.user_verified ? ' · manually linked' : item.manual_verification_required ? ' · Steam Store match; ownership not verifiable' : ''}{item.linked_collection_count ? ` · linked to ${item.linked_collection_count}` : ''}</small></div>
        <div className="steam-link-actions">
          <button type="button" className="btn btn-primary" disabled={busy !== null || item.current} onClick={() => link(item)}>{busy === item.steam_appid ? <Loader2 className="spinner" size={16} /> : <Link2 size={16} />}{item.current ? 'Linked' : currentAppid ? 'Change link' : 'Link'}</button>
        </div>
      </article>)}
      {!error && visible.length === 0 && <p className="disc-muted">No Steam games match this search. Try the official title, an AppID, or paste its Steam Store URL.</p>}
    </div>
  </dialog>;
}
