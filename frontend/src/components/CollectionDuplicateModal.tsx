import { useMemo, useRef, useState, useEffect } from 'react';
import { GitMerge, Loader2, Search, X } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { parseCopies } from '../lib/ownedCopies';
import './CollectionDuplicateModal.css';

interface CollectionGame {
  id: number;
  name: string;
  image_url?: string | null;
  copies?: string | null;
  hidden?: boolean;
  is_dlc?: boolean;
}

type Direction = 'current_into_other' | 'other_into_current';

export function CollectionDuplicateModal({ game, games, onClose, onMerged }: {
  game: CollectionGame;
  games: CollectionGame[];
  onClose: () => void;
  onMerged: (result: { collection_game: CollectionGame; duplicate_game_id: number }) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [direction, setDirection] = useState<Direction>('current_into_other');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { dialog.current?.showModal(); }, []);
  const candidates = useMemo(() => games.filter(candidate =>
    candidate.id !== game.id && !candidate.hidden && !candidate.is_dlc &&
    (!query.trim() || candidate.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  ), [game.id, games, query]);
  const selected = games.find(candidate => candidate.id === selectedId) || null;

  async function merge() {
    if (!selectedId) return;
    setBusy(true); setError('');
    try {
      const response = await fetchWithAuth(`/discovery/steam/collection-games/${game.id}/merge-duplicate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ other_game_id: selectedId, direction }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'The duplicate games could not be merged.');
      onMerged(await response.json());
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The duplicate games could not be merged.');
    } finally { setBusy(false); }
  }

  return <dialog ref={dialog} className="discovery-dialog discovery collection-duplicate-dialog" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="collection-duplicate-title">
    <div className="disc-section-heading"><div><p className="disc-eyebrow">COLLECTION DUPLICATES</p><h2 id="collection-duplicate-title">Merge duplicate game</h2></div><button className="disc-icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X /></button></div>
    <p className="disc-muted">Choose the other collection card, then choose which card should remain. Every moved copy keeps its own Steam link and original copy name.</p>
    {error && <p className="disc-alert error" role="alert">{error}</p>}
    <label className="duplicate-search"><Search size={18} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search your collection…" /></label>
    <div className="duplicate-game-list">
      {candidates.map(candidate => {
        const copies = parseCopies(candidate.copies);
        return <button type="button" key={candidate.id} className={`duplicate-game-option ${selectedId === candidate.id ? 'selected' : ''}`} onClick={() => setSelectedId(candidate.id)}>
          {candidate.image_url ? <img src={candidate.image_url} alt="" /> : <span className="duplicate-cover-placeholder" />}
          <span><strong>{candidate.name}</strong><small>{copies.length} {copies.length === 1 ? 'copy' : 'copies'} · {copies.filter(copy => copy.steam_appid).length} Steam</small></span>
        </button>;
      })}
      {candidates.length === 0 && <p className="disc-muted">No collection games match this search.</p>}
    </div>
    {selected && <fieldset className="duplicate-direction">
      <legend>Which game is the duplicate?</legend>
      <label className={direction === 'current_into_other' ? 'selected' : ''}><input type="radio" name="duplicate-direction" checked={direction === 'current_into_other'} onChange={() => setDirection('current_into_other')} /><span><strong>{game.name}</strong> is the duplicate<small>Keep {selected.name}; move this game’s copies into it.</small></span></label>
      <label className={direction === 'other_into_current' ? 'selected' : ''}><input type="radio" name="duplicate-direction" checked={direction === 'other_into_current'} onChange={() => setDirection('other_into_current')} /><span><strong>{selected.name}</strong> is the duplicate<small>Keep {game.name}; move the selected game’s copies here.</small></span></label>
    </fieldset>}
    <div className="modal-actions duplicate-modal-actions"><button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={merge} disabled={!selected || busy}>{busy ? <Loader2 className="spinner" size={17} /> : <GitMerge size={17} />} Merge collection games</button></div>
  </dialog>;
}
