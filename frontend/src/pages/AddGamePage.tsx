import { Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

export function AddGamePage() {
  return (
    <div className="container" style={{ padding: '2rem 1.5rem' }}>
      <div style={{ marginBottom: '2rem' }}>
        <Link to="/dashboard/videogames" className="btn btn-ghost" style={{ padding: '0.5rem 0' }}>
          <ArrowLeft size={18} />
          Back to Videogames
        </Link>
      </div>
      
      <div className="glass-card text-center" style={{ padding: '5rem 2rem' }}>
        <h1 className="text-gradient">Add a Game</h1>
        <p className="text-secondary" style={{ marginTop: '1rem' }}>
          This page is currently empty. We will build the search and addition logic here next!
        </p>
      </div>
    </div>
  );
}
