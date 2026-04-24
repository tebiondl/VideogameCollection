import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Search, Filter, LayoutGrid, List as ListIcon, Plus, Loader2, Trash2, Edit2, X, ArrowUpDown, ArrowUp, ArrowDown, Plus as PlusIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { fetchWithAuth } from '../lib/api';
import { TagMultiSelect } from '../components/TagMultiSelect';
import { AdvancedFilterModal, DEFAULT_FILTER_STATE } from '../components/AdvancedFilterModal';
import type { FilterState, TagGroup, TagRule } from '../components/AdvancedFilterModal';
import { CompletionDatePicker } from '../components/CompletionDatePicker';
import { DlcEditor } from '../components/DlcEditor';
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
  const [viewMode, setViewMode] = useState<ViewMode>('matrix');
  const [searchQuery, setSearchQuery] = useState('');
  const [games, setGames] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingGame, setEditingGame] = useState<any>(null);
  const [availableTags, setAvailableTags] = useState<any[]>([]);

  // Filtering System
  const [showFilterModal, setShowFilterModal] = useState(false);
  const [filterState, setFilterState] = useState<FilterState>(DEFAULT_FILTER_STATE);
  const [savedFilters, setSavedFilters] = useState<any[]>([]);

  // Sort System
  const [sortCriteria, setSortCriteria] = useState<SortCriterion[]>([]);
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
        const [gamesRes, tagsRes, filtersRes] = await Promise.all([
           fetchWithAuth('/videogames/'),
           fetchWithAuth('/videogames/tags'),
           fetchWithAuth('/filters/')
        ]);
        if (gamesRes.ok) setGames(await gamesRes.json());
        if (tagsRes.ok) setAvailableTags(await tagsRes.json());
        if (filtersRes.ok) setSavedFilters(await filtersRes.json());
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
        image_url: editingGame.image_url || null,
        status: editingGame.status,
        time_spent: editingGame.time_spent || null,
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

     const gTags = g.tags ? g.tags.split(',').map((s:string) => s.trim()) : [];
     if (!evaluateTagGroup(filterState.tagQuery, gTags)) return false;

     return true;
  });

  const displayGames = applyMultiSort(filteredGames, sortCriteria);

  const hasSorts = sortCriteria.length > 0;
  const hasActiveFiltersOrSearch = searchQuery !== '' || JSON.stringify(filterState) !== JSON.stringify(DEFAULT_FILTER_STATE);

  return (
    <div className="container vg-dashboard">
      <header className="vg-header">
        <div>
          <h1 className="text-gradient">Videogames Vault</h1>
          <p className="text-secondary">Track and manage your collection</p>
        </div>
        <Link to="/dashboard/videogames/add" className="btn btn-primary add-btn">
          <Plus size={20} />
          Add Game
        </Link>
      </header>

      <div className="vg-toolbar glass-card">
        <div className="toolbar-search">
          <div className="search-input-wrapper">
            <Search className="search-icon" size={18} />
            <input 
              type="text" 
              className="form-input" 
              placeholder="Search your collection..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
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
              onClick={() => { setFilterState(DEFAULT_FILTER_STATE); setSearchQuery(''); setSortCriteria([]); }}
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
          displayGames.map((game: any) => (
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

      {/* Edit Game Modal */}
      {editingGame && (
        <div className="modal-overlay">
          <div className="glass-card modal-content">
            <button className="modal-close" onClick={() => setEditingGame(null)}><X size={20}/></button>
            <h2 style={{ marginBottom: '1.5rem' }}>Edit Game</h2>
            
            <div className="form-group">
               <label className="form-label">Name</label>
               <input type="text" className="form-input" value={editingGame.name} onChange={e => setEditingGame({...editingGame, name: e.target.value})}/>
            </div>

            <div className="form-group">
               <label className="form-label">Description / Review</label>
               <textarea className="form-input" rows={3} value={editingGame.description || ''} onChange={e => setEditingGame({...editingGame, description: e.target.value})} />
            </div>
            
            <div className="form-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Status</label>
                <select className="form-input" value={editingGame.status} onChange={e => setEditingGame({...editingGame, status: e.target.value})}>
                  {STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </div>
              {(editingGame.status === 'Stopped' || editingGame.status === 'Finished') && (
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Completion %</label>
                  <select className="form-input" value={editingGame.completion_percentage ?? ''} onChange={e => setEditingGame({...editingGame, completion_percentage: e.target.value ? Number(e.target.value) : null})}>
                    <option value="">--</option>
                    {[...Array(11)].map((_, i) => <option key={i*10} value={i*10}>{i*10}%</option>)}
                  </select>
                </div>
              )}
              {(editingGame.status === 'Finished' || editingGame.status === 'Stopped') ? (
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

            <div className="form-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Time Spent</label>
                <input type="text" className="form-input" placeholder="e.g. 50 hrs" value={editingGame.time_spent || ''} onChange={e => setEditingGame({...editingGame, time_spent: e.target.value})} />
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Publication Year</label>
                <input type="number" min="1950" max="2100" className="form-input" placeholder="YYYY" value={editingGame.publication_year || ''} onChange={e => setEditingGame({...editingGame, publication_year: e.target.value ? Number(e.target.value) : null})} />
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Completion Date</label>
              <CompletionDatePicker
                value={editingGame.completion_date || ''}
                onChange={(val) => setEditingGame({...editingGame, completion_date: val})}
              />
            </div>
            
            <div className="form-group">
               <label className="form-label">Tags</label>
               <TagMultiSelect 
                  availableTags={availableTags}
                  selectedTagsString={editingGame.tags || ''}
                  onChange={(newTags) => setEditingGame({ ...editingGame, tags: newTags })}
               />
            </div>

            <div className="form-group">
              <label className="form-label">DLCs</label>
              <DlcEditor
                value={editingGame.dlcs || ''}
                onChange={(val) => setEditingGame({...editingGame, dlcs: val})}
              />
            </div>

            <div className="modal-actions" style={{ marginTop: '2rem', display: 'flex', justifyContent: 'flex-end' }}>
               <button className="btn btn-primary" onClick={saveEdit}>
                 Save Changes
               </button>
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
    </div>
  );
}
