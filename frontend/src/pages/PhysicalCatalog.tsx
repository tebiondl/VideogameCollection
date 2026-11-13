import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, EyeOff, Gamepad2, Heart, Loader2, RefreshCw, RotateCcw, Search, SlidersHorizontal, Undo2, X } from 'lucide-react';
import { WantedGameEditor } from '../components/WantedGameEditor';
import { discoveryApi, emptyWanted, errorMessage, timestamp } from '../lib/discovery';
import type { WantedDraft } from '../lib/discovery';
import {
  CATALOG_SORTS, DEFAULT_CATALOG_FILTERS, activeFilterCount, filterCatalog, releaseYear, searchKey,
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
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const [hiddenQuery, setHiddenQuery] = useState('');
  const [lastHidden, setLastHidden] = useState<CatalogGame | null>(null);
  const [editing, setEditing] = useState<{ game: CatalogGame; draft: WantedDraft } | null>(null);
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
  const years = useMemo(() => [...new Set(games.map(releaseYear).filter(Boolean))].sort().reverse(), [games]);
  const ownedCount = useMemo(() => games.filter(game => game.owned && !game.hidden).length, [games]);
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
    setLastHidden(hidden ? game : null);
    try { await discoveryApi(`/catalog/${game.id}/hidden?hidden=${hidden}`, { method: 'PUT' }); }
    catch (reason) { apply(!hidden); setLastHidden(null); setError(errorMessage(reason)); }
  }

  async function restoreAll() {
    const previous = games;
    setGames(current => current.map(row => row.hidden ? { ...row, hidden: false } : row));
    setHiddenOpen(false); setLastHidden(null);
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

  function save(game: CatalogGame) {
    setEditing({ game, draft: { ...emptyWanted(), name: game.name, image_url: game.image_url, platform: game.platform, format: 'Physical',
      release_date: game.release_date, publication_year: Number(releaseYear(game)) || null, store_url: game.source_url } });
  }

  useEffect(() => {
    if (!hiddenOpen) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setHiddenOpen(false); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [hiddenOpen]);

  const hiddenMatches = hiddenGames.filter(game => searchKey(game.name).includes(searchKey(hiddenQuery)));
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
      <button type="button" className="cat-button" onClick={() => { setHiddenQuery(''); setHiddenOpen(true); }}>
        <EyeOff size={16} /> Hidden games<span className="cat-pill">{hiddenGames.length}</span>
      </button>
    </div>

    <div className="cat-quick" role="group" aria-label="Quick filters">
      {(['all', 'Nintendo Switch', 'Nintendo Switch 2'] as const).map(value => <button type="button" key={value} className="cat-chip" aria-pressed={filters.platform === value} onClick={() => update('platform', value)}>{value === 'all' ? 'Both consoles' : value}</button>)}
      <span className="cat-divider" aria-hidden />
      <label className="cat-toggle"><input type="checkbox" checked={filters.showOwned} onChange={event => update('showOwned', event.target.checked)} /> Also show games I own{ownedCount > 0 && <small>{ownedCount}</small>}</label>
    </div>

    {filtersOpen && <div className="cat-filters">
      <label>Format<select value={filters.format} onChange={event => update('format', event.target.value as CatalogFilters['format'])}><option value="all">Any physical format</option><option value="Game Card">Game card</option><option value="Game-Key Card">Game-Key Card</option></select></label>
      <label>Release<select value={filters.release} onChange={event => update('release', event.target.value as CatalogFilters['release'])}><option value="all">Released and upcoming</option><option value="released">Already released</option><option value="upcoming">Upcoming or undated</option></select></label>
      <label>Year<select value={filters.year} onChange={event => update('year', event.target.value)}><option value="">Any year</option>{years.map(year => <option key={year}>{year}</option>)}</select></label>
      <label className="cat-toggle"><input type="checkbox" checked={filters.hideSaved} onChange={event => update('hideSaved', event.target.checked)} /> Hide games already in Games I want</label>
      {filterCount > 0 && <button type="button" className="cat-link" onClick={() => { setFilters({ ...DEFAULT_CATALOG_FILTERS, query: filters.query, sort: filters.sort }); setVisible(PAGE_SIZE); }}><RotateCcw size={14} /> Reset filters</button>}
    </div>}

    {error && <div className="disc-alert error" role="alert">{error} <button className="disc-text-button" onClick={() => { setError(''); void load(); }}>Retry</button></div>}
    {notice && <p className="disc-alert success" role="status">{notice}</p>}
    {building && <p className="cat-status" role="status"><Loader2 size={16} className="spinner" /> <span><strong>Building the catalog.</strong> {status?.phase || 'Working'}… Games appear here as they are confirmed; this page updates on its own.</span></p>}
    {!building && status?.error && <p className="disc-alert" role="status">{status.error}</p>}

    {lastHidden && <div className="cat-undo" role="status"><span><strong>{lastHidden.name}</strong> is hidden.</span><button type="button" onClick={() => void setHidden(lastHidden, false)}><Undo2 size={15} /> Undo</button><button type="button" onClick={() => setLastHidden(null)} aria-label="Dismiss"><X size={15} /></button></div>}

    {loading ? <p className="disc-empty"><Loader2 className="spinner" size={26} /> Loading the catalog…</p> : empty ? <div className="disc-empty">
      <Gamepad2 size={36} />
      <h3>{building ? 'The catalog is being built for the first time' : 'The catalog is empty'}</h3>
      <small>{building ? 'The first build reads every physical release and takes a while. You can leave this page; it continues on the server.' : 'Start a refresh to read every physical Switch and Switch 2 release.'}</small>
      {!building && <button className="btn btn-primary" onClick={() => void refresh()}><RefreshCw size={16} /> Build the catalog</button>}
    </div> : <>
      <p className="cat-count" aria-live="polite"><strong>{results.length.toLocaleString()}</strong> {results.length === 1 ? 'game' : 'games'}{filters.query.trim() ? <> matching “{filters.query.trim()}”</> : null}{!filters.showOwned && ownedCount > 0 ? <> · {ownedCount} owned not shown</> : null}</p>
      {results.length === 0 ? <div className="disc-empty">
        <Search size={32} />
        <h3>No games match</h3>
        <small>{!filters.showOwned && ownedCount > 0 ? 'Games you already own are not shown. Turn on “Also show games I own”, or loosen the filters.' : 'Try fewer words or reset the filters.'}</small>
      </div> : <div className="cat-grid">{shown.map(game => <article className={`cat-card ${game.owned ? 'owned' : ''}`} key={game.id}>
        <Cover game={game} />
        <div className="cat-body">
          <div className="cat-badges">
            <span className={`cat-badge ${game.platform === 'Nintendo Switch 2' ? 'switch2' : 'switch'}`}>{platformLabel(game.platform)}</span>
            {game.format === 'Game-Key Card' && <span className="cat-badge keycard">Game-Key Card</span>}
            {game.owned && <span className="cat-badge owned" title={game.owned_platforms.length ? `In your collection on ${game.owned_platforms.join(', ')}` : 'In your collection'}><Check size={11} /> Owned</span>}
          </div>
          <h3 title={game.name}>{game.name}</h3>
          <p className="cat-meta">{releaseText(game)}{game.publisher ? ` · ${game.publisher}` : ''}</p>
          <div className="cat-actions">
            <button type="button" className="cat-action primary" disabled={game.saved} onClick={() => save(game)}>{game.saved ? <><Check size={14} /> Wanted</> : <><Heart size={14} /> Want</>}</button>
            <button type="button" className="cat-action" onClick={() => void setHidden(game, true)} title="Hide this game until you restore it from Hidden games"><EyeOff size={14} /> Don’t show</button>
            <a className="cat-action icon" href={game.source_url} target="_blank" rel="noreferrer" aria-label={`${game.name} on ${game.source}`} title={`Open on ${game.source}`}><ArrowUpRight size={15} /></a>
          </div>
        </div>
      </article>)}</div>}
      {shown.length < results.length && <div ref={sentinel} className="cat-more"><button type="button" className="btn btn-secondary" onClick={() => setVisible(count => count + PAGE_SIZE)}>Show more ({(results.length - shown.length).toLocaleString()} left)</button></div>}
      <p className="disc-source-note">Retail releases from Nintendo Life’s games database and Nintendo Europe’s catalog. Game-Key Cards are included and labelled; code-in-box products are left out. Limited-print and region-exclusive releases can be missing.{status?.listing_at ? ` Last refreshed: ${timestamp(status.listing_at)}.` : ''} {!building && <button type="button" className="disc-text-button" onClick={() => void refresh()}><RefreshCw size={12} /> Refresh now</button>}</p>
    </>}

    {hiddenOpen && <div className="disc-confirm-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setHiddenOpen(false); }}>
      <div className="disc-confirm-dialog disc-review-dialog cat-hidden-dialog" role="dialog" aria-modal="true" aria-labelledby="cat-hidden-title">
        <button className="disc-confirm-close" onClick={() => setHiddenOpen(false)} aria-label="Close"><X size={18} /></button>
        <div className="disc-review-dialog-heading"><div><h2 id="cat-hidden-title">Hidden games</h2><p>Games you marked “Don’t show”. They stay out of the catalog until you restore them here.</p></div></div>
        {hiddenGames.length > 8 && <label className="cat-search compact"><Search size={16} aria-hidden /><input type="search" value={hiddenQuery} onChange={event => setHiddenQuery(event.target.value)} placeholder="Search hidden games…" aria-label="Search hidden games" /></label>}
        <div className="disc-review-dialog-list">
          {hiddenGames.length === 0 ? <p className="disc-review-empty">Nothing is hidden. Use “Don’t show” on a game to move it here.</p>
            : hiddenMatches.length === 0 ? <p className="disc-review-empty">No hidden game matches that search.</p>
            : hiddenMatches.map(game => <div className="cat-hidden-row" key={game.id}>
              <Cover game={game} />
              <div><strong>{game.name}</strong><small>{platformLabel(game.platform)}{game.format === 'Game-Key Card' ? ' · Game-Key Card' : ''} · {releaseText(game)}</small></div>
              <button type="button" className="btn btn-secondary" onClick={() => void setHidden(game, false)}><Undo2 size={15} /> Restore</button>
            </div>)}
        </div>
        <div className="disc-actions">
          {hiddenGames.length > 1 && <button type="button" className="btn btn-secondary" onClick={() => void restoreAll()}>Restore all {hiddenGames.length}</button>}
          <button type="button" className="btn btn-primary" onClick={() => setHiddenOpen(false)}>Done</button>
        </div>
      </div>
    </div>}

    {editing && <WantedGameEditor initial={editing.draft} title="Save to Games I want" onClose={() => setEditing(null)} onSave={async draft => {
      await discoveryApi('/games', { method: 'POST', body: JSON.stringify(draft) });
      const saved = editing.game;
      setGames(current => current.map(row => row.id === saved.id ? { ...row, saved: true } : row));
      setNotice(`${draft.name} saved to Games I want.`);
    }} />}
  </section>;
}
