import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Search, Filter, LayoutGrid, List as ListIcon, Plus, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import './VideogamesDashboard.css';

type ViewMode = 'list' | 'matrix';

export function VideogamesDashboard() {
  const [viewMode, setViewMode] = useState<ViewMode>('matrix');
  const [searchQuery, setSearchQuery] = useState('');
  const [games, setGames] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const fetchGames = async () => {
      try {
        const res = await fetchWithAuth('/videogames/');
        if (res.ok) {
          const data = await res.json();
          setGames(data);
        }
      } catch (err) {
        console.error('Failed to load games', err);
      } finally {
        setIsLoading(false);
      }
    };
    fetchGames();
  }, []);

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
            </div>
          ))
        ) : (
          <div className="empty-state">
            <p className="text-muted">No games found in your collection.</p>
          </div>
        )}
      </div>
    </div>
  );
}
