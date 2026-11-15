import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { Check, EyeOff, Gamepad2, Heart, Loader2, PackageCheck, RefreshCw, RotateCcw, Search, SlidersHorizontal, Undo2, X } from 'lucide-react';
import { WantedGameEditor } from '../components/WantedGameEditor';
import { discoveryApi, emptyWanted, errorMessage, timestamp } from '../lib/discovery';
import type { WantedDraft } from '../lib/discovery';
import {
  CATALOG_SORTS, DEFAULT_CATALOG_FILTERS, activeFilterCount, filterCatalog, isSteamWithoutPhysical, releaseYear, searchKey,
} from '../lib/physicalCatalog';
import type { CatalogFilters, CatalogGame, CatalogResponse, CatalogStatus } from '../lib/physicalCatalog';
import './PhysicalCatalog.css';

const PAGE_SIZE = 60;
const FILTERS_KEY = 'switch-catalog-filters';

function loadFilters(): CatalogFilters {
  try {
    // The search text is never restored: opening the tab always starts on the full catalog.
    return { ...DEFAULT_CATALOG_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) || '{}'), query: '' };
  } catch { return DEFAULT_CATALOG_FILTERS; }
}

function releaseText(game: CatalogGame) {
  if (game.release_date) return new Date(`${game.release_date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return game.release_label || 'Date to be announced';
}

const platformLabel = (platform: string) => platform === 'Nintendo Switch 2' ? 'Switch 2' : 'Switch';

function Cover({ game }: { game: CatalogGame }) {
  const [failed, setFailed] = useState(false);
  return <div className="cat-cover">
    {game.image_url && !failed ? <img src={game.image_url} alt="" loading="lazy" onError={() => setFailed(true)} /> : <Gamepad2 size={34} aria-hidden />}
  </div>;
}

export function PhysicalCatalog() {
  const [games, setGames] = useState<CatalogGame[]>([]);
  const [status, setStatus] = useState<CatalogStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [filters, setFilters] = useState<CatalogFilters>(loadFilters);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // "Don't show" and "I already have it" are separate lists, each with its own dialog.
  const [dialog, setDialog] = useState<'hidden' | 'owned' | null>(null);
  const [dialogQuery, setDialogQuery] = useState('');
  const [lastAction, setLastAction] = useState<{ game: CatalogGame; kind: 'hidden' | 'owned' } | null>(null);
  const [editing, setEditing] = useState<{ game: CatalogGame; draft: WantedDraft } | null>(null);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const today = new Date().toLocaleDateString('en-CA');
  const deferredFilters = useDeferredValue(filters);

  const load = useCallback(() => discoveryApi<CatalogResponse>('/catalog')
    .then(data => { setGames(data.games); setStatus(data.status); setError(''); })
    .catch(reason => setError(errorMessage(reason)))
    .finally(() => setLoading(false)), []);
  useEffect(() => { void load(); }, [load]);
  // The first build takes a while; keep the list filling in while the server works.
  useEffect(() => {
    if (!status?.running) return;
    const timer = window.setInterval(() => { void load(); }, 20000);
    return () => window.clearInterval(timer);
  }, [status?.running, load]);
  useEffect(() => {
    try { localStorage.setItem(FILTERS_KEY, JSON.stringify({ ...filters, query: '' })); } catch { /* private storage */ }
  }, [filters]);

  const results = useMemo(() => filterCatalog(games, deferredFilters, today), [games, deferredFilters, today]);
  const hiddenGames = useMemo(() => games.filter(game => game.hidden).sort((a, b) => a.name.localeCompare(b.name)), [games]);
  // One entry per mark (a mark covers every edition and console of the title),
  // shown under its shortest name; later entries replace earlier ones in the Map.
  const markedGames = useMemo(() => [...new Map(games.filter(game => game.marked_owned_id != null)
    .sort((a, b) => b.name.length - a.name.length)
    .map(game => [game.marked_owned_id, game] as const)).values()]
    .sort((a, b) => a.name.localeCompare(b.name)), [games]);
  const years = useMemo(() => [...new Set(games.map(releaseYear).filter(Boolean))].sort().reverse(), [games]);
  const ownedCount = useMemo(() => games.filter(game => game.owned && !game.hidden).length, [games]);
  const steamCount = useMemo(() => games.filter(game => isSteamWithoutPhysical(game) && !game.hidden).length, [games]);
  const savedCount = useMemo(() => games.filter(game => game.saved && !game.hidden).length, [games]);
  const ownedHidden = !filters.steamOnly && !filters.showOwned && ownedCount > 0;
  const filterCount = activeFilterCount(filters);
  const shown = results.slice(0, visible);

  useEffect(() => {
    const node = sentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(count => count + PAGE_SIZE);
    }, { rootMargin: '600px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [results.length, visible]);

  function update<K extends keyof CatalogFilters>(key: K, value: CatalogFilters[K]) {
    setFilters(current => ({ ...current, [key]: value }));
    setVisible(PAGE_SIZE);
  }

  async function setHidden(game: CatalogGame, hidden: boolean) {
    const apply = (value: boolean) => setGames(current => current.map(row => row.id === game.id ? { ...row, hidden: value } : row));
    apply(hidden);
    setLastAction(hidden ? { game, kind: 'hidden' } : null);
    try { await discoveryApi(`/catalog/${game.id}/hidden?hidden=${hidden}`, { method: 'PUT' }); }
    catch (reason) { apply(!hidden); setLastAction(null); setError(errorMessage(reason)); }
  }

  async function setOwned(game: CatalogGame, owned: boolean) {
    // The mark covers every edition and console of the title, so the server's answer is reloaded.
    setGames(current => current.map(row => row.id === game.id ? { ...row, marked_owned: owned, owned: owned || (row.owned && !row.marked_owned) } : row));
    setLastAction(owned ? { game, kind: 'owned' } : null);
    try { await discoveryApi(`/catalog/${game.id}/owned?owned=${owned}`, { method: 'PUT' }); }
    catch (reason) { setLastAction(null); setError(errorMessage(reason)); }
    await load();
  }

  async function restoreAll() {
    const previous = games;
    setGames(current => current.map(row => row.hidden ? { ...row, hidden: false } : row));
    setDialog(null); setLastAction(null);
    try { await discoveryApi('/catalog/hidden', { method: 'DELETE' }); }
    catch (reason) { setGames(previous); setError(errorMessage(reason)); }
  }

  async function refresh() {
    setNotice(''); setError('');
    try {
      const response = await discoveryApi<{ started: boolean; message: string }>('/catalog/refresh', { method: 'POST' });
      setNotice(response.message);
      await load();
    } catch (reason) { setError(errorMessage(reason)); }
  }

  async function removeWanted(game: CatalogGame) {
    const ids = game.wanted_ids ?? [];
    if (!ids.length) return;
    const entries = ids.length === 1 ? 'its entry' : `its ${ids.length} entries`;
    if (!window.confirm(`Remove “${game.name}” from Games I want (${entries})? Steam sync will not re-add it.`)) return;
    setRemovingId(game.id); setNotice(''); setError('');
    try {
      for (const id of ids) await discoveryApi(`/games/${id}`, { method: 'DELETE' });
      setNotice(`${game.name} removed from Games I want.`);
    } catch (reason) { setError(errorMessage(reason)); }
    finally {
      // Reload so every card of this title (both consoles) shows what the server kept.
      setRemovingId(null);
      await load();
    }
  }

  function save(game: CatalogGame) {
    setEditing({ game, draft: { ...emptyWanted(), name: game.name, image_url: game.image_url, platform: game.platform, format: 'Physical',
      release_date: game.release_date, publication_year: Number(releaseYear(game)) || null, store_url: game.source_url } });
  }

  useEffect(() => {
    if (!dialog) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setDialog(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [dialog]);

  const openDialog = (kind: 'hidden' | 'owned') => { setDialogQuery(''); setDialog(kind); };
  const dialogGames = dialog === 'owned' ? markedGames : hiddenGames;
  const dialogMatches = dialogGames.filter(game => searchKey(game.name).includes(searchKey(dialogQuery)));
  const dialogText = dialog === 'owned' ? {
    title: 'Games I already have',
    intro: 'Titles you marked “I already have it”, for editions your collection names differently. Each mark covers every edition and console of the game, which then counts as owned.',
    empty: 'Nothing is marked. Use “I already have it” on a game to move it here.',
    noMatch: 'No marked game matches that search.', search: 'Search marked games…', restore: 'Unmark',
  } : {
    title: 'Hidden games',
    intro: 'Games you marked “Don’t show”. They stay out of the catalog until you restore them here.',
    empty: 'Nothing is hidden. Use “Don’t show” on a game to move it here.',
    noMatch: 'No hidden game matches that search.', search: 'Search hidden games…', restore: 'Restore',
  };
  const building = !!status?.running;
  const empty = !loading && games.length === 0;

  return <section className="cat">
    <div className="cat-toolbar">
      <label className="cat-search">
        <Search size={19} aria-hidden />
        <input type="search" value={filters.query} onChange={event => update('query', event.target.value)} placeholder="Search any physical Switch or Switch 2 game…" aria-label="Search the physical catalog" autoComplete="off" />
        {filters.query && <button type="button" onClick={() => update('query', '')} aria-label="Clear search"><X size={16} /></button>}
      </label>
      <select className="cat-select" value={filters.sort} onChange={event => update('sort', event.target.value as CatalogFilters['sort'])} aria-label="Sort the catalog">
        {CATALOG_SORTS.map(sort => <option key={sort.value} value={sort.value}>{sort.label}</option>)}
      </select>
      <button type="button" className={`cat-button ${filtersOpen || filterCount ? 'active' : ''}`} onClick={() => setFiltersOpen(open => !open)} aria-expanded={filtersOpen}>
        <SlidersHorizontal size={16} /> Filters{filterCount > 0 && <span className="cat-pill">{filterCount}</span>}
      </button>
      <button type="button" className="cat-button" onClick={() => openDialog('hidden')}>
        <EyeOff size={16} /> Hidden games<span className="cat-pill">{hiddenGames.length}</span>
      </button>
      <button type="button" className="cat-button" onClick={() => openDialog('owned')}>
        <PackageCheck size={16} /> Games I have<span className="cat-pill">{markedGames.length}</span>
      </button>
    </div>

    <div className="cat-quick" role="group" aria-label="Quick filters">
      {(['all', 'Nintendo Switch', 'Nintendo Switch 2'] as const).map(value => <button type="button" key={value} className="cat-chip" aria-pressed={filters.platform === value} onClick={() => update('platform', value)}>{value === 'all' ? 'Both consoles' : value}</button>)}
      <span className="cat-divider" aria-hidden />
      <label className="cat-toggle" title="Games you own on Switch or Switch 2. Copies on Steam or other platforms don’t count."><input type="checkbox" checked={filters.showOwned} disabled={filters.steamOnly} onChange={event => update('showOwned', event.target.checked)} /> Also show games I own on Switch{ownedCount > 0 && <small>{ownedCount}</small>}</label>
      <label className="cat-toggle" title="Games in your Steam library that you don’t have as a physical Switch copy yet"><input type="checkbox" checked={filters.steamOnly} onChange={event => update('steamOnly', event.target.checked)} /> Only games I have on Steam, not physical{steamCount > 0 && <small>{steamCount}</small>}</label>
      <label className="cat-toggle" title="Games you already saved to Games I want"><input type="checkbox" checked={filters.hideSaved} onChange={event => update('hideSaved', event.target.checked)} /> Hide games in Games I want{savedCount > 0 && <small>{savedCount}</small>}</label>
    </div>

    {filtersOpen && <div className="cat-filters">
      <label>Format<select value={filters.format} onChange={event => update('format', event.target.value as CatalogFilters['format'])}><option value="all">Any physical format</option><option value="Game Card">Game card</option><option value="Game-Key Card">Game-Key Card</option></select></label>
      <label>Release<select value={filters.release} onChange={event => update('release', event.target.value as CatalogFilters['release'])}><option value="all">Released and upcoming</option><option value="released">Already released</option><option value="upcoming">Upcoming or undated</option></select></label>
      <label>Year<select value={filters.year} onChange={event => update('year', event.target.value)}><option value="">Any year</option>{years.map(year => <option key={year}>{year}</option>)}</select></label>
      {filterCount > 0 && <button type="button" className="cat-link" onClick={() => { setFilters({ ...DEFAULT_CATALOG_FILTERS, query: filters.query, sort: filters.sort }); setVisible(PAGE_SIZE); }}><RotateCcw size={14} /> Reset filters</button>}
    </div>}

    {error && <div className="disc-alert error" role="alert">{error} <button className="disc-text-button" onClick={() => { setError(''); void load(); }}>Retry</button></div>}
    {notice && <p className="disc-alert success" role="status">{notice}</p>}
    {building && <p className="cat-status" role="status"><Loader2 size={16} className="spinner" /> <span><strong>Building the catalog.</strong> {status?.phase || 'Working'}… Games appear here as they are confirmed; this page updates on its own.</span></p>}
    {!building && status?.error && <p className="disc-alert" role="status">{status.error}</p>}

    {lastAction && <div className="cat-undo" role="status">
      <span><strong>{lastAction.game.name}</strong> {lastAction.kind === 'owned' ? 'is marked as a game you have.' : 'is hidden.'}</span>
      <button type="button" onClick={() => void (lastAction.kind === 'owned' ? setOwned(lastAction.game, false) : setHidden(lastAction.game, false))}><Undo2 size={15} /> Undo</button>
      <button type="button" onClick={() => setLastAction(null)} aria-label="Dismiss"><X size={15} /></button>
    </div>}

    {loading ? <p className="disc-empty"><Loader2 className="spinner" size={26} /> Loading the catalog…</p> : empty ? <div className="disc-empty">
      <Gamepad2 size={36} />
      <h3>{building ? 'The catalog is being built for the first time' : 'The catalog is empty'}</h3>
      <small>{building ? 'The first build reads every physical release and takes a while. You can leave this page; it continues on the server.' : 'Start a refresh to read every physical Switch and Switch 2 release.'}</small>
      {!building && <button className="btn btn-primary" onClick={() => void refresh()}><RefreshCw size={16} /> Build the catalog</button>}
    </div> : <>
      <p className="cat-count" aria-live="polite"><strong>{results.length.toLocaleString()}</strong> {results.length === 1 ? 'game' : 'games'}{filters.query.trim() ? <> matching “{filters.query.trim()}”</> : null}{filters.steamOnly ? <> on Steam without a physical copy</> : null}{ownedHidden ? <> · {ownedCount} owned on Switch not shown</> : null}</p>
      {results.length === 0 ? <div className="disc-empty">
        <Search size={32} />
        <h3>No games match</h3>
        <small>{filters.steamOnly ? 'No Steam game without a physical copy matches. Try fewer words or loosen the filters.' : ownedHidden ? 'Games you already own on Switch are not shown. Turn on “Also show games I own on Switch”, or loosen the filters.' : 'Try fewer words or reset the filters.'}</small>
      </div> : <div className="cat-grid">{shown.map(game => <article className={`cat-card ${game.owned ? 'owned' : ''}`} key={game.id}>
        <Cover game={game} />
        <div className="cat-body">
          <div className="cat-badges">
            <span className={`cat-badge ${game.platform === 'Nintendo Switch 2' ? 'switch2' : 'switch'}`}>{platformLabel(game.platform)}</span>
            {game.format === 'Game-Key Card' && <span className="cat-badge keycard">Game-Key Card</span>}
            {game.owned && <span className="cat-badge owned" title={game.marked_owned ? 'You marked this game “I already have it”' : game.owned_platforms.length ? `In your collection on ${game.owned_platforms.join(', ')}` : 'In your collection'}><Check size={11} /> {game.owned_physical || game.marked_owned ? 'Owned' : 'Owned digital'}</span>}
            {game.on_steam && <span className="cat-badge steam" title="In your Steam library">Steam</span>}
          </div>
          <h3 title={game.name}>{game.name}</h3>
          <p className="cat-meta">{releaseText(game)}{game.publisher ? ` · ${game.publisher}` : ''}</p>
          <div className="cat-actions">
            {game.saved
              ? <button type="button" className="cat-action primary wanted" disabled={removingId === game.id} onClick={() => void removeWanted(game)} title="Remove from Games I want" aria-label={`Remove ${game.name} from Games I want`}>
                {removingId === game.id ? <><Loader2 size={14} className="spinner" /> Removing</> : <><span className="at-rest"><Check size={14} /> Wanted</span><span className="on-hover"><X size={14} /> Remove</span></>}
              </button>
              : <button type="button" className="cat-action primary" onClick={() => save(game)}><Heart size={14} /> Want</button>}
            <button type="button" className="cat-action icon" onClick={() => void setHidden(game, true)} title="Don’t show: hide this game until you restore it from Hidden games" aria-label={`Don’t show ${game.name}`}><EyeOff size={15} /></button>
            {/* A copy in the collection already makes the game owned; the mark is for the rest. */}
            {(!game.owned || game.marked_owned) && <button type="button" className="cat-action icon" aria-pressed={game.marked_owned}
              onClick={() => void setOwned(game, !game.marked_owned)}
              title={game.marked_owned ? 'Unmark: you no longer have this game' : 'I already have it: count this game, in every edition, as owned'}
              aria-label={game.marked_owned ? `Unmark ${game.name} as a game you have` : `I already have ${game.name}`}><PackageCheck size={15} /></button>}
          </div>
        </div>
      </article>)}</div>}
      {shown.length < results.length && <div ref={sentinel} className="cat-more"><button type="button" className="btn btn-secondary" onClick={() => setVisible(count => count + PAGE_SIZE)}>Show more ({(results.length - shown.length).toLocaleString()} left)</button></div>}
      <p className="disc-source-note">Retail releases from Nintendo Life’s games database and Nintendo Europe’s catalog. Game-Key Cards are included and labelled; code-in-box products are left out. Limited-print and region-exclusive releases can be missing.{status?.listing_at ? ` Last refreshed: ${timestamp(status.listing_at)}.` : ''} {!building && <button type="button" className="disc-text-button" onClick={() => void refresh()}><RefreshCw size={12} /> Refresh now</button>}</p>
    </>}

    {dialog && <div className="disc-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setDialog(null); }}>
      <div className="disc-confirm-dialog disc-review-dialog cat-hidden-dialog" role="dialog" aria-modal="true" aria-labelledby="cat-hidden-title">
        <button className="disc-confirm-close" onClick={() => setDialog(null)} aria-label="Close"><X size={18} /></button>
        <div className="disc-review-dialog-heading"><div><h2 id="cat-hidden-title">{dialogText.title}</h2><p>{dialogText.intro}</p></div></div>
        {dialogGames.length > 8 && <label className="cat-search compact"><Search size={16} aria-hidden /><input type="search" value={dialogQuery} onChange={event => setDialogQuery(event.target.value)} placeholder={dialogText.search} aria-label={dialogText.search.replace('…', '')} /></label>}
        <div className="disc-review-dialog-list">
          {dialogGames.length === 0 ? <p className="disc-review-empty">{dialogText.empty}</p>
            : dialogMatches.length === 0 ? <p className="disc-review-empty">{dialogText.noMatch}</p>
            : dialogMatches.map(game => <div className="cat-hidden-row" key={game.id}>
              <Cover game={game} />
              <div><strong>{game.name}</strong><small>{platformLabel(game.platform)}{game.format === 'Game-Key Card' ? ' · Game-Key Card' : ''} · {releaseText(game)}</small></div>
              <button type="button" className="btn btn-secondary" onClick={() => void (dialog === 'owned' ? setOwned(game, false) : setHidden(game, false))}><Undo2 size={15} /> {dialogText.restore}</button>
            </div>)}
        </div>
        <div className="disc-actions">
          {dialog === 'hidden' && hiddenGames.length > 1 && <button type="button" className="btn btn-secondary" onClick={() => void restoreAll()}>Restore all {hiddenGames.length}</button>}
          <button type="button" className="btn btn-primary" onClick={() => setDialog(null)}>Done</button>
        </div>
      </div>
    </div>}

    {editing && <WantedGameEditor initial={editing.draft} title="Save to Games I want" onClose={() => setEditing(null)} onSave={async draft => {
      const created = await discoveryApi<{ id: number }>('/games', { method: 'POST', body: JSON.stringify(draft) });
      const saved = editing.game;
      setGames(current => current.map(row => row.id === saved.id
        ? { ...row, saved: true, wanted_ids: [...(row.wanted_ids ?? []), created.id] } : row));
      setNotice(`${draft.name} saved to Games I want.`);
    }} />}
  </section>;
}
