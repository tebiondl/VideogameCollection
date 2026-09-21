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
  [key: string]: unknown;
}

type Direction = 'current_into_other' | 'other_into_current';
type FieldSource = 'current' | 'other';

const MERGE_FIELDS = [
  ['description', 'Description'], ['comments', 'Comments / review'], ['image_url', 'Cover'],
  ['status', 'Status'], ['playtime_hours', 'My added time'], ['playtime_mode', 'Time display mode'],
  ['mark', 'Rating'], ['hype', 'Anticipation'], ['completion_date', 'Completion date'],
  ['completion_percentage', 'Completion %'], ['publication_year', 'Publication year'],
  ['release_date', 'Release date'], ['reviewed', 'Checked / reviewed'], ['igdb_id', 'IGDB identity'], ['tags', 'Tags'], ['dlcs', 'DLC list'], ['old_copies', 'Old copies'],
] as const;

function shownValue(value: unknown) {
  if (value === null || value === undefined || value === '') return 'Empty';
  if (typeof value === 'string' && value.length > 90) return `${value.slice(0, 87)}…`;
  return String(value);
}

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
  const [fieldSources, setFieldSources] = useState<Record<string, FieldSource>>({});
  const [primarySteamAppid, setPrimarySteamAppid] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { dialog.current?.showModal(); }, []);
  const candidates = useMemo(() => games.filter(candidate =>
    candidate.id !== game.id && !candidate.hidden && !candidate.is_dlc &&
    (!query.trim() || candidate.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  ), [game.id, games, query]);
  const selected = games.find(candidate => candidate.id === selectedId) || null;
  const dataFields = useMemo(() => selected ? MERGE_FIELDS.filter(([key]) =>
    shownValue(game[key]) !== shownValue(selected[key]) &&
    (shownValue(game[key]) !== 'Empty' || shownValue(selected[key]) !== 'Empty')
  ) : [], [game, selected]);
  const steamCopies = useMemo(() => selected ? [...parseCopies(game.copies), ...parseCopies(selected.copies)]
    .filter(copy => copy.steam_appid)
    .filter((copy, index, all) => all.findIndex(other => other.steam_appid === copy.steam_appid) === index) : [], [game.copies, selected]);

  function chooseCandidate(candidate: CollectionGame) {
    setSelectedId(candidate.id);
    setDirection('current_into_other');
    setFieldSources(Object.fromEntries(MERGE_FIELDS.map(([key]) => [key, 'other'])));
    const copies = [...parseCopies(game.copies), ...parseCopies(candidate.copies)].filter(copy => copy.steam_appid);
    setPrimarySteamAppid(parseCopies(candidate.copies).find(copy => copy.steam_appid)?.steam_appid || copies[0]?.steam_appid || null);
  }

  function chooseDirection(next: Direction) {
    setDirection(next);
    const retained: FieldSource = next === 'other_into_current' ? 'current' : 'other';
    setFieldSources(Object.fromEntries(MERGE_FIELDS.map(([key]) => [key, retained])));
    const retainedGame = next === 'other_into_current' ? game : selected;
    setPrimarySteamAppid(
      parseCopies(retainedGame?.copies).find(copy => copy.steam_appid)?.steam_appid || steamCopies[0]?.steam_appid || null,
    );
  }

  async function merge() {
    if (!selectedId) return;
    setBusy(true); setError('');
    try {
      const response = await fetchWithAuth(`/discovery/steam/collection-games/${game.id}/merge-duplicate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ other_game_id: selectedId, direction, field_sources: fieldSources, primary_steam_appid: primarySteamAppid }),
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
    <p className="disc-muted">Choose the other collection card, then choose which card should remain. Unique copies keep their Steam links and names; matching Steam copies keep the remaining card’s copy.</p>
    {error && <p className="disc-alert error" role="alert">{error}</p>}
    <label className="duplicate-search"><Search size={18} /><input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search your collection…" /></label>
    <div className="duplicate-game-list">
      {candidates.map(candidate => {
        const copies = parseCopies(candidate.copies);
        return <button type="button" key={candidate.id} className={`duplicate-game-option ${selectedId === candidate.id ? 'selected' : ''}`} onClick={() => chooseCandidate(candidate)}>
          {candidate.image_url ? <img src={candidate.image_url} alt="" /> : <span className="duplicate-cover-placeholder" />}
          <span><strong>{candidate.name}</strong><small>{copies.length} {copies.length === 1 ? 'copy' : 'copies'} · {copies.filter(copy => copy.steam_appid).length} Steam</small></span>
        </button>;
      })}
      {candidates.length === 0 && <p className="disc-muted">No collection games match this search.</p>}
    </div>
    {selected && <fieldset className="duplicate-direction">
      <legend>Which game is the duplicate?</legend>
      <label className={direction === 'current_into_other' ? 'selected' : ''}><input type="radio" name="duplicate-direction" checked={direction === 'current_into_other'} onChange={() => chooseDirection('current_into_other')} /><span><strong>{game.name}</strong> is the duplicate<small>Keep {selected.name}; move this game’s copies into it.</small></span></label>
      <label className={direction === 'other_into_current' ? 'selected' : ''}><input type="radio" name="duplicate-direction" checked={direction === 'other_into_current'} onChange={() => chooseDirection('other_into_current')} /><span><strong>{selected.name}</strong> is the duplicate<small>Keep {game.name}; move the selected game’s copies here.</small></span></label>
    </fieldset>}
    {selected && dataFields.length > 0 && <section className="duplicate-data-picker">
      <div><h3>Choose the data to keep</h3><p className="disc-muted">Choose each field independently. Unique copies and Steam links are combined; identical Steam links keep the remaining card’s copy.</p></div>
      {dataFields.map(([key, label]) => <fieldset key={key}><legend>{label}</legend>
        <label className={fieldSources[key] === 'current' ? 'selected' : ''}><input type="radio" name={`merge-${key}`} checked={fieldSources[key] === 'current'} onChange={() => setFieldSources(current => ({ ...current, [key]: 'current' }))} /><span><strong>{game.name}</strong><small>{shownValue(game[key])}</small></span></label>
        <label className={fieldSources[key] === 'other' ? 'selected' : ''}><input type="radio" name={`merge-${key}`} checked={fieldSources[key] === 'other'} onChange={() => setFieldSources(current => ({ ...current, [key]: 'other' }))} /><span><strong>{selected.name}</strong><small>{shownValue(selected[key])}</small></span></label>
      </fieldset>)}
    </section>}
    {selected && steamCopies.length > 1 && <fieldset className="duplicate-direction duplicate-primary-copy">
      <legend>Primary Steam copy</legend>
      <p className="disc-muted">Choose the canonical Steam listing. The other Steam apps remain separate owned copies.</p>
      {steamCopies.map(copy => <label key={copy.steam_appid} className={primarySteamAppid === copy.steam_appid ? 'selected' : ''}><input type="radio" name="primary-steam-copy" checked={primarySteamAppid === copy.steam_appid} onChange={() => setPrimarySteamAppid(copy.steam_appid || null)} /><span><strong>{copy.name || `Steam app ${copy.steam_appid}`}</strong><small>App {copy.steam_appid}</small></span></label>)}
    </fieldset>}
    <div className="modal-actions duplicate-modal-actions"><button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button><button type="button" className="btn btn-primary" onClick={merge} disabled={!selected || busy}>{busy ? <Loader2 className="spinner" size={17} /> : <GitMerge size={17} />} Merge collection games</button></div>
  </dialog>;
}
