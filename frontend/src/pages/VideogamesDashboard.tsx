import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Search, Filter, LayoutGrid, List as ListIcon, Plus, Loader2, Trash2, Edit2, X, ArrowUpDown, ArrowUp, ArrowDown, Plus as PlusIcon, HelpCircle, Sparkles, Shield, BarChart3 } from 'lucide-react';
import { createPortal } from 'react-dom';
import { fetchWithAuth } from '../lib/api';
import { TagMultiSelect } from '../components/TagMultiSelect';
import { AdvancedFilterModal, DEFAULT_FILTER_STATE } from '../components/AdvancedFilterModal';
import type { FilterState, TagGroup, TagRule } from '../components/AdvancedFilterModal';
import { CompletionDatePicker } from '../components/CompletionDatePicker';
import { DlcEditor } from '../components/DlcEditor';
import { PaginationControls } from '../components/PaginationControls';
import { parseStoredPageSize, type PageSize } from '../lib/pagination';
import { useAuth } from '../context/AuthContext';
import './VideogamesDashboard.css';

type ViewMode = 'list' | 'matrix';

// ─── Sort types ────────────────────────────────────────────────────────────────
type SortField = 'mark' | 'hype' | 'completion_percentage';
type SortDir = 'asc' | 'desc';

interface SortCriterion {
  id: number;
  field: SortField;
  dir: SortDir;
}

const SORT_FIELD_LABELS: Record<SortField, string> = {
  mark: 'Rating',
  hype: 'Hype',
  completion_percentage: 'Completion %',
};

const SORT_FIELDS: SortField[] = ['mark', 'hype', 'completion_percentage'];

let _sortIdCounter = 0;
const newSortId = () => ++_sortIdCounter;

// ─── Multi-sort comparator ────────────────────────────────────────────────────
function applyMultiSort(games: any[], criteria: SortCriterion[]): any[] {
  if (criteria.length === 0) return games;
  return [...games].sort((a, b) => {
    for (const c of criteria) {
      const av = a[c.field] ?? null;
      const bv = b[c.field] ?? null;

      // Nulls always go to the end regardless of direction
      if (av === null && bv === null) continue;
      if (av === null) return 1;
      if (bv === null) return -1;

      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      if (cmp !== 0) return c.dir === 'asc' ? cmp : -cmp;
    }
    return 0;
  });
}

