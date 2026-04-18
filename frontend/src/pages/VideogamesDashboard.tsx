import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Search, Filter, LayoutGrid, List as ListIcon, Plus, Loader2, Trash2, Edit2, X } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { TagMultiSelect } from '../components/TagMultiSelect';
import './VideogamesDashboard.css';

type ViewMode = 'list' | 'matrix';

export function VideogamesDashboard() {
  const [viewMode, setViewMode] = useState<ViewMode>('matrix');
  const [searchQuery, setSearchQuery] = useState('');
  const [games, setGames] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [editingGame, setEditingGame] = useState<any>(null);
  const [availableTags, setAvailableTags] = useState<any[]>([]);
  
  // Need to recreate STATUS_OPTIONS here or import them (copying for simplicity)
  const STATUS_OPTIONS = ['Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'];

  useEffect(() => {
    const fetchGamesAndTags = async () => {
      try {
        const [gamesRes, tagsRes] = await Promise.all([
           fetchWithAuth('/videogames/'),
           fetchWithAuth('/videogames/tags')
        ]);
        if (gamesRes.ok) setGames(await gamesRes.json());
        if (tagsRes.ok) setAvailableTags(await tagsRes.json());
      } catch (err) {
        console.error('Failed to load games', err);
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
      const res = await fetchWithAuth(`/videogames/${editingGame.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editingGame)
      });
      if (res.ok) {
        setGames(games.map(g => g.id === editingGame.id ? editingGame : g));
        setEditingGame(null);
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Local filter for data
  const filteredGames = games.filter(g => g.name.toLowerCase().includes(searchQuery.toLowerCase()));

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
          <button className="btn btn-ghost toolbar-btn" disabled title="Filters coming soon">
            <Filter size={18} />
            Filter
          </button>
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
        ) : filteredGames.length > 0 ? (
          filteredGames.map((game: any) => (
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
            
            <div className="form-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Status</label>
                <select className="form-input" value={editingGame.status} onChange={e => setEditingGame({...editingGame, status: e.target.value})}>
                  {STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Rating</label>
                <input type="number" min="1" max="10" className="form-input" value={editingGame.mark || ''} onChange={e => setEditingGame({...editingGame, mark: e.target.value ? Number(e.target.value) : null})} />
              </div>
            </div>
            
            <div className="form-group">
               <label className="form-label">Tags</label>
               <TagMultiSelect 
                  availableTags={availableTags}
                  selectedTagsString={editingGame.tags || ''}
                  onChange={(newTags) => setEditingGame({ ...editingGame, tags: newTags })}
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
    </div>
  );
}
