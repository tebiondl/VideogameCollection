import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Edit2, Gamepad2, Grid2X2, Heart, List, PackageCheck, Plus, Search, Trash2 } from 'lucide-react';
import { AcquireGameEditor } from '../components/AcquireGameEditor';
import { PaginationControls } from '../components/PaginationControls';
import { WantedGameEditor } from '../components/WantedGameEditor';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import { discoveryApi, emptyWanted, errorMessage, toAcquireDraft } from '../lib/discovery';
import type { AcquireDraft, DiscoverySettings, WantedDraft, WantedGame } from '../lib/discovery';
import type { PageSize } from '../lib/pagination';
import './Discovery.css';

export function WantedGames() {
  const [games, setGames] = useState<WantedGame[]>([]);
  const [settings, setSettings] = useState<DiscoverySettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<{ draft: WantedDraft; id?: number } | null>(null);
  const [acquiring, setAcquiring] = useState<{ game: WantedGame; draft: AcquireDraft; nonSteamOnly: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [platform, setPlatform] = useState('');
  const [status, setStatus] = useState('active');
  const [format, setFormat] = useState('');
  const [kind, setKind] = useState('');
  const [source, setSource] = useState('');
  const [tag, setTag] = useState('');
  const [minHype, setMinHype] = useState('');
  const [releaseState, setReleaseState] = useState('');
  const [steamState, setSteamState] = useState('');
  const [sort, setSort] = useState('newest');
  const [view, setView] = useState('list');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(20);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([discoveryApi<WantedGame[]>('/games'), discoveryApi<DiscoverySettings>('/settings')]).then(([data, nextSettings]) => { if (!cancelled) { setGames(data); setSettings(nextSettings); setError(''); } }).catch(reason => { if (!cancelled) setError(errorMessage(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reload]);

  const today = new Date().toLocaleDateString('en-CA');
  const filtered = useMemo(() => games.filter(game => {
    if (query && !`${game.name} ${game.comments || ''} ${game.tags || ''} ${game.parent_game_name || ''}`.toLowerCase().includes(query.toLowerCase())) return false;
    if ((platform && game.platform !== platform) || (format && game.format !== format) || (source && game.source !== source)) return false;
    if (status === 'active' ? game.status === 'Acquired' : status && game.status !== status) return false;
    if ((kind === 'dlc' && !game.is_dlc) || (kind === 'game' && game.is_dlc)) return false;
    if (tag && !(game.tags || '').split(',').map(value => value.trim()).includes(tag)) return false;
    if (minHype && (game.hype ?? 0) < Number(minHype)) return false;
    if (releaseState === 'released' && (!game.release_date || game.release_date > today)) return false;
    if (releaseState === 'upcoming' && (!game.release_date || game.release_date <= today)) return false;
    if (releaseState === 'unknown' && game.release_date) return false;
    if ((steamState === 'missing' && !game.steam_wishlist_missing) || (steamState === 'listed' && game.steam_wishlist_missing)) return false;
    return true;
  }).sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name) : sort === 'hype' ? (b.hype ?? -1) - (a.hype ?? -1) : sort === 'release' ? (a.release_date || '9999').localeCompare(b.release_date || '9999') : b.created_at.localeCompare(a.created_at)), [games, query, platform, format, status, source, kind, tag, minHype, releaseState, steamState, sort, today]);
  const visiblePage = Math.min(page, pageSize === 'infinite' ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize)));
  const visible = pageSize === 'infinite' ? filtered : filtered.slice((visiblePage - 1) * pageSize, visiblePage * pageSize);
  const platforms = [...new Set(games.map(game => game.platform).filter(Boolean))].sort();
  const tags = [...new Set(games.flatMap(game => (game.tags || '').split(',').map(value => value.trim()).filter(Boolean)))].sort();
  const resetFilters = () => { setQuery(''); setPlatform(''); setFormat(''); setStatus('active'); setKind(''); setSource(''); setTag(''); setMinHype(''); setReleaseState(''); setSteamState(''); setPage(1); };
  const collectionSyncActive = !!settings?.sync_enabled && settings.sync_collection;
  const startAcquire = (game: WantedGame, nonSteamOnly = false) => {
    const draft = toAcquireDraft(game);
    setAcquiring({
      game,
      nonSteamOnly,
      draft: nonSteamOnly ? {
        ...draft,
        source: draft.source.toLowerCase() === 'steam' ? '' : draft.source,
        store_url: draft.store_url?.toLowerCase().includes('steampowered.com/app/') ? null : draft.store_url,
        steam_appid: null,
      } : draft,
    });
  };

  async function remove(game: WantedGame) {
    if (!window.confirm(`Remove “${game.name}” from Games I want? Steam sync will not re-add this entry.`)) return;
    setBusyId(game.id); setError('');
    try { await discoveryApi(`/games/${game.id}`, { method: 'DELETE' }); setMessage(`${game.name} removed.`); setReload(value => value + 1); }
    catch (reason) { setError(errorMessage(reason)); } finally { setBusyId(null); }
  }

  return <div className="container discovery wanted-page">
    <VideogamePageHeader eyebrow="Your shortlist" icon={<Heart />} title="Games I want" description="Keep the games, editions and DLCs you are considering in one place." actions={<button className="btn btn-primary" onClick={() => setEditing({ draft: emptyWanted() })}><Plus size={18} /> New game</button>} />
    {error && <p className="disc-alert error" role="alert">{error} <button className="disc-text-button" onClick={() => setReload(value => value + 1)}>Retry</button></p>}
    {message && <p className="disc-alert success" role="status">{message}</p>}
    <div className="disc-filters" onChange={() => setPage(1)}>
      <div className="disc-search"><Search size={18} /><input aria-label="Search wanted games" placeholder="Search games, notes or tags…" value={query} onChange={event => setQuery(event.target.value)} /></div>
      <select aria-label="Platform filter" value={platform} onChange={event => setPlatform(event.target.value)}><option value="">All platforms</option>{platforms.map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="Status filter" value={status} onChange={event => setStatus(event.target.value)}><option value="active">Not acquired</option><option value="">All statuses</option>{['Wanted', 'Watching', 'Preordered', 'Acquired'].map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="Format filter" value={format} onChange={event => setFormat(event.target.value)}><option value="">All formats</option>{['Any', 'Physical', 'Digital'].map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="Game type filter" value={kind} onChange={event => setKind(event.target.value)}><option value="">Games + DLCs</option><option value="game">Games only</option><option value="dlc">DLCs only</option></select>
      <select aria-label="Source filter" value={source} onChange={event => setSource(event.target.value)}><option value="">All sources</option><option value="steam">Steam</option><option value="manual">Manual / IGDB</option><option value="import">Smart Add</option></select>
      <select aria-label="Tag filter" value={tag} onChange={event => setTag(event.target.value)}><option value="">All tags</option>{tags.map(value => <option key={value}>{value}</option>)}</select>
      <select aria-label="Minimum anticipation" value={minHype} onChange={event => setMinHype(event.target.value)}><option value="">Any anticipation</option>{[1, 3, 5, 7, 9, 10].map(value => <option key={value} value={value}>{value}+ anticipation</option>)}</select>
      <select aria-label="Release date filter" value={releaseState} onChange={event => setReleaseState(event.target.value)}><option value="">Any release date</option><option value="released">Released</option><option value="upcoming">Upcoming</option><option value="unknown">Unknown date</option></select>
      <select aria-label="Steam wishlist state filter" value={steamState} onChange={event => setSteamState(event.target.value)}><option value="">Any Steam wishlist state</option><option value="listed">Still on Steam wishlist</option><option value="missing">Missing from Steam wishlist</option></select>
      <select aria-label="Sort wanted games" value={sort} onChange={event => setSort(event.target.value)}><option value="newest">Recently saved</option><option value="name">Name A–Z</option><option value="hype">Most anticipated</option><option value="release">Release date</option></select>
      <button className="disc-text-button" onClick={resetFilters}>Reset filters</button><div className="disc-view-toggle"><button aria-label="List view" aria-pressed={view === 'list'} onClick={() => setView('list')}><List size={18} /></button><button aria-label="Grid view" aria-pressed={view === 'grid'} onClick={() => setView('grid')}><Grid2X2 size={18} /></button></div>
    </div>
    {loading ? <p className="disc-empty">Loading your saved games…</p> : !filtered.length ? <div className="disc-empty"><Heart size={35} /><h3>{games.length ? 'No games match these filters' : 'Your next favorite starts here'}</h3><p>{games.length ? 'Try clearing filters or searching another title.' : 'Save a release, search IGDB, or connect your Steam wishlist.'}</p><Link className="btn btn-secondary" to="/dashboard/videogames/wanted/smart">Open Smart Add</Link></div> : <div className={`disc-games ${view}`}>{visible.map(game => <article className={`disc-game ${game.steam_wishlist_missing ? 'steam-missing' : ''}`} key={game.id}>
      <div className="disc-game-art">{game.image_url ? <img src={game.image_url} alt="" loading="lazy" /> : <Gamepad2 size={30} />}</div>
      <div className="disc-game-body"><div className="disc-badges">{game.is_dlc && <span className="disc-badge dlc">DLC</span>}<span className="disc-badge">{game.status}</span>{game.format !== 'Any' && <span className={`disc-badge ${game.format.toLowerCase()}`}>{game.format}</span>}{game.steam_appid && <span className="disc-badge">Steam linked</span>}{game.steam_wishlist_missing && <span className="disc-badge steam-missing">Missing from Steam wishlist</span>}</div><h3>{game.name}</h3><p className="disc-muted">{game.platform || 'Platform unspecified'} · {game.release_date || game.publication_year || 'Release TBA'}{game.parent_game_name && ` · For ${game.parent_game_name}`}</p>{game.steam_wishlist_missing && <p className="disc-steam-missing-note">Steam no longer returns this game in your wishlist. It stays here until you decide what happened.</p>}{game.comments && <p className="disc-game-notes">{game.comments}</p>}{game.tags && <p className="disc-tags">{game.tags}</p>}{game.dlcs && game.dlcs !== '[]' && <details className="disc-dlc-list"><summary>Included DLCs</summary>{(JSON.parse(game.dlcs) as { name: string; state: string }[]).map((dlc, index) => <p key={index}><span className="disc-badge dlc">DLC</span> {dlc.name} <small>{dlc.state.replaceAll('_', ' ')}</small></p>)}</details>}</div>
      <div className="disc-game-meta"><strong>{game.hype != null ? `${game.hype}/10` : '—'}</strong><small>anticipation</small>{game.target_price != null && <span>{new Intl.NumberFormat(undefined, { style: 'currency', currency: game.currency }).format(game.target_price)}<small>target price</small></span>}</div>
      <div className="disc-game-actions"><button className="disc-icon-button" title="Edit all fields" aria-label={`Edit ${game.name}`} onClick={() => setEditing({ draft: game, id: game.id })}><Edit2 size={17} /></button>{!game.collection_game_id && game.steam_appid && collectionSyncActive ? <><button className="disc-icon-button" title="Steam collection sync will move this game automatically when Steam reports it as owned" aria-label={`Steam manages moving ${game.name} to collection`} disabled><PackageCheck size={17} /></button><button className="disc-icon-button add-copy" title="Add a non-Steam copy to the collection" aria-label={`Add a new non-Steam copy of ${game.name}`} disabled={busyId !== null} onClick={() => startAcquire(game, true)}><Plus size={17} /></button></> : !game.collection_game_id && <button className="disc-icon-button" title="Move to collection" aria-label={`Move ${game.name} to collection`} disabled={busyId !== null} onClick={() => startAcquire(game)}><PackageCheck size={17} /></button>}{game.store_url && <a className="disc-icon-button" href={game.store_url} target="_blank" rel="noreferrer" aria-label={`Open store for ${game.name}`}><ArrowUpRight size={18} /></a>}<button className="disc-icon-button danger" aria-label={`Remove ${game.name}`} disabled={busyId !== null} onClick={() => remove(game)}><Trash2 size={17} /></button></div>
    </article>)}</div>}
    <PaginationControls page={visiblePage} pageSize={pageSize} pageSizeOptions={[10, 20, 50, 100]} totalItems={filtered.length} onPageChange={setPage} onPageSizeChange={size => { setPageSize(size); setPage(1); }} />
    {editing && <WantedGameEditor initial={editing.draft} title={editing.id ? 'Edit wanted game' : 'Save a game'} onClose={() => setEditing(null)} onSave={async draft => { await discoveryApi(editing.id ? `/games/${editing.id}` : '/games', { method: editing.id ? 'PUT' : 'POST', body: JSON.stringify(draft) }); setMessage(`${draft.name} saved.`); setReload(value => value + 1); }} />}
    {acquiring && <AcquireGameEditor initial={acquiring.draft} nonSteamOnly={acquiring.nonSteamOnly} onClose={() => setAcquiring(null)} onSave={async draft => { await discoveryApi(`/games/${acquiring.game.id}/acquire`, { method: 'POST', body: JSON.stringify(draft) }); setMessage(`${draft.name} is now in your collection.`); setReload(value => value + 1); }} />}
  </div>;
}