export function VideogamesDashboard() {
  const { user } = useAuth();
  const [viewMode, setViewMode] = useState<ViewMode>('matrix');
  const [pageSizeOptions, setPageSizeOptions] = useState([5, 10, 20, 50]);
  const [pageSize, setPageSize] = useState<PageSize>(() => parseStoredPageSize(sessionStorage.getItem('vg_page_size')));
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState(() => {
    return sessionStorage.getItem('vg_searchQuery') || '';
  });

  useEffect(() => {
    sessionStorage.setItem('vg_searchQuery', searchQuery);
  }, [searchQuery]);
  useEffect(() => {
    sessionStorage.setItem('vg_page_size', String(pageSize));
  }, [pageSize]);
  const [games, setGames] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingGame, setEditingGame] = useState<any>(null);
  const [availableTags, setAvailableTags] = useState<any[]>([]);

  // Image Selection
  const [showImageSelectModal, setShowImageSelectModal] = useState(false);
  const [igdbImages, setIgdbImages] = useState<any[]>([]);
  const [isIgdbImagesLoading, setIsIgdbImagesLoading] = useState(false);
  const [imageSearchQuery, setImageSearchQuery] = useState('');

  const fetchIGDBImages = async (query: string) => {
    if (!query) return;
    setIsIgdbImagesLoading(true);
    try {
      const res = await fetchWithAuth(`/igdb/search?q=${encodeURIComponent(query)}&limit=15`);
      if (res.ok) {
        const data = await res.json();
        setIgdbImages(data.filter((d: any) => d.cover_url));
      } else {
        setIgdbImages([]);
      }
    } catch (e) {
      setIgdbImages([]);
    } finally {
      setIsIgdbImagesLoading(false);
    }
  };

  const handleOpenImageSelect = async () => {
    if (!editingGame) return;
    setShowImageSelectModal(true);
    setImageSearchQuery(editingGame.name);
    fetchIGDBImages(editingGame.name);
  };

  // Filtering System
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filterState, setFilterState] = useState<FilterState>(() => {
    const saved = sessionStorage.getItem('vg_filterState');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) {}
    }
    return DEFAULT_FILTER_STATE;
  });

  useEffect(() => {
    sessionStorage.setItem('vg_filterState', JSON.stringify(filterState));
  }, [filterState]);
  const [savedFilters, setSavedFilters] = useState<any[]>([]);

  // Auto-Fill
  const [showAutoFillModal, setShowAutoFillModal] = useState(false);
  const [autoFillOverwrite, setAutoFillOverwrite] = useState(false);
  const [isAutoFilling, setIsAutoFilling] = useState(false);
  const [autoFillProgress, setAutoFillProgress] = useState<{ total: number, completed: number, status: string } | null>(null);

  // Check if there is an active auto-fill on mount
  useEffect(() => {
    const checkActiveAutoFill = async () => {
      try {
        const res = await fetchWithAuth('/videogames/auto-fill/status');
        if (res.ok) {
          const data = await res.json();
          if (data && data.status === 'running') {
            setAutoFillProgress(data);
            setIsAutoFilling(true);
          }
        }
      } catch (e) {}
    };
    checkActiveAutoFill();
  }, []);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;
    if (isAutoFilling) {
      interval = setInterval(async () => {
        try {
          const res = await fetchWithAuth('/videogames/auto-fill/status');
          if (res.ok) {
            const data = await res.json();
            if (data && data.status) {
              setAutoFillProgress(data);
              if (data.status === 'done' || data.status === 'error') {
                setIsAutoFilling(false);
                clearInterval(interval);
                const gamesRes = await fetchWithAuth('/videogames/');
                if (gamesRes.ok) setGames(await gamesRes.json());
                setTimeout(() => setAutoFillProgress(null), 3000);
              }
            }
          }
        } catch (e) {
          console.error('Failed to poll progress');
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [isAutoFilling]);

  // Sort System
  const [sortCriteria, setSortCriteria] = useState<SortCriterion[]>(() => {
    const saved = sessionStorage.getItem('vg_sortCriteria');
    if (saved) {
      try { return JSON.parse(saved); } catch (e) {}
    }
    return [];
  });

  useEffect(() => {
    sessionStorage.setItem('vg_sortCriteria', JSON.stringify(sortCriteria));
  }, [sortCriteria]);
  const [showSortPanel, setShowSortPanel] = useState(false);
  const sortBtnRef = useRef<HTMLButtonElement>(null);
  const sortPanelRef = useRef<HTMLDivElement>(null);
  // Panel position (fixed, set when opening)
  const [sortPanelPos, setSortPanelPos] = useState({ top: 0, left: 0 });

  // Need to recreate STATUS_OPTIONS here or import them (copying for simplicity)
  const STATUS_OPTIONS = ['Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'];

  // Close sort panel on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        sortPanelRef.current && !sortPanelRef.current.contains(e.target as Node) &&
        sortBtnRef.current && !sortBtnRef.current.contains(e.target as Node)
      ) {
        setShowSortPanel(false);
      }
    };
    if (showSortPanel) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showSortPanel]);

  // Open sort panel: measure button position and set panel coords
  const openSortPanel = () => {
    if (!showSortPanel && sortBtnRef.current) {
      const rect = sortBtnRef.current.getBoundingClientRect();
      setSortPanelPos({ top: rect.bottom + 8, left: rect.left });
    }
    setShowSortPanel(v => !v);
  };

  useEffect(() => {
    const fetchGamesAndTags = async () => {
      try {
        const [gamesRes, tagsRes, filtersRes, paginationRes] = await Promise.all([
           fetchWithAuth('/videogames/'),
           fetchWithAuth('/videogames/tags'),
           fetchWithAuth('/filters/'),
           fetchWithAuth('/settings/pagination')
        ]);
        if (gamesRes.ok) setGames(await gamesRes.json());
        if (tagsRes.ok) setAvailableTags(await tagsRes.json());
        if (filtersRes.ok) setSavedFilters(await filtersRes.json());
        if (paginationRes.ok) {
          const settings: { page_sizes: number[] } = await paginationRes.json();
          setPageSizeOptions(settings.page_sizes);
          setPageSize(current => current === 'infinite' || settings.page_sizes.includes(current) ? current : settings.page_sizes[0]);
        }
      } catch (err) {
        console.error('Failed to load dashboard data', err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchGamesAndTags();
  }, []);

  const handleDelete = async (gameId: number) => {
    if (!window.confirm("Are you sure you want to delete this game?")) return;
    try {
      const res = await fetchWithAuth(`/videogames/${gameId}`, { method: 'DELETE' });
      if (res.ok) {
        setGames(games.filter(g => g.id !== gameId));
      }
    } catch (err) {
      console.error(err);
    }
  };

  const saveEdit = async () => {
    if (!editingGame) return;
    try {
      const payload = {
        name: editingGame.name,
        description: editingGame.description || null,
        comments: editingGame.comments || null,
        image_url: editingGame.image_url || null,
        status: editingGame.status,
        playtime_hours: editingGame.playtime_hours !== undefined ? editingGame.playtime_hours : null,
        mark: editingGame.mark || null,
        hype: editingGame.hype || null,
        completion_date: editingGame.completion_date || null,
        publication_year: editingGame.publication_year || null,
        completion_percentage: editingGame.completion_percentage ?? null,
        tags: editingGame.tags || null,
        dlcs: editingGame.dlcs || null,
      };
      const res = await fetchWithAuth(`/videogames/${editingGame.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        setGames(games.map(g => g.id === editingGame.id ? editingGame : g));
        setEditingGame(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveFilter = async (name: string, data: FilterState) => {
    try {
      const res = await fetchWithAuth('/filters/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, filter_data: JSON.stringify(data) })
      });
      if (res.ok) setSavedFilters([...savedFilters, await res.json()]);
    } catch (e) {
      console.error("Save filter failed");
    }
  };

  const handleLoadFilter = (sf: any) => {
    try {
       setFilterState(JSON.parse(sf.filter_data));
    } catch {}
  };

  const handleDeleteFilter = async (id: number) => {
    try {
      if (await fetchWithAuth(`/filters/${id}`, { method: 'DELETE' }).then(r => r.ok)) {
         setSavedFilters(prev => prev.filter(f => f.id !== id));
      }
    } catch {}
  };

  const handleAutoFill = async () => {
    setIsAutoFilling(true);
    try {
      const payload = {
        game_ids: displayGames.map(g => g.id),
        overwrite: autoFillOverwrite
      };
      const res = await fetchWithAuth('/videogames/auto-fill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        throw new Error('Failed to start auto-fill');
      }
      setShowAutoFillModal(false);
    } catch (e) {
      console.error('Auto fill error:', e);
      alert('Error starting completion');
      setIsAutoFilling(false);
    }
  };

  // ─── Sort helpers ────────────────────────────────────────────────────────────
  const addSortCriterion = () => {
    // Default to the first field not already in use, or fall back to 'mark'
    const usedFields = sortCriteria.map(c => c.field);
    const nextField = SORT_FIELDS.find(f => !usedFields.includes(f)) ?? 'mark';
    setSortCriteria(prev => [...prev, { id: newSortId(), field: nextField, dir: 'asc' }]);
  };

  const updateSortCriterion = (id: number, updates: Partial<Omit<SortCriterion, 'id'>>) => {
    setSortCriteria(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
  };

  const removeSortCriterion = (id: number) => {
    setSortCriteria(prev => prev.filter(c => c.id !== id));
  };

  const moveCriterion = (id: number, dir: -1 | 1) => {
    setSortCriteria(prev => {
      const idx = prev.findIndex(c => c.id === id);
      if (idx < 0) return prev;
      const newIdx = idx + dir;
      if (newIdx < 0 || newIdx >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[newIdx]] = [next[newIdx], next[idx]];
      return next;
    });
  };

  // ─── Filter + Sort pipeline ────────────────────────────────────────────────
  const evaluateTagGroup = (group: TagGroup, gameTags: string[]): boolean => {
      if (group.conditions.length === 0) return true;
      const results = group.conditions.map(cond => {
          if (cond.type === 'group') return evaluateTagGroup(cond, gameTags);
          const rule = cond as TagRule;
          if (!rule.tag) return true; // skip empty rules
          const hasTag = gameTags.includes(rule.tag);
          return rule.operator === 'includes' ? hasTag : !hasTag;
      });
      if (group.matchLogic === 'AND') return results.every(r => r);
      return results.some(r => r);
  };

  const filteredGames = games.filter(g => {
     if (searchQuery && !g.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
     
     if (filterState.statusFilter.length > 0 && !filterState.statusFilter.includes(g.status)) return false;

     if (filterState.ratingRange.min !== '' && (g.mark === null || g.mark < filterState.ratingRange.min)) return false;
     if (filterState.ratingRange.max !== '' && (g.mark === null || g.mark > filterState.ratingRange.max)) return false;

     const hasPercentage = g.completion_percentage !== null && g.completion_percentage !== undefined;
     if (!hasPercentage || (g.status !== 'Stopped' && g.status !== 'Finished')) {
         if (!filterState.completionRange.includeEmpty) return false;
     } else {
         const p = g.completion_percentage;
         if (filterState.completionRange.min !== '' && p < filterState.completionRange.min) return false;
         if (filterState.completionRange.max !== '' && p > filterState.completionRange.max) return false;
     }

     if (filterState.playtimeRange.min !== '' && (g.playtime_hours === null || g.playtime_hours < filterState.playtimeRange.min)) return false;
     if (filterState.playtimeRange.max !== '' && (g.playtime_hours === null || g.playtime_hours > filterState.playtimeRange.max)) return false;

     if (filterState.dateRange.min !== '' || filterState.dateRange.max !== '') {
         const year = g.completion_date ? parseInt(g.completion_date, 10) : null;
         if (filterState.dateRange.min !== '' && (year === null || isNaN(year) || year < filterState.dateRange.min)) return false;
         if (filterState.dateRange.max !== '' && (year === null || isNaN(year) || year > filterState.dateRange.max)) return false;
     }

     const gTags = g.tags ? g.tags.split(',').map((s:string) => s.trim()) : [];
     if (!evaluateTagGroup(filterState.tagQuery, gTags)) return false;

     return true;
  });

  const displayGames = applyMultiSort(filteredGames, sortCriteria);
  const totalPages = pageSize === 'infinite' ? 1 : Math.max(1, Math.ceil(displayGames.length / pageSize));
  const visiblePage = Math.min(currentPage, totalPages);
  const pagedGames = pageSize === 'infinite'
    ? displayGames
    : displayGames.slice((visiblePage - 1) * pageSize, visiblePage * pageSize);

  const hasSorts = sortCriteria.length > 0;
  const hasActiveFiltersOrSearch = searchQuery !== '' || JSON.stringify(filterState) !== JSON.stringify(DEFAULT_FILTER_STATE);

  return (
    <div className="container vg-dashboard">
      <header className="vg-header">
        <div>
          <h1 className="text-gradient">Videogames Tracker</h1>
          <p className="text-secondary">Track and manage your collection</p>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          {user?.is_admin && (
            <Link to="/dashboard/admin" className="btn btn-secondary add-btn">
              <Shield size={20} />
              Admin Features
            </Link>
          )}
          <Link to="/dashboard/videogames/analytics" className="btn btn-secondary add-btn">
            <BarChart3 size={20} />
            Analytics
          </Link>
          <button className="btn btn-primary add-btn" onClick={() => setShowAutoFillModal(true)}>
            <Sparkles size={20} />
            Completion
          </button>
          <Link to="/dashboard/videogames/add" className="btn btn-primary add-btn">
            <Plus size={20} />
            Add Game
          </Link>
        </div>
      </header>

      {autoFillProgress && autoFillProgress.status !== 'idle' && (
        <div className="glass-card" style={{ marginBottom: '1.5rem', padding: '1rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
            <span>{autoFillProgress.status === 'done' ? 'Completion Finished!' : autoFillProgress.status === 'error' ? 'Completion Error' : 'Completing Games...'}</span>
            <span>{autoFillProgress.completed} / {autoFillProgress.total}</span>
          </div>
          <div style={{ height: '8px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '4px', overflow: 'hidden', width: '100%' }}>
            <div style={{ 
              height: '100%', 
              backgroundColor: 'var(--primary-color)', 
              width: `${autoFillProgress.total > 0 ? Math.round((autoFillProgress.completed / autoFillProgress.total) * 100) : 0}%`,
              transition: 'width 0.3s ease'
            }}></div>
          </div>
        </div>
      )}

      <div className="vg-toolbar glass-card">
        <div className="toolbar-search">
          <div className="search-input-wrapper">
            <Search className="search-icon" size={18} />
            <input 
              type="text" 
              className="form-input" 
              placeholder="Search your collection..." 
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setCurrentPage(1); }}
            />
          </div>
          <button className="btn btn-secondary toolbar-btn">
            Search
          </button>
          <button className="btn btn-ghost toolbar-btn" onClick={() => setShowFilterModal(true)}>
            <Filter size={18} />
            Filter
          </button>

          {/* ── Sort button ── */}
          <button
            ref={sortBtnRef}
            id="sort-btn"
            className={`btn toolbar-btn sort-btn ${hasSorts ? 'sort-btn--active' : 'btn-ghost'}`}
            onClick={openSortPanel}
            title="Multi-sort"
          >
            <ArrowUpDown size={18} />
            Sort
            {hasSorts && <span className="sort-badge">{sortCriteria.length}</span>}
          </button>

          {/* ── Sort panel rendered via portal (always above everything) ── */}
          {showSortPanel && createPortal(
            <div
              ref={sortPanelRef}
              className="sort-panel glass-card"
              style={{ position: 'fixed', top: sortPanelPos.top, left: sortPanelPos.left, zIndex: 9999 }}
            >
              <div className="sort-panel-header">
                <span className="sort-panel-title">Sort Order</span>
                {hasSorts && (
                  <button
                    className="btn btn-ghost sort-clear-btn"
                    onClick={() => setSortCriteria([])}
                    title="Clear all sorts"
                  >
                    <X size={14} /> Clear
                  </button>
                )}
              </div>

              {sortCriteria.length === 0 && (
                <p className="sort-empty-hint">No sorts applied. Add one below.</p>
              )}

              <div className="sort-criteria-list">
                {sortCriteria.map((c, idx) => (
                  <div key={c.id} className="sort-criterion-row">
                    <span className="sort-priority-badge">{idx + 1}</span>

                    <div className="sort-move-btns">
                      <button className="sort-move-btn" disabled={idx === 0} onClick={() => moveCriterion(c.id, -1)} title="Move up">
                        <ArrowUp size={12} />
                      </button>
                      <button className="sort-move-btn" disabled={idx === sortCriteria.length - 1} onClick={() => moveCriterion(c.id, 1)} title="Move down">
                        <ArrowDown size={12} />
                      </button>
                    </div>

                    <select
                      className="form-input sort-field-select"
                      value={c.field}
                      onChange={e => updateSortCriterion(c.id, { field: e.target.value as SortField })}
                    >
                      {SORT_FIELDS.map(f => (
                        <option key={f} value={f}>{SORT_FIELD_LABELS[f]}</option>
                      ))}
                    </select>

                    <button
                      className={`sort-dir-btn ${c.dir === 'asc' ? 'asc' : 'desc'}`}
                      onClick={() => updateSortCriterion(c.id, { dir: c.dir === 'asc' ? 'desc' : 'asc' })}
                      title={c.dir === 'asc' ? 'Low → High' : 'High → Low'}
                    >
                      {c.dir === 'asc' ? <><ArrowUp size={12} /> Low→High</> : <><ArrowDown size={12} /> High→Low</>}
                    </button>

                    <button className="sort-remove-btn" onClick={() => removeSortCriterion(c.id)} title="Remove">
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </div>

              {sortCriteria.length < SORT_FIELDS.length && (
                <button className="btn btn-ghost sort-add-btn" onClick={addSortCriterion}>
                  <PlusIcon size={14} /> Add sort
                </button>
              )}
            </div>,
            document.body
          )}

          {(hasActiveFiltersOrSearch || hasSorts) && (
            <button
              className="btn btn-ghost toolbar-btn"
              style={{ color: 'var(--error-color)' }}
              onClick={() => { setFilterState(DEFAULT_FILTER_STATE); setSearchQuery(''); setSortCriteria([]); setCurrentPage(1); }}
              title="Clear all filters, search and sorts"
            >
              <X size={18} />
              Clear
            </button>
          )}
        </div>

        <div className="toolbar-views">
          <button 
            className={`view-btn ${viewMode === 'list' ? 'active' : ''}`}
            onClick={() => setViewMode('list')}
            title="List View"
          >
            <ListIcon size={20} />
          </button>
          <button 
            className={`view-btn ${viewMode === 'matrix' ? 'active' : ''}`}
            onClick={() => setViewMode('matrix')}
            title="Matrix View"
          >
            <LayoutGrid size={20} />
          </button>
        </div>
      </div>

      <div className={`vg-collection ${viewMode}-view`}>
        {isLoading ? (
          <div className="empty-state">
            <Loader2 className="spinner" size={32} />
          </div>
        ) : displayGames.length > 0 ? (
          pagedGames.map((game: any) => (
            <div key={game.id} className="vg-card glass-card">
              <div className="vg-cover-wrapper">
                {game.image_url ? (
                  <img src={game.image_url} alt={game.name} className="vg-cover" />
                ) : (
                  <div className="vg-cover placeholder" style={{ backgroundColor: 'var(--bg-primary)', width: '100%', height: '100%' }} />
                )}
              </div>
              <div className="vg-info">
                <h3>{game.name}</h3>
                <span className="badge" style={{ marginTop: '0.5rem', display: 'inline-block' }}>{game.status}</span>
              </div>
              <div className="card-actions">
                <button className="icon-btn edit-btn" onClick={() => setEditingGame(game)} title="Edit"><Edit2 size={16} /></button>
                <button className="icon-btn delete-btn" onClick={() => handleDelete(game.id)} title="Delete"><Trash2 size={16} /></button>
              </div>
            </div>
          ))
        ) : (
          <div className="empty-state">
            <p className="text-muted">No games found in your collection.</p>
          </div>
        )}
      </div>
      {!isLoading && displayGames.length > 0 && <PaginationControls page={visiblePage} pageSize={pageSize} pageSizeOptions={pageSizeOptions} totalItems={displayGames.length} onPageChange={setCurrentPage} onPageSizeChange={value => { setPageSize(value); setCurrentPage(1); }} />}

      {/* Edit Game Modal */}
      {editingGame && (
        <div className="modal-overlay">
          <div className="glass-card modal-content">
            <button className="modal-close" onClick={() => setEditingGame(null)}><X size={20}/></button>
            <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', marginBottom: '1.5rem', gap: '0.75rem' }}>
              <h2 style={{ margin: 0 }}>Edit Game</h2>
              <div className="info-tooltip-container">
                <HelpCircle size={18} />
                <div className="tooltip-text">
                  <strong>Game Data</strong> (Neutral background) contains general info about the game.<br/><br/>
                  <strong>User Data</strong> (Blue background) contains your personal progress, review, and tags.
                </div>
              </div>
            </div>

            <div className="data-section-game">
              <h3 className="section-title">Game Data</h3>

              <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                <div 
                  style={{ flexShrink: 0, width: '120px', height: '160px', borderRadius: 'var(--radius-md)', overflow: 'hidden', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)', cursor: 'pointer', position: 'relative' }}
                  onClick={handleOpenImageSelect}
                  title="Click to select image"
                >
                  {editingGame.image_url ? (
                    <img src={editingGame.image_url} alt="Cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  ) : (
                    <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No Cover</div>
                  )}
                  <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.6)', color: 'white', fontSize: '0.7rem', padding: '4px', textAlign: 'center' }}>
                    Click to change
                  </div>
                </div>
                
                <div style={{ flex: 1, minWidth: '250px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                  <div className="form-group" style={{ margin: 0 }}>
                     <label className="form-label">Name</label>
                     <input type="text" className="form-input" value={editingGame.name} onChange={e => setEditingGame({...editingGame, name: e.target.value})}/>
                  </div>
                </div>
              </div>

              <div className="form-group">
                 <label className="form-label">Description</label>
                 <textarea className="form-input" rows={3} value={editingGame.description || ''} onChange={e => setEditingGame({...editingGame, description: e.target.value})} />
              </div>

              <div className="form-group">
                <label className="form-label">Publication Year</label>
                <input type="number" min="1950" max="2100" className="form-input" placeholder="YYYY" value={editingGame.publication_year || ''} onChange={e => setEditingGame({...editingGame, publication_year: e.target.value ? Number(e.target.value) : null})} />
              </div>

              <div className="form-group">
                <label className="form-label">DLCs</label>
                <DlcEditor value={editingGame.dlcs || ''} onChange={(val) => setEditingGame({...editingGame, dlcs: val})} gameName={editingGame.name} />
              </div>
            </div>

            <div className="data-section-user">
              <h3 className="section-title">User Data</h3>
              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Status</label>
                  <select className="form-input" value={editingGame.status} onChange={e => setEditingGame({...editingGame, status: e.target.value})}>
                    {STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                </div>
                {(editingGame.status === 'Stopped' || editingGame.status === 'Finished' || editingGame.status === 'Infinite') && (
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">Completion %</label>
                    <select className="form-input" value={editingGame.completion_percentage ?? ''} onChange={e => setEditingGame({...editingGame, completion_percentage: e.target.value ? Number(e.target.value) : null})}>
                      <option value="">--</option>
                      {[...Array(11)].map((_, i) => <option key={i*10} value={i*10}>{i*10}%</option>)}
                    </select>
                  </div>
                )}
                {(editingGame.status === 'Finished' || editingGame.status === 'Stopped' || editingGame.status === 'Infinite') ? (
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">Rating (1-10)</label>
                    <input type="number" min="1" max="10" className="form-input" value={editingGame.mark || ''} onChange={e => setEditingGame({...editingGame, mark: e.target.value ? Number(e.target.value) : null})} />
                  </div>
                ) : (
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">Hype (1-10)</label>
                    <input type="number" min="1" max="10" className="form-input" placeholder="Your anticipation…" value={editingGame.hype || ''} onChange={e => setEditingGame({...editingGame, hype: e.target.value ? Number(e.target.value) : null})} />
                  </div>
                )}
              </div>

              <div className="form-group">
                <label className="form-label">Playtime (Hours)</label>
                <input type="number" step="0.1" min="0" className="form-input" placeholder="e.g. 50.5" value={editingGame.playtime_hours !== null && editingGame.playtime_hours !== undefined ? editingGame.playtime_hours : ''} onChange={e => setEditingGame({...editingGame, playtime_hours: e.target.value ? Number(e.target.value) : null})} />
              </div>

              {(editingGame.status === 'Finished' || editingGame.status === 'Stopped' || editingGame.status === 'Infinite') && (
                <div className="form-group">
                  <label className="form-label">Completion Date</label>
                  <CompletionDatePicker value={editingGame.completion_date || ''} onChange={(val) => setEditingGame({...editingGame, completion_date: val})} />
                </div>
              )}

              <div className="form-group">
                <label className="form-label">Comments / Review</label>
                <textarea className="form-input" rows={3} value={editingGame.comments || ''} onChange={e => setEditingGame({...editingGame, comments: e.target.value})} />
              </div>

              <div className="form-group">
                 <label className="form-label">Tags</label>
                 <TagMultiSelect availableTags={availableTags} selectedTagsString={editingGame.tags || ''} onChange={(newTags) => setEditingGame({ ...editingGame, tags: newTags })} />
              </div>
            </div>

            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setEditingGame(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={saveEdit}>Save Changes</button>
            </div>
          </div>
        </div>
      )}

      {/* Image Select Modal */}
      {showImageSelectModal && editingGame && (
        <div className="modal-overlay" style={{ zIndex: 10000 }}>
          <div className="glass-card modal-content" style={{ maxWidth: '600px', width: '90%' }}>
            <button className="modal-close" onClick={() => setShowImageSelectModal(false)}><X size={20}/></button>
            <h2 style={{ marginBottom: '1.5rem' }}>Select Cover Image</h2>
            
            <div className="form-group">
              <label className="form-label">Image Link (Manual override)</label>
              <input type="url" className="form-input" placeholder="https://..." value={editingGame.image_url || ''} onChange={e => setEditingGame({...editingGame, image_url: e.target.value})} />
            </div>
            
            <div style={{ borderTop: '1px solid var(--border-color)', margin: '1rem 0', paddingTop: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1rem' }}>
                <h3 className="section-title" style={{ margin: 0 }}>Online Search Results</h3>
                <div style={{ display: 'flex', gap: '0.5rem', width: '300px' }}>
                  <input 
                    type="text" 
                    className="form-input" 
                    value={imageSearchQuery} 
                    onChange={e => setImageSearchQuery(e.target.value)} 
                    onKeyDown={e => e.key === 'Enter' && fetchIGDBImages(imageSearchQuery)}
                    placeholder="Search online..."
                  />
                  <button className="btn btn-secondary" onClick={() => fetchIGDBImages(imageSearchQuery)}>
                    Search
                  </button>
                </div>
              </div>
              {isIgdbImagesLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                  <Loader2 className="spinner" size={24} />
                </div>
              ) : igdbImages.length > 0 ? (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(100px, 1fr))', gap: '1rem', maxHeight: '400px', overflowY: 'auto', padding: '0.5rem' }}>
                  {igdbImages.map((img) => (
                    <div 
                      key={img.igdb_id} 
                      style={{ cursor: 'pointer', border: editingGame.image_url === img.cover_url ? '2px solid var(--primary-color)' : '2px solid transparent', borderRadius: '4px', overflow: 'hidden' }}
                      onClick={() => {
                        setEditingGame({...editingGame, image_url: img.cover_url});
                        setShowImageSelectModal(false);
                      }}
                      title={img.name}
                    >
                      <img src={img.cover_url} alt={img.name} style={{ width: '100%', display: 'block' }} />
                      <div style={{ padding: '0.25rem', fontSize: '0.75rem', backgroundColor: 'var(--bg-secondary)', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {img.name}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-muted">No images found for "{imageSearchQuery}".</p>
              )}
            </div>
            
            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button className="btn btn-ghost" onClick={() => setShowImageSelectModal(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {showFilterModal && (
        <AdvancedFilterModal 
           filterState={filterState}
           onChange={setFilterState}
           onApply={() => setShowFilterModal(false)}
           onClose={() => setShowFilterModal(false)}
           availableTags={availableTags}
           savedFilters={savedFilters}
           onSaveFilter={handleSaveFilter}
           onLoadFilter={handleLoadFilter}
           onDeleteFilter={handleDeleteFilter}
        />
      )}

      {showAutoFillModal && (
        <div className="modal-overlay">
          <div className="glass-card modal-content" style={{ maxWidth: '500px' }}>
            <button className="modal-close" onClick={() => setShowAutoFillModal(false)}><X size={20}/></button>
            <h2 style={{ marginBottom: '1.5rem' }}>Auto-Fill Missing Data</h2>
            <p style={{ marginBottom: '1rem', lineHeight: '1.5' }}>
              This will automatically find and fill missing information (Cover Image, Description, Publication Year) from the internet for <strong>{displayGames.length}</strong> currently filtered games.
            </p>
            <div style={{ marginBottom: '2rem' }}>
              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                <input type="checkbox" checked={autoFillOverwrite} onChange={e => setAutoFillOverwrite(e.target.checked)} />
                Overwrite existing data? (If unchecked, only empty fields will be filled)
              </label>
            </div>
            <div className="modal-actions" style={{ display: 'flex', justifyContent: 'flex-end', gap: '1rem' }}>
              <button className="btn btn-ghost" onClick={() => setShowAutoFillModal(false)}>Cancel</button>
              <button className="btn btn-primary" onClick={handleAutoFill} disabled={isAutoFilling || displayGames.length === 0}>
                {isAutoFilling ? 'Starting...' : 'Start Completion'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
