import { useMemo, useState } from 'react';
import { Layers, Plus, Trash2, X } from 'lucide-react';
import type { OwnedCopy } from '../lib/ownedCopies';
import { parseCopies } from '../lib/ownedCopies';
import { sameCopyValue } from '../lib/copyCompatibility';

export interface ShareTargetGame {
  id: number;
  name: string;
  copies?: string | null;
}

export interface ShareCopyRequest {
  target_game_id: number;
  target_copy_id?: string;
  price?: number | null;
}

const searchKey = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase().trim();
const money = (amount: number, currency: string) => `${Number(amount.toFixed(2))} ${currency}`;

function copyLabel(copy: OwnedCopy): string {
  const price = typeof copy.price === 'number' ? money(copy.price, copy.currency || 'EUR') : null;
  return [copy.name, copy.platform, copy.format, copy.region, price].filter(Boolean).join(' · ');
}

/** The price the whole object most likely cost when two copies are grouped. */
function suggestedPrice(current: number | null | undefined, joining: number | null | undefined): number | null {
  if (typeof joining !== 'number') return typeof current === 'number' ? current : null;
  if (typeof current !== 'number') return joining;
  // The same amount on each copy was the full price repeated; different ones were split.
  return current === joining ? current : current + joining;
}

/**
 * The games stored on one cartridge or disc. Each game keeps its own copy for
 * playtime; the copy's details and price belong to the object and are shared.
 */
