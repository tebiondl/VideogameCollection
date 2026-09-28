import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ArrowRight, GripVertical, Layers3, Loader2, Plus, RotateCcw, Search, Trash2, Trophy, X } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import { tagNames } from '../lib/videogameStats';
import { BUCKETS, EMPTY_TIER_FILTERS, gamePlatforms, matchesTierFilters, moveRankedGame, moveRankedGameToPosition, tierBuckets, TIERS, type RankDropSide, type RankingGame, type TierFilters, type TierList } from '../lib/ranking';
import './RankingPage.css';

const STATUSES = ['Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'];

async function rankingApi<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetchWithAuth(`/ranking${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(typeof data?.detail === 'string' ? data.detail : 'Could not save your changes. Please try again.');
  }
  return response.status === 204 ? undefined as T : response.json();
}

function FilterEditor({ value, onChange, tags, platforms }: { value: TierFilters; onChange: (next: TierFilters) => void; tags: string[]; platforms: string[] }) {
  const toggle = (key: 'statuses' | 'tags' | 'platforms', item: string) => onChange({ ...value, [key]: value[key].includes(item) ? value[key].filter(row => row !== item) : [...value[key], item] });
  const range = (key: 'min_rating' | 'max_rating' | 'min_year' | 'max_year', raw: string) => onChange({ ...value, [key]: raw === '' ? null : Number(raw) });
  return <div className="vg-rank-filters">
    <div><label className="form-label">Status</label><div className="vg-rank-chips">{STATUSES.map(status => <button type="button" key={status} className={value.statuses.includes(status) ? 'selected' : ''} onClick={() => toggle('statuses', status)}>{status}</button>)}</div></div>
    <div className="vg-rank-filter-grid">
      <label>Minimum rating<select value={value.min_rating ?? ''} onChange={event => range('min_rating', event.target.value)}><option value="">Any</option>{Array.from({ length: 10 }, (_, i) => i + 1).map(score => <option key={score} value={score}>{score}/10</option>)}</select></label>
      <label>Maximum rating<select value={value.max_rating ?? ''} onChange={event => range('max_rating', event.target.value)}><option value="">Any</option>{Array.from({ length: 10 }, (_, i) => i + 1).map(score => <option key={score} value={score}>{score}/10</option>)}</select></label>
      <label>Release year from<input type="number" min="1950" max="2100" value={value.min_year ?? ''} onChange={event => range('min_year', event.target.value)} placeholder="Any" /></label>
      <label>Release year to<input type="number" min="1950" max="2100" value={value.max_year ?? ''} onChange={event => range('max_year', event.target.value)} placeholder="Any" /></label>
    </div>
    <div className="vg-rank-filter-grid">
      <label>Tags<select value="" onChange={event => event.target.value && toggle('tags', event.target.value)}><option value="">Add a tag…</option>{tags.filter(tag => !value.tags.includes(tag)).map(tag => <option key={tag}>{tag}</option>)}</select></label>
      <label>Platforms<select value="" onChange={event => event.target.value && toggle('platforms', event.target.value)}><option value="">Add a platform…</option>{platforms.filter(platform => !value.platforms.includes(platform)).map(platform => <option key={platform}>{platform}</option>)}</select></label>
    </div>
    {(value.tags.length > 0 || value.platforms.length > 0) && <div className="vg-rank-chips">{value.tags.map(tag => <button type="button" className="selected" key={`tag-${tag}`} onClick={() => toggle('tags', tag)}>{tag} ×</button>)}{value.platforms.map(platform => <button type="button" className="selected" key={`platform-${platform}`} onClick={() => toggle('platforms', platform)}>{platform} ×</button>)}</div>}
    <div className="vg-rank-checks"><label><input type="checkbox" checked={value.rated_only} onChange={event => onChange({ ...value, rated_only: event.target.checked })} /> Only rated games</label><label><input type="checkbox" checked={value.include_dlc} onChange={event => onChange({ ...value, include_dlc: event.target.checked })} /> Include standalone DLC games</label></div>
  </div>;
}

function GameCover({ game }: { game?: RankingGame }) {
  return game?.image_url ? <img src={game.image_url} alt="" loading="lazy" /> : <span className="vg-rank-cover-fallback">🎮</span>;
}

function RankingCard({ game, position, total, canStepUp, canStepDown, isNew, busy, dragged, dropSide, dropRank, onDragStart, onDragOver, onDragEnd, onRating, onStep, onJump }: {
  game: RankingGame;
  position: number;
  total: number;
  canStepUp: boolean;
  canStepDown: boolean;
  isNew: boolean;
  busy: boolean;
  dragged: boolean;
  dropSide: RankDropSide | null;
  dropRank: number | null;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onRating: (score: number) => void;
  onStep: (direction: -1 | 1) => void;
  onJump: (position: number) => void;
}) {
  const [jumpPosition, setJumpPosition] = useState('');
  const jump = Number(jumpPosition);
  const canJump = Number.isInteger(jump) && jump >= 1 && jump <= total && jump !== position;
  return <article className="glass-card vg-rank-row" data-rank-id={game.id} data-dragged={dragged} draggable={!busy} onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd}>
    <div className="vg-rank-card-heading"><span className="vg-rank-grip" title="Drag to change position"><GripVertical size={18} /></span><strong className="vg-rank-position">#{position}</strong>{isNew && <span className="vg-rank-new" title="Added by rating. Move this game to clear the mark.">New to ranking</span>}</div>
    <div className="vg-rank-card-game"><div className="vg-rank-cover"><GameCover game={game} /></div><div className="vg-rank-row-info"><strong title={game.name}>{game.name}</strong><small>{game.status || 'No status'}{game.publication_year ? ` · ${game.publication_year}` : ''}</small></div></div>
    <div className="vg-rank-card-controls"><label className="vg-rank-rating">Rating<select aria-label={`Rating for ${game.name}`} value={game.mark ?? ''} disabled={busy} onChange={event => onRating(Number(event.target.value))}>{Array.from({ length: 10 }, (_, i) => i + 1).map(score => <option key={score} value={score}>{score}/10</option>)}</select></label><div className="vg-rank-move"><button type="button" aria-label={`Move ${game.name} earlier`} disabled={busy || !canStepUp} onClick={() => onStep(-1)}><ArrowLeft size={17} /></button><button type="button" aria-label={`Move ${game.name} later`} disabled={busy || !canStepDown} onClick={() => onStep(1)}><ArrowRight size={17} /></button></div></div>
    <form className="vg-rank-jump" onSubmit={event => { event.preventDefault(); if (canJump && !busy) { onJump(jump); setJumpPosition(''); } }}><label htmlFor={`rank-jump-${game.id}`}>Move to rank</label><input id={`rank-jump-${game.id}`} aria-label={`Move ${game.name} to rank`} type="number" min="1" max={total} value={jumpPosition} onChange={event => setJumpPosition(event.target.value)} placeholder={`1–${total}`} disabled={busy} /><button type="submit" disabled={busy || !canJump}>Move</button></form>
    {dropSide && dropRank != null && <div className={`vg-rank-drop-preview ${dropSide}`} aria-hidden="true"><span>Drop at #{dropRank}</span></div>}
  </article>;
}

export function RankingPage() {
  const [tab, setTab] = useState<'ranking' | 'tiers'>('ranking');
  const [games, setGames] = useState<RankingGame[]>([]);
  const [orderedIds, setOrderedIds] = useState<number[]>([]);
  const [newRankIds, setNewRankIds] = useState<number[]>([]);
  const [tierLists, setTierLists] = useState<TierList[]>([]);
  const [selectedListId, setSelectedListId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');
  const [rankStatus, setRankStatus] = useState('');
  const [rankTag, setRankTag] = useState('');
  const [rankPlatform, setRankPlatform] = useState('');
  const [rankMinRating, setRankMinRating] = useState('');
  const [gamesPerRow, setGamesPerRow] = useState(4);
  const [layoutSaving, setLayoutSaving] = useState(false);
  const [rankSaveState, setRankSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [creating, setCreating] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createFilters, setCreateFilters] = useState<TierFilters>(EMPTY_TIER_FILTERS);
  const [nameDraft, setNameDraft] = useState('');
  const [filterDraft, setFilterDraft] = useState<TierFilters>(EMPTY_TIER_FILTERS);
  const [nameDirty, setNameDirty] = useState(false);
  const [filtersDirty, setFiltersDirty] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [draggedId, setDraggedId] = useState<number | null>(null);
  const draggedIdRef = useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ gameId: number; side: RankDropSide } | null>(null);
  const dragPointer = useRef(0);
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  const enqueue = <T,>(work: () => Promise<T>): Promise<T> => {
    const task = queue.current.then(work, work);
    queue.current = task.catch(() => undefined);
    return task;
  };

  useEffect(() => {
    Promise.all([
      fetchWithAuth('/videogames/').then(async response => { if (!response.ok) throw new Error('Could not load your games.'); return response.json() as Promise<RankingGame[]>; }),
      rankingApi<{ game_ids: number[]; new_game_ids: number[] }>(''),
      rankingApi<{ games_per_row: number }>('/settings'),
      rankingApi<TierList[]>('/tier-lists'),
    ]).then(([rows, order, settings, lists]) => {
      setGames(rows);
      setOrderedIds(order.game_ids);
      setNewRankIds(order.new_game_ids);
      setGamesPerRow(settings.games_per_row);
      setTierLists(lists);
      setSelectedListId(lists[0]?.id ?? null);
      setNameDraft(lists[0]?.name ?? '');
      setFilterDraft(lists[0]?.filters ?? EMPTY_TIER_FILTERS);
    }).catch(cause => setError(cause instanceof Error ? cause.message : 'Could not load Ranking.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (draggedId == null) return;
    let frame = 0;
    const scrollNearEdge = () => {
      const y = dragPointer.current;
      const edge = 100;
      const speed = y < edge ? -Math.ceil((edge - y) / 8) : y > window.innerHeight - edge ? Math.ceil((y - window.innerHeight + edge) / 8) : 0;
      if (speed && y > 0 && y < window.innerHeight) window.scrollBy(0, speed);
      frame = window.requestAnimationFrame(scrollNearEdge);
    };
    frame = window.requestAnimationFrame(scrollNearEdge);
    return () => window.cancelAnimationFrame(frame);
  }, [draggedId]);

  const byId = useMemo(() => new Map(games.map(game => [game.id, game])), [games]);
  const tagOptions = useMemo(() => [...new Set(games.flatMap(game => tagNames(game.tags)))].sort(), [games]);
  const platformOptions = useMemo(() => [...new Set(games.flatMap(gamePlatforms))].sort(), [games]);
  const selectedList = tierLists.find(list => list.id === selectedListId) || null;
  const selectedId = selectedList?.id;

  const replaceList = (updated: TierList) => setTierLists(current => current.map(list => list.id === updated.id ? updated : list));
  const report = (cause: unknown) => { setError(cause instanceof Error ? cause.message : 'Could not save the change.'); setNotice(''); };
  const flushDrafts = () => {
    if (!selectedId) return;
    if (nameDirty && nameDraft.trim()) {
      void enqueue(() => rankingApi<TierList>(`/tier-lists/${selectedId}`, 'PATCH', { name: nameDraft.trim() }))
        .then(replaceList).catch(report);
    }
    if (filtersDirty) {
      void enqueue(() => rankingApi<TierList>(`/tier-lists/${selectedId}`, 'PATCH', { filters: filterDraft }))
        .then(replaceList).catch(report);
    }
    setNameDirty(false);
    setFiltersDirty(false);
  };
  const selectTierList = (list: TierList) => {
    if (selectedId !== list.id) {
      flushDrafts();
      setSelectedListId(list.id);
      setNameDraft(list.name);
      setFilterDraft(list.filters);
      setShowDeleted(false);
      setAddSearch('');
    }
    setCreating(false);
  };
  useEffect(() => {
    if (!selectedId || !nameDirty || !nameDraft.trim()) return;
    const timer = setTimeout(() => {
      enqueue(() => rankingApi<TierList>(`/tier-lists/${selectedId}`, 'PATCH', { name: nameDraft.trim() }))
        .then(replaceList).catch(report);
      setNameDirty(false);
    }, 450);
    return () => clearTimeout(timer);
  }, [selectedId, nameDraft, nameDirty]);
  useEffect(() => {
    if (!selectedId || !filtersDirty) return;
    const timer = setTimeout(() => {
      enqueue(() => rankingApi<TierList>(`/tier-lists/${selectedId}`, 'PATCH', { filters: filterDraft }))
        .then(replaceList).catch(report);
      setFiltersDirty(false);
    }, 450);
    return () => clearTimeout(timer);
  }, [selectedId, filterDraft, filtersDirty]);

  const rankedGames = orderedIds.map(id => byId.get(id)).filter((game): game is RankingGame => !!game && !game.hidden && !game.merged_into_game_id && game.mark != null);
  const visibleRanked = rankedGames.filter(game => game.name.toLowerCase().includes(search.trim().toLowerCase()) && (!rankStatus || game.status === rankStatus) && (!rankTag || tagNames(game.tags).includes(rankTag)) && (!rankPlatform || gamePlatforms(game).includes(rankPlatform)) && (!rankMinRating || game.mark! >= Number(rankMinRating)));
  const rankGridStyle = { '--rank-columns': gamesPerRow, '--rank-columns-tablet': Math.min(gamesPerRow, 3), '--rank-columns-small': Math.min(gamesPerRow, 2) } as CSSProperties;

  const persistRankOrder = async (next: number[], movedGameId: number) => {
    if (next === orderedIds || next.every((id, index) => id === orderedIds[index])) return;
    const previous = orderedIds;
    setOrderedIds(next);
    setBusy(true); setError('');
    setRankSaveState('saving');
    try { const result = await rankingApi<{ game_ids: number[]; new_game_ids: number[] }>('/order', 'PUT', { game_ids: next, moved_game_id: movedGameId }); setOrderedIds(result.game_ids); setNewRankIds(result.new_game_ids); setRankSaveState('saved'); }
    catch (cause) { setOrderedIds(previous); setRankSaveState('idle'); report(cause); }
    finally { setBusy(false); }
  };
  const saveColumns = async (columns: number) => {
    const previous = gamesPerRow;
    setGamesPerRow(columns); setLayoutSaving(true); setError('');
    try { await rankingApi<{ games_per_row: number }>('/settings', 'PUT', { games_per_row: columns }); }
    catch (cause) { setGamesPerRow(previous); report(cause); }
    finally { setLayoutSaving(false); }
  };
  const handleRankDragOver = (event: DragEvent<HTMLElement>, targetId: number) => {
    const sourceId = draggedIdRef.current;
    if (sourceId == null || busy) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    dragPointer.current = event.clientY;
    if (sourceId === targetId) { setDropTarget(null); return; }
    const bounds = event.currentTarget.getBoundingClientRect();
    const side: RankDropSide = event.clientX < bounds.left + bounds.width / 2 ? 'before' : 'after';
    const next = moveRankedGame(orderedIds, sourceId, targetId, side);
    if (next.every((id, index) => id === orderedIds[index])) { setDropTarget(null); return; }
    setDropTarget(current => current?.gameId === targetId && current.side === side ? current : { gameId: targetId, side });
  };
  const finishRankDrag = () => { draggedIdRef.current = null; setDraggedId(null); setDropTarget(null); dragPointer.current = 0; };
  const dropRank = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const sourceId = draggedIdRef.current;
    const hoveredCard = (event.target as HTMLElement).closest<HTMLElement>('[data-rank-id]');
    const targetId = hoveredCard ? Number(hoveredCard.dataset.rankId) : dropTarget?.gameId;
    const side: RankDropSide = hoveredCard ? (event.clientX < hoveredCard.getBoundingClientRect().left + hoveredCard.getBoundingClientRect().width / 2 ? 'before' : 'after') : dropTarget?.side || 'before';
    if (sourceId != null && targetId != null && !busy) void persistRankOrder(moveRankedGame(orderedIds, sourceId, targetId, side), sourceId);
    finishRankDrag();
  };
  const stepRank = (gameId: number, direction: -1 | 1) => {
    const index = visibleRanked.findIndex(game => game.id === gameId);
    const target = visibleRanked[index + direction];
    if (target && !busy) {
      const next = [...orderedIds];
      const from = next.indexOf(gameId);
      const to = next.indexOf(target.id);
      [next[from], next[to]] = [next[to], next[from]];
      void persistRankOrder(next, gameId);
    }
  };
  const jumpRank = (gameId: number, position: number) => {
    if (!busy) void persistRankOrder(moveRankedGameToPosition(orderedIds, gameId, position), gameId);
  };
  const changeRating = async (gameId: number, mark: number) => {
    setBusy(true); setError('');
    try {
      const result = await rankingApi<{ mark: number; version: number }>(`/games/${gameId}/rating`, 'PATCH', { mark });
      setGames(current => current.map(game => game.id === gameId ? { ...game, mark: result.mark, version: result.version } : game));
      const order = await rankingApi<{ game_ids: number[]; new_game_ids: number[] }>('');
      setOrderedIds(order.game_ids); setNewRankIds(order.new_game_ids);
      setNotice('Rating saved.');
    } catch (cause) { report(cause); }
    finally { setBusy(false); }
  };

  const createTierList = async () => {
    if (!createName.trim()) return;
    setBusy(true); setError('');
    try {
      const created = await rankingApi<TierList>('/tier-lists', 'POST', { name: createName.trim(), filters: createFilters });
      setTierLists(current => [created, ...current]); setSelectedListId(created.id); setNameDraft(created.name); setFilterDraft(created.filters); setNameDirty(false); setFiltersDirty(false); setCreating(false); setTab('tiers');
      setNotice(`Created “${created.name}” with ${created.entries.length} available games.`);
    } catch (cause) { report(cause); }
    finally { setBusy(false); }
  };
  const refreshPool = async () => {
    if (!selectedList) return;
    setBusy(true); setError('');
    try {
      const result = await enqueue(async () => {
        await rankingApi<TierList>(`/tier-lists/${selectedList.id}`, 'PATCH', { filters: filterDraft });
        return rankingApi<{ added: number; tier_list: TierList }>(`/tier-lists/${selectedList.id}/refresh`, 'POST');
      });
      replaceList(result.tier_list); setFiltersDirty(false);
      setNotice(result.added ? `Added ${result.added} newly matching ${result.added === 1 ? 'game' : 'games'}.` : 'No new matching games found. Removed games stayed removed.');
    } catch (cause) { report(cause); }
    finally { setBusy(false); }
  };
  const changeMembership = async (gameId: number, action: 'add' | 'remove' | 'restore') => {
    if (!selectedList || busy) return;
    setBusy(true); setError('');
    const path = `/tier-lists/${selectedList.id}/games/${gameId}`;
    try {
      const updated = await rankingApi<TierList>(action === 'restore' ? `${path}/restore` : path, action === 'remove' ? 'DELETE' : 'POST');
      replaceList(updated); setNotice(action === 'remove' ? 'Game removed from this tier list.' : 'Tier list saved.');
    } catch (cause) { report(cause); }
    finally { setBusy(false); }
  };
  const saveTierOrder = async (gameId: number, tier: string, beforeId?: number) => {
    if (!selectedList || busy || gameId === beforeId) return;
    const buckets = tierBuckets(selectedList.entries);
    for (const key of BUCKETS) buckets[key] = buckets[key].filter(id => id !== gameId);
    const target = buckets[tier];
    if (!target) return;
    const position = beforeId == null ? target.length : Math.max(0, target.indexOf(beforeId));
    target.splice(position, 0, gameId);
    setBusy(true); setError('');
    try { replaceList(await rankingApi<TierList>(`/tier-lists/${selectedList.id}/order`, 'PUT', { buckets })); setNotice('Tier list saved.'); }
    catch (cause) { report(cause); }
    finally { setBusy(false); setDraggedId(null); }
  };
  const stepTier = (gameId: number, tier: string, direction: -1 | 1) => {
    if (!selectedList) return;
    const ids = tierBuckets(selectedList.entries)[tier];
    const index = ids.indexOf(gameId);
    const next = ids[index + direction];
    if (next != null) void saveTierOrder(gameId, tier, direction < 0 ? next : ids[index + 2]);
  };
  const deleteTierList = async () => {
    if (!selectedList || !window.confirm(`Delete the tier list “${selectedList.name}”? This cannot be undone.`)) return;
    setBusy(true); setError('');
    try { await rankingApi<void>(`/tier-lists/${selectedList.id}`, 'DELETE'); const remaining = tierLists.filter(list => list.id !== selectedList.id); setTierLists(remaining); setSelectedListId(remaining[0]?.id ?? null); setNameDraft(remaining[0]?.name ?? ''); setFilterDraft(remaining[0]?.filters ?? EMPTY_TIER_FILTERS); setNameDirty(false); setFiltersDirty(false); setNotice('Tier list deleted.'); }
    catch (cause) { report(cause); }
    finally { setBusy(false); }
  };

  const buckets = selectedList ? tierBuckets(selectedList.entries) : null;
  const deletedEntries = selectedList?.entries.filter(entry => entry.deleted) || [];
  const knownIds = new Set(selectedList?.entries.map(entry => entry.game_id) || []);
  const addableGames = games.filter(game => !game.hidden && !game.merged_into_game_id && !knownIds.has(game.id) && game.name.toLowerCase().includes(addSearch.trim().toLowerCase())).sort((a, b) => a.name.localeCompare(b.name));
  const previewCount = games.filter(game => matchesTierFilters(game, creating ? createFilters : filterDraft)).length;

  return <div className="container vg-support-page vg-rank-page">
    <Link to="/dashboard/videogames" className="vg-back-link"><ArrowLeft size={18} /> Back to Videogames</Link>
    <VideogamePageHeader eyebrow="Your favorites" icon={<Trophy />} title="Ranking" description="Keep a personal order of your rated games and build saved tier lists." />
    <div className="vg-rank-tabs" role="tablist" aria-label="Ranking views"><button role="tab" aria-selected={tab === 'ranking'} className={tab === 'ranking' ? 'selected' : ''} onClick={() => { flushDrafts(); setTab('ranking'); }}><Trophy size={18} /> Game ranking</button><button role="tab" aria-selected={tab === 'tiers'} className={tab === 'tiers' ? 'selected' : ''} onClick={() => setTab('tiers')}><Layers3 size={18} /> Tier lists</button></div>
    {error && <div className="vg-rank-alert error" role="alert">{error}<button type="button" onClick={() => setError('')} aria-label="Dismiss error"><X size={16} /></button></div>}
    {notice && !error && <div className="vg-rank-alert" role="status">{notice}<button type="button" onClick={() => setNotice('')} aria-label="Dismiss message"><X size={16} /></button></div>}
    {loading ? <div className="vg-rank-loading"><Loader2 className="spinner" size={30} /></div> : tab === 'ranking' ? <>
      <div className="vg-rank-intro glass-card"><strong>{rankedGames.length} rated games</strong><p>Drag a card to either side of another card. The colored box shows its new rank. For distant moves, enter a rank on the card. Your order saves automatically.</p></div>
      <div className="vg-rank-toolbar glass-card"><label className="vg-rank-search"><Search size={18} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search rated games…" aria-label="Search rated games" /></label><select aria-label="Filter ranking by status" value={rankStatus} onChange={event => setRankStatus(event.target.value)}><option value="">All statuses</option>{STATUSES.map(status => <option key={status}>{status}</option>)}</select><select aria-label="Filter ranking by platform" value={rankPlatform} onChange={event => setRankPlatform(event.target.value)}><option value="">All platforms</option>{platformOptions.map(platform => <option key={platform}>{platform}</option>)}</select><select aria-label="Filter ranking by tag" value={rankTag} onChange={event => setRankTag(event.target.value)}><option value="">All tags</option>{tagOptions.map(tag => <option key={tag}>{tag}</option>)}</select><select aria-label="Minimum ranking rating" value={rankMinRating} onChange={event => setRankMinRating(event.target.value)}><option value="">Any rating</option>{Array.from({ length: 10 }, (_, i) => i + 1).map(score => <option key={score} value={score}>{score}+ / 10</option>)}</select></div>
      <div className="vg-rank-results"><span>Showing {visibleRanked.length} of {rankedGames.length}{visibleRanked.length !== rankedGames.length ? ' · Ranks refer to the full list' : ''}</span><div><span role="status" className="vg-rank-save-state">{rankSaveState === 'saving' ? 'Saving order…' : rankSaveState === 'saved' ? 'Order saved' : ''}</span><label className="vg-rank-columns">Games per row <select aria-label="Games per row" value={gamesPerRow} disabled={layoutSaving} onChange={event => void saveColumns(Number(event.target.value))}>{[2, 3, 4, 5, 6].map(count => <option key={count} value={count}>{count}</option>)}</select></label></div></div>
      <div className="vg-rank-list" style={rankGridStyle} onDragOver={event => { if (draggedIdRef.current != null) { event.preventDefault(); dragPointer.current = event.clientY; } }} onDrop={dropRank} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) dragPointer.current = 0; }}>
        {visibleRanked.map((game, index) => <RankingCard key={game.id} game={game} position={orderedIds.indexOf(game.id) + 1} total={rankedGames.length} canStepUp={index > 0} canStepDown={index < visibleRanked.length - 1} isNew={newRankIds.includes(game.id)} busy={busy} dragged={draggedId === game.id} dropSide={dropTarget?.gameId === game.id ? dropTarget.side : null} dropRank={dropTarget?.gameId === game.id && draggedId != null ? moveRankedGame(orderedIds, draggedId, game.id, dropTarget.side).indexOf(draggedId) + 1 : null} onDragStart={event => { if ((event.target as HTMLElement).closest('button, input, select')) { event.preventDefault(); return; } event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(game.id)); draggedIdRef.current = game.id; setDraggedId(game.id); setDropTarget(null); }} onDragOver={event => handleRankDragOver(event, game.id)} onDragEnd={finishRankDrag} onRating={score => void changeRating(game.id, score)} onStep={direction => stepRank(game.id, direction)} onJump={position => jumpRank(game.id, position)} />)}
        {!visibleRanked.length && <div className="glass-card vg-rank-empty">{rankedGames.length ? 'No rated games match these filters.' : 'Rate a game in your collection to start your ranking.'}</div>}
      </div>
    </> : <div className="vg-tier-layout">
      <aside className="glass-card vg-tier-sidebar"><div><h2>Your tier lists</h2><button type="button" className="btn btn-primary" onClick={() => { flushDrafts(); setCreating(true); setCreateName(''); setCreateFilters(EMPTY_TIER_FILTERS); }}><Plus size={17} /> New list</button></div>{tierLists.map(list => <button type="button" key={list.id} className={selectedListId === list.id && !creating ? 'selected' : ''} onClick={() => selectTierList(list)}><strong>{list.name}</strong><small>{list.entries.filter(entry => !entry.deleted).length} available games</small></button>)}{!tierLists.length && <p className="text-muted">Create your first list to start placing games in tiers.</p>}</aside>
      <div className="vg-tier-main">{creating ? <section className="glass-card vg-tier-setup"><h2>Create a tier list</h2><p>Choose filters, then create a fixed pool of matching games. New games only join when you use Update available games.</p><label className="vg-tier-name">List name<input value={createName} maxLength={100} onChange={event => setCreateName(event.target.value)} placeholder="My favorite RPGs" /></label><FilterEditor value={createFilters} onChange={setCreateFilters} tags={tagOptions} platforms={platformOptions} /><p className="vg-tier-preview">{previewCount} games currently match these filters.</p><div className="vg-tier-actions"><button type="button" className="btn btn-primary" disabled={busy || !createName.trim()} onClick={() => void createTierList()}>{busy ? 'Creating…' : 'Create tier list'}</button><button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>Cancel</button></div></section> : selectedList && buckets ? <>
        <section className="glass-card vg-tier-header"><div><span className="vg-tier-kicker">SAVED TIER LIST</span><input className="vg-tier-title-input" aria-label="Tier list name" value={nameDraft} maxLength={100} onChange={event => { setNameDraft(event.target.value); setNameDirty(true); }} onBlur={flushDrafts} /><p>{selectedList.entries.filter(entry => !entry.deleted).length} available · {deletedEntries.length} removed. Names, filters and placements save automatically.</p></div><div className="vg-tier-header-actions"><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void refreshPool()}><RotateCcw size={16} /> Update available games</button><button type="button" className="btn btn-secondary" onClick={() => setShowDeleted(current => !current)}><Trash2 size={16} /> Removed ({deletedEntries.length})</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void deleteTierList()} aria-label="Delete tier list"><Trash2 size={17} /></button></div></section>
        <section className="glass-card vg-tier-filter-panel" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) flushDrafts(); }}><button type="button" className="vg-tier-filter-toggle" onClick={() => setShowFilters(current => !current)}><span>Game filters <small>Changing these does not change the pool until you update available games.</small></span><span>{showFilters ? 'Hide' : 'Edit'}</span></button>{showFilters && <><FilterEditor value={filterDraft} onChange={next => { setFilterDraft(next); setFiltersDirty(true); }} tags={tagOptions} platforms={platformOptions} /><p className="vg-tier-preview">{previewCount} games currently match. Update available games to add new matches; removed games stay removed.</p></>}</section>
        {showDeleted && <section className="glass-card vg-tier-removed"><h2>Removed games</h2><p>These are excluded from automatic updates. Restore one whenever you want it back.</p>{deletedEntries.map(entry => <div key={entry.game_id}><span>{byId.get(entry.game_id)?.name || `Game #${entry.game_id}`}</span><button type="button" className="btn btn-secondary" disabled={busy || !byId.has(entry.game_id)} onClick={() => void changeMembership(entry.game_id, 'restore')}>Restore</button></div>)}{!deletedEntries.length && <p className="text-muted">No games removed from this list.</p>}</section>}
        <div className="vg-tier-board">{TIERS.map(tier => <section className="vg-tier-row glass-card" key={tier} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const id = Number(event.dataTransfer.getData('text/plain')); if (id) void saveTierOrder(id, tier); }}><div className={`vg-tier-label tier-${tier}`}>{tier}</div><div className="vg-tier-cards">{buckets[tier].map((id, index) => <article className="vg-tier-card" key={id} draggable={!busy} onDragStart={event => { event.dataTransfer.setData('text/plain', String(id)); setDraggedId(id); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.stopPropagation(); event.preventDefault(); const dragged = Number(event.dataTransfer.getData('text/plain')); if (dragged) void saveTierOrder(dragged, tier, id); }} onDragEnd={() => setDraggedId(null)} data-dragged={draggedId === id}><div className="vg-tier-card-cover"><GameCover game={byId.get(id)} /></div><strong>{byId.get(id)?.name || `Game #${id}`}</strong><small>{byId.get(id)?.mark ? `${byId.get(id)?.mark}/10` : 'Unrated'}</small><div className="vg-tier-card-actions"><select aria-label={`Tier for ${byId.get(id)?.name || id}`} value={tier} disabled={busy} onChange={event => void saveTierOrder(id, event.target.value)}>{BUCKETS.map(option => <option key={option} value={option}>{option === 'unranked' ? 'Unranked' : option}</option>)}</select><button type="button" disabled={busy || index === 0} aria-label={`Move ${byId.get(id)?.name || id} left`} onClick={() => stepTier(id, tier, -1)}><ArrowLeft size={15} /></button><button type="button" disabled={busy || index === buckets[tier].length - 1} aria-label={`Move ${byId.get(id)?.name || id} right`} onClick={() => stepTier(id, tier, 1)}><ArrowRight size={15} /></button><button type="button" disabled={busy} aria-label={`Remove ${byId.get(id)?.name || id} from tier list`} onClick={() => void changeMembership(id, 'remove')}><X size={15} /></button></div></article>)}{!buckets[tier].length && <p>Drop games here</p>}</div></section>)}</div>
        <section className="glass-card vg-tier-pool" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); const id = Number(event.dataTransfer.getData('text/plain')); if (id) void saveTierOrder(id, 'unranked'); }}><div><h2>Available to tier <span>{buckets.unranked.length}</span></h2><p>Drag a game into a tier, or choose a tier from its dropdown. Drop a tiered game here to return it to the pool.</p></div><div className="vg-tier-pool-grid">{buckets.unranked.map(id => <article className="vg-tier-card" key={id} draggable={!busy} onDragStart={event => { event.dataTransfer.setData('text/plain', String(id)); setDraggedId(id); }} onDragOver={event => event.preventDefault()} onDrop={event => { event.stopPropagation(); event.preventDefault(); const dragged = Number(event.dataTransfer.getData('text/plain')); if (dragged) void saveTierOrder(dragged, 'unranked', id); }} onDragEnd={() => setDraggedId(null)}><div className="vg-tier-card-cover"><GameCover game={byId.get(id)} /></div><strong>{byId.get(id)?.name || `Game #${id}`}</strong><small>{byId.get(id)?.mark ? `${byId.get(id)?.mark}/10` : 'Unrated'}</small><div className="vg-tier-card-actions"><select aria-label={`Tier for ${byId.get(id)?.name || id}`} value="unranked" disabled={busy} onChange={event => void saveTierOrder(id, event.target.value)}><option value="unranked">Unranked</option>{TIERS.map(option => <option key={option}>{option}</option>)}</select><button type="button" disabled={busy} aria-label={`Remove ${byId.get(id)?.name || id} from tier list`} onClick={() => void changeMembership(id, 'remove')}><X size={15} /></button></div></article>)}{!buckets.unranked.length && <p className="text-muted">All available games have a tier.</p>}</div></section>
        <section className="glass-card vg-tier-add"><h2>Add a game manually</h2><p>Add any collection game, even if it does not match this list’s filters.</p><label className="vg-rank-search"><Search size={18} /><input value={addSearch} onChange={event => setAddSearch(event.target.value)} placeholder="Search games to add…" aria-label="Search games to add" /></label>{addSearch.trim() && <div className="vg-tier-add-results">{addableGames.slice(0, 15).map(game => <div key={game.id}><span>{game.name}</span><button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void changeMembership(game.id, 'add')}><Plus size={15} /> Add</button></div>)}{!addableGames.length && <p>No more games match. Removed games can be restored above.</p>}</div>}</section>
      </> : <div className="glass-card vg-rank-empty">Select a tier list or create a new one.</div>}</div>
    </div>}
  </div>;
}
