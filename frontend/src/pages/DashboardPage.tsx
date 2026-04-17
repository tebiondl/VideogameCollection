import { useAuth } from '../context/AuthContext';
import { Link } from 'react-router-dom';
import { Gamepad2, Tv, Library, BookOpen } from 'lucide-react';
import './DashboardPage.css';

export function DashboardPage() {
  const { user } = useAuth();

  return (
    <div className="container dashboard-hub">
      <header className="hub-header">
        <h1>Welcome to your Vault, <span className="text-gradient">{user?.username}</span></h1>
        <p className="text-secondary">What would you like to track today?</p>
      </header>

      <div className="hub-grid">
        <Link to="/dashboard/videogames" className="glass-card hub-card active-card">
          <div className="hub-icon-wrapper pg-games">
            <Gamepad2 size={48} />
          </div>
          <h2>Videogames</h2>
          <p className="text-secondary">Manage your playing status, backlog, and game ratings.</p>
        </Link>
        
        <div className="glass-card hub-card disabled-card">
          <div className="hub-icon-wrapper pg-anime">
            <Tv size={48} />
          </div>
          <h2>Anime <span className="badge">Soon</span></h2>
          <p className="text-secondary">Track seasons, episodes, and your watch history.</p>
        </div>

        <div className="glass-card hub-card disabled-card">
          <div className="hub-icon-wrapper pg-boardgames">
            <Library size={48} />
          </div>
          <h2>Board Games <span className="badge">Soon</span></h2>
          <p className="text-secondary">Catalog your physical board games and game nights.</p>
        </div>

        <div className="glass-card hub-card disabled-card">
          <div className="hub-icon-wrapper pg-manga">
            <BookOpen size={48} />
          </div>
          <h2>Manga <span className="badge">Soon</span></h2>
          <p className="text-secondary">Follow your reading progress chapter by chapter.</p>
        </div>
      </div>
    </div>
  );
}