export function SharedCopyGames({ copy, targets, onShare, onUnshare, onDeleteItem }: {
  copy: OwnedCopy;
  targets: ShareTargetGame[];
  onShare: (copy: OwnedCopy, request: ShareCopyRequest) => Promise<void>;
  onUnshare: (itemId: number, gameId: number) => Promise<void>;
  onDeleteItem: (itemId: number) => Promise<void>;
}) {
  const item = copy.physical_item;
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<ShareTargetGame | null>(null);
  const [targetCopyId, setTargetCopyId] = useState('');
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const linkedIds = new Set(item?.games.map(game => game.id) || []);
  const matches = useMemo(() => {
    const key = searchKey(query);
    if (!key) return [];
    return targets.filter(game => !linkedIds.has(game.id) && searchKey(game.name).includes(key)).slice(0, 8);
  // linkedIds is derived from item, which is already a dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, targets, item]);

  // Copies of the chosen game that could be the same object: unshared, not Steam, same platform.
  const groupable = target ? parseCopies(target.copies).filter(candidate => candidate.id && !candidate.steam_appid
    && !candidate.physical_item && (!copy.platform || sameCopyValue(candidate.platform, copy.platform))) : [];
  const joining = groupable.find(candidate => candidate.id === targetCopyId);
  const asksPrice = !!joining && typeof joining.price === 'number';

  const reset = () => { setAdding(false); setQuery(''); setTarget(null); setTargetCopyId(''); setPrice(''); setError(''); };
  const choose = (game: ShareTargetGame) => {
    setTarget(game);
    const candidates = parseCopies(game.copies).filter(candidate => candidate.id && !candidate.steam_appid
      && !candidate.physical_item && (!copy.platform || sameCopyValue(candidate.platform, copy.platform)));
    // Grouping an existing copy is the common case when the games were split by hand before.
    const first = candidates[0];
    setTargetCopyId(first?.id || '');
    const suggestion = first ? suggestedPrice(copy.price, first.price) : null;
    setPrice(suggestion == null ? '' : String(Number(suggestion.toFixed(2))));
  };
  const chooseCopy = (id: string) => {
    setTargetCopyId(id);
    const candidate = groupable.find(value => value.id === id);
    const suggestion = candidate ? suggestedPrice(copy.price, candidate.price) : null;
    setPrice(suggestion == null ? '' : String(Number(suggestion.toFixed(2))));
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await action();
      reset();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not update this shared copy.');
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    if (!target) return;
    const request: ShareCopyRequest = { target_game_id: target.id };
    if (targetCopyId) request.target_copy_id = targetCopyId;
    if (asksPrice) request.price = price.trim() === '' ? null : Number(price);
    void run(() => onShare(copy, request));
  };

  return <div className="wide shared-copy-games">
    <div className="shared-copy-games-heading">
      <Layers size={15} />
      <strong>{item ? 'Games on this cartridge or disc' : 'Holds more games?'}</strong>
    </div>
    {item ? <ul className="shared-copy-chips">
      <li className="shared-copy-chip current">This game</li>
      {item.games.map(game => <li className="shared-copy-chip" key={game.id}>
        <span>{game.name}</span>
        <button type="button" className="icon-btn" disabled={busy} aria-label={`Take ${game.name} off this copy`} title="Take off this copy. Its own copy stays, without the price." onClick={() => {
          if (!window.confirm(`Take “${game.name}” off this copy? It keeps its own copy with the same details, but without the price, which stays with this one.`)) return;
          void run(() => onUnshare(item.id, game.id));
        }}><X size={13} /></button>
      </li>)}
    </ul> : <small className="text-muted">For a cartridge or disc with several games, add the other games here. Each game keeps its own playtime; the details and price are shared and counted once.</small>}

    {!adding ? <div className="shared-copy-actions">
      <button type="button" className="btn btn-secondary" disabled={busy || !copy.id} onClick={() => setAdding(true)}><Plus size={16} />Add a game on this copy</button>
      {item && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => {
        const names = ['this game', ...item.games.map(game => `“${game.name}”`)].join(', ');
        if (!window.confirm(`Delete this copy from ${names}? Their playtime on it is lost.`)) return;
        void run(() => onDeleteItem(item.id));
      }}><Trash2 size={16} />Delete from all its games</button>}
    </div> : <div className="shared-copy-add">
      {!target ? <>
        <label>Game in your collection<input className="form-input" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name" /></label>
        {matches.length > 0 && <ul className="shared-copy-matches">{matches.map(game => <li key={game.id}>
          <button type="button" onClick={() => choose(game)}>{game.name}</button>
        </li>)}</ul>}
        {query.trim() && !matches.length && <small className="text-muted">No other game matches. Add it to your collection first.</small>}
      </> : <>
        <p className="shared-copy-target"><strong>{target.name}</strong><button type="button" className="btn-link" onClick={() => { setTarget(null); setTargetCopyId(''); }}>Change</button></p>
        <label>Its copy<select className="form-input" value={targetCopyId} onChange={event => chooseCopy(event.target.value)}>
          {groupable.map(candidate => <option key={candidate.id} value={candidate.id}>Use its copy: {copyLabel(candidate) || 'no details'}</option>)}
          <option value="">Add a new copy</option>
        </select></label>
        <small className="text-muted">{targetCopyId
          ? 'That copy joins this one. It keeps its playtime and takes these details.'
          : `A new copy with these details is added to ${target.name}.`}</small>
        {asksPrice && <label>Price of the whole cartridge or disc ({copy.currency || 'EUR'})<input className="form-input" type="number" min="0" step="0.01" value={price} onChange={event => setPrice(event.target.value)} />
          <small className="text-muted">This copy has {typeof copy.price === 'number' ? money(copy.price, copy.currency || 'EUR') : 'no price'} and that one {money(joining!.price as number, joining!.currency || 'EUR')}. The total is counted once.</small></label>}
      </>}
      <div className="shared-copy-actions">
        {target && <button type="button" className="btn btn-primary" disabled={busy || (asksPrice && price.trim() !== '' && !(Number(price) >= 0))} onClick={submit}><Layers size={16} />{busy ? 'Saving…' : 'Add to this copy'}</button>}
        <button type="button" className="btn btn-secondary" disabled={busy} onClick={reset}>Cancel</button>
      </div>
    </div>}
    {error && <small className="shared-copy-error">{error}</small>}
  </div>;
}
