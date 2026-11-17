import { useMemo, useState } from 'react';
import { Layers, Plus, Trash2, X } from 'lucide-react';
import type { OwnedCopy, SharedGameLink } from '../lib/ownedCopies';
import { parseCopies, sharedGameLinks } from '../lib/ownedCopies';
import { sameCopyValue } from '../lib/copyCompatibility';

export interface ShareTargetGame {
  id: number;
  name: string;
  copies?: string | null;
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

const priceText = (value: number | null) => value == null ? '' : String(Number(value.toFixed(2)));

/**
 * The games stored on one cartridge or disc. Each game keeps its own copy for
 * playtime; the copy's details and price belong to the object and are shared.
 * Changes here are part of the form and are saved with the rest of the game.
 */
export function SharedCopyGames({ copy, targets, onChange, onDeleteEverywhere }: {
  copy: OwnedCopy;
  targets: ShareTargetGame[];
  onChange: (patch: Partial<OwnedCopy>) => void;
  onDeleteEverywhere: () => void;
}) {
  const links = sharedGameLinks(copy);
  const savedIds = new Set(copy.physical_item?.games.map(game => game.id) || []);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [target, setTarget] = useState<ShareTargetGame | null>(null);
  const [targetCopyId, setTargetCopyId] = useState('');
  const [price, setPrice] = useState('');

  const linkedIds = useMemo(() => new Set(links.map(link => link.game_id)), [links]);
  const matches = useMemo(() => {
    const key = searchKey(query);
    if (!key) return [];
    return targets.filter(game => !linkedIds.has(game.id) && searchKey(game.name).includes(key)).slice(0, 8);
  }, [query, targets, linkedIds]);

  // Copies of a game that could be this same object: not Steam, not shared yet, same platform.
  const groupableCopies = (game: ShareTargetGame) => parseCopies(game.copies).filter(candidate => candidate.id && !candidate.steam_appid
    && !candidate.physical_item && (!copy.platform || sameCopyValue(candidate.platform, copy.platform)));
  const groupable = target ? groupableCopies(target) : [];
  const joining = groupable.find(candidate => candidate.id === targetCopyId);
  const asksPrice = !!joining && typeof joining.price === 'number';

  const reset = () => { setAdding(false); setQuery(''); setTarget(null); setTargetCopyId(''); setPrice(''); };
  const chooseCopy = (candidates: OwnedCopy[], id: string) => {
    setTargetCopyId(id);
    const candidate = candidates.find(value => value.id === id);
    setPrice(priceText(candidate ? suggestedPrice(copy.price, candidate.price) : null));
  };
  const choose = (game: ShareTargetGame) => {
    setTarget(game);
    // Grouping an existing copy is the common case when the games were split by hand before.
    const candidates = groupableCopies(game);
    chooseCopy(candidates, candidates[0]?.id || '');
  };
  const add = () => {
    if (!target) return;
    const link: SharedGameLink = { game_id: target.id, name: target.name };
    if (targetCopyId) link.copy_id = targetCopyId;
    const patch: Partial<OwnedCopy> = { shared_games: [...links, link] };
    if (asksPrice) patch.price = price.trim() === '' ? null : Number(price);
    // A copy with no details yet takes those of the copy it joins.
    if (joining) {
      if (!copy.name && joining.name) patch.name = joining.name;
      if (!copy.region && joining.region) patch.region = joining.region;
      if (!copy.source && joining.source) patch.source = joining.source;
      if (!copy.store_url && joining.store_url) patch.store_url = joining.store_url;
      if (typeof copy.price !== 'number' && typeof joining.price === 'number' && !asksPrice) patch.price = joining.price;
    }
    onChange(patch);
    reset();
  };
  const remove = (gameId: number) => onChange({ shared_games: links.filter(link => link.game_id !== gameId) });
  const pending = links.some(link => !savedIds.has(link.game_id)) || links.length !== savedIds.size;

  return <div className="wide shared-copy-games">
    <div className="shared-copy-games-heading">
      <Layers size={15} />
      <strong>{links.length ? 'Games on this cartridge or disc' : 'Holds more games?'}</strong>
    </div>
    {links.length ? <ul className="shared-copy-chips">
      <li className="shared-copy-chip current">This game</li>
      {links.map(link => <li className={`shared-copy-chip${savedIds.has(link.game_id) ? '' : ' pending'}`} key={link.game_id}>
        <span>{link.name || targets.find(game => game.id === link.game_id)?.name || 'Game'}</span>
        <button type="button" className="icon-btn" aria-label={`Take ${link.name || 'this game'} off this copy`} title="Take off this copy. A game already saved on it keeps its own copy, without the price." onClick={() => remove(link.game_id)}><X size={13} /></button>
      </li>)}
    </ul> : <small className="text-muted">For a cartridge or disc with several games, add the other games here. Each game keeps its own playtime; the details and price are shared and counted once.</small>}
    {pending && <small className="text-muted">Saved with the rest of the game when you save.</small>}

    {!adding ? <div className="shared-copy-actions">
      <button type="button" className="btn btn-secondary" onClick={() => setAdding(true)}><Plus size={16} />Add a game on this copy</button>
      {copy.physical_item && <button type="button" className="btn btn-secondary" onClick={() => {
        const names = ['this game', ...copy.physical_item!.games.map(game => `“${game.name}”`)].join(', ');
        if (!window.confirm(`Delete this copy from ${names} when you save? Their playtime on it is lost.`)) return;
        onDeleteEverywhere();
      }}><Trash2 size={16} />Delete from all its games</button>}
    </div> : <div className="shared-copy-add">
      {!target ? <>
        <label>Game in your collection<input className="form-input" autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name" /></label>
        {matches.length > 0 && <ul className="shared-copy-matches">{matches.map(game => <li key={game.id}>
          <button type="button" onClick={() => choose(game)}>{game.name}</button>
        </li>)}</ul>}
        {query.trim() && !matches.length && <small className="text-muted">No other game matches. Add it to your collection first.</small>}
      </> : <>
        <p className="shared-copy-target"><strong>{target.name}</strong><button type="button" className="btn-link" onClick={() => { setTarget(null); setTargetCopyId(''); setPrice(''); }}>Change</button></p>
        <label>Its copy<select className="form-input" value={targetCopyId} onChange={event => chooseCopy(groupable, event.target.value)}>
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
        {target && <button type="button" className="btn btn-primary" disabled={asksPrice && price.trim() !== '' && !(Number(price) >= 0)} onClick={add}><Layers size={16} />Add to this copy</button>}
        <button type="button" className="btn btn-secondary" onClick={reset}>Cancel</button>
      </div>
    </div>}
  </div>;
}
