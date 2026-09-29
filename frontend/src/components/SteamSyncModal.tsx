import { useEffect, useRef, useState } from 'react';
import { Check, GitMerge, Link2, Loader2, X } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import './DiscoveryDialog.css';
import './SteamSyncModal.css';

interface Candidate {
  steam_appid: number;
  name: string;
  image_url: string | null;
  playtime_hours: number | null;
  similarity: number;
  linked_games: { id: number; name: string }[];
}

export function SteamSyncModal({ game, onClose, onLinked, onMerge }: {
  game: { id: number; name: string };
  onClose: () => void;
  onLinked: (game: unknown) => void;
  onMerge: (linkedGameName: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [ownedCount, setOwnedCount] = useState(0);
  const [connected, setConnected] = useState(false);
  const [selectedAppid, setSelectedAppid] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
    let active = true;
    fetchWithAuth(`/discovery/steam/collection-games/${game.id}/sync-candidates?name=${encodeURIComponent(game.name)}`)
      .then(async response => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'Could not check your Steam library.');
        return response.json();
      })
      .then(data => {
        if (!active) return;
        setCandidates(data.candidates);
        setOwnedCount(data.owned_count);
        setConnected(data.connected);
        setSelectedAppid(data.candidates[0]?.steam_appid ?? null);
      })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : 'Could not check your Steam library.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [game.id, game.name]);

  const selected = candidates.find(candidate => candidate.steam_appid === selectedAppid);
  const linkedHere = selected?.linked_games.some(link => link.id === game.id);
  const linkedElsewhere = selected?.linked_games.find(link => link.id !== game.id);

  async function linkSelected() {
    if (!selected || linkedHere || linkedElsewhere) return;
    setLinking(true);
    setError('');
    try {
      const response = await fetchWithAuth(`/discovery/steam/collection-games/${game.id}/sync-link`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ steam_appid: selected.steam_appid }),
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).detail || 'Could not link the Steam copy.');
      onLinked(await response.json());
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not link the Steam copy.');
    } finally { setLinking(false); }
  }

  return <dialog ref={dialog} className="discovery-dialog discovery steam-sync-dialog" onCancel={event => { event.preventDefault(); if (!linking) onClose(); }} aria-labelledby="steam-sync-title">
    <div className="disc-section-heading"><div><p className="disc-eyebrow">OWNED STEAM GAMES</p><h2 id="steam-sync-title">Sync {game.name}</h2></div><button type="button" className="disc-icon-button" onClick={onClose} disabled={linking} aria-label="Close"><X /></button></div>
    <p className="disc-muted">Choose the game found in your connected Steam library. The copy is linked only after you confirm.</p>
    {error && <p className="disc-alert error" role="alert">{error}</p>}
    {loading ? <p className="steam-sync-status" role="status"><Loader2 className="spinner" size={18} /> Checking your Steam library…</p> : candidates.length ? <>
      <div className="steam-sync-candidates" role="radiogroup" aria-label="Owned Steam matches">
        {candidates.map(candidate => <label key={candidate.steam_appid} className={`steam-sync-candidate ${selectedAppid === candidate.steam_appid ? 'selected' : ''}`}>
          <input type="radio" name="steam-sync-candidate" checked={selectedAppid === candidate.steam_appid} onChange={() => setSelectedAppid(candidate.steam_appid)} />
          {candidate.image_url && <img src={candidate.image_url} alt="" />}
          <span><strong>{candidate.name}</strong><small>Steam App {candidate.steam_appid} · {Math.round(candidate.similarity * 100)}% title match{candidate.playtime_hours == null ? '' : ` · ${candidate.playtime_hours} hrs`}</small>
            {candidate.linked_games.length > 0 && <small>Linked to {candidate.linked_games.map(link => link.name).join(', ')}</small>}</span>
        </label>)}
      </div>
      {selected && <p className="steam-sync-confirmation">{linkedElsewhere ? <>This Steam copy is already linked to <strong>{linkedElsewhere.name}</strong>. Review the duplicate entries to move it to <strong>{game.name}</strong>.</> : linkedHere ? <>This Steam copy is already linked to <strong>{game.name}</strong>.</> : <>Found <strong>{selected.name}</strong> in your owned Steam library. Link this Steam copy to <strong>{game.name}</strong>?</>}</p>}
    </> : !error && <p className="steam-sync-status" role="status">{connected && game.name === 'Overwatch 2' ? 'Steam did not verify this free game in your account library or stats. If you play it on Steam, add and save a PC Steam copy to Overwatch 2, then choose Link this copy to Steam and select app 2357570.' : ownedCount ? `No owned Steam game matched “${game.name}”. Try syncing your Steam account again if you recently acquired it.` : 'No owned Steam games are available yet. Connect and sync your Steam account in Discovery first.'}</p>}
    <div className="modal-actions steam-sync-actions">
      <button type="button" className="btn btn-ghost" onClick={onClose} disabled={linking}>Cancel</button>
      {linkedElsewhere ? <button type="button" className="btn btn-secondary" onClick={() => onMerge(linkedElsewhere.name)}><GitMerge size={17} /> Review duplicate</button>
        : <button type="button" className="btn btn-primary" onClick={linkSelected} disabled={!selected || !!linkedHere || loading || linking}>{linking ? <Loader2 className="spinner" size={17} /> : linkedHere ? <Check size={17} /> : <Link2 size={17} />}{linkedHere ? 'Already linked' : linking ? 'Linking…' : 'Link Steam copy'}</button>}
    </div>
  </dialog>;
}
