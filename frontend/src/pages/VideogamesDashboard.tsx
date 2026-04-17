import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Search, Filter, LayoutGrid, List as ListIcon, Plus } from 'lucide-react';
import './VideogamesDashboard.css';

// Local Mock Data
const MOCK_GAMES = [
  { id: 1, title: "Elden Ring", img: "https://images.igdb.com/igdb/image/upload/t_cover_big/co4jni.png" },
  { id: 2, title: "Cyberpunk 2077", img: "https://images.igdb.com/igdb/image/upload/t_cover_big/co2mvt.png" },
  { id: 3, title: "Hollow Knight", img: "https://images.igdb.com/igdb/image/upload/t_cover_big/co1r7f.png" },
  { id: 4, title: "Persona 5 Royal", img: "https://images.igdb.com/igdb/image/upload/t_cover_big/co1nic.png" },
  { id: 5, title: "The Witcher 3: Wild Hunt", img: "https://images.igdb.com/igdb/image/upload/t_cover_big/co1wyy.png" }
];

type ViewMode = 'list' | 'matrix';

export function VideogamesDashboard() {
  const [viewMode, setViewMode] = useState<ViewMode>('matrix');
  const [searchQuery, setSearchQuery] = useState('');

  // Local filter for mock data
  const filteredGames = MOCK_GAMES.filter(g => g.title.toLowerCase().includes(searchQuery.toLowerCase()));

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
        {filteredGames.length > 0 ? (
          filteredGames.map(game => (
            <div key={game.id} className="vg-card glass-card">
              <div className="vg-cover-wrapper">
                <img src={game.img} alt={game.title} className="vg-cover" />
              </div>
              <div className="vg-info">
                <h3>{game.title}</h3>
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
