import { X } from 'lucide-react';
import './SimilarGameModal.css';

interface VideogameResponse {
  id: int;
  name: str;
  image_url: str | null;
  status: str;
}

interface Props {
  matches: VideogameResponse[];
  onCancel: () => void;
  onSaveNew: () => void;
  onUpdateExisting: (id: number) => void;
}

export function SimilarGameModal({ matches, onCancel, onSaveNew, onUpdateExisting }: Props) {
  return (
    <div className="modal-overlay">
      <div className="glass-card modal-content">
        <button className="modal-close" onClick={onCancel}><X size={20}/></button>
        
        <h2>Similar Games Detected</h2>
        <p className="text-secondary" style={{ marginBottom: '1.5rem', marginTop: '0.5rem' }}>
          We found {matches.length} game(s) in your collection with a very similar name. Do you want to update an existing one instead?
        </p>

        <div className="modal-matches-list">
          {matches.map(game => (
            <div key={game.id} className="match-card">
              <div className="match-info">
                {game.image_url ? (
                  <img src={game.image_url} alt={game.name} className="match-thumb" />
                ) : (
                  <div className="match-thumb placeholder" />
                )}
                <div>
                  <h4>{game.name}</h4>
                  <span className="badge">{game.status}</span>
                </div>
              </div>
              <button 
                className="btn btn-secondary" 
                onClick={() => onUpdateExisting(game.id)}
              >
                Update This
              </button>
            </div>
          ))}
        </div>

        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>
            Return & Edit
          </button>
          <button className="btn btn-primary" onClick={onSaveNew}>
            Save as New Game
          </button>
        </div>
      </div>
    </div>
  );
}
