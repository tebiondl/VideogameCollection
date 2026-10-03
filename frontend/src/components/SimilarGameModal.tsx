import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import './Modal.css';
import './SimilarGameModal.css';
import './DiscoveryDialog.css';

interface VideogameResponse {
  id: number;
  name: string;
  image_url: string | null;
  status: string;
}

interface Props {
  matches: VideogameResponse[];
  onCancel: () => void;
  onSaveNew: () => void;
  onUpdateExisting: (id: number) => void;
  isSaving?: boolean;
  error?: string;
  mode?: 'game' | 'copy';
}

export function SimilarGameModal({ matches, onCancel, onSaveNew, onUpdateExisting, isSaving = false, error, mode = 'game' }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (mode === 'copy') dialog.current?.showModal();
  }, [mode]);
  const content = <>
        <button type="button" className="modal-close" onClick={onCancel} disabled={isSaving} aria-label="Close similar games"><X size={20}/></button>
        
        <h2 id="similar-games-title">{mode === 'copy' ? 'Possible copies detected' : 'Similar Games Detected'}</h2>
        <p className="text-secondary" style={{ marginBottom: '1.5rem', marginTop: '0.5rem' }}>
          {mode === 'copy'
            ? 'You already have similar games in your collection. Choose where to add this copy, or save it as a separate game. Your existing copies and player progress will be kept.'
            : `We found ${matches.length} game(s) in your collection with a very similar name. Do you want to update an existing one instead?`}
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
                type="button"
                disabled={isSaving}
                className="btn btn-secondary" 
                onClick={() => onUpdateExisting(game.id)}
              >
                {mode === 'copy' ? 'Add copy to this game' : 'Update This'}
              </button>
            </div>
          ))}
        </div>

        {error && <div className="auth-error" role="alert" style={{ marginBottom: '1rem' }}>{error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={isSaving}>
            Return & Edit
          </button>
          <button type="button" className="btn btn-primary" onClick={onSaveNew} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save as New Game'}
          </button>
        </div>
  </>;
  return mode === 'copy'
    ? <dialog ref={dialog} className="discovery-dialog discovery similar-copy-dialog" aria-labelledby="similar-games-title" aria-busy={isSaving} onCancel={event => { event.preventDefault(); event.stopPropagation(); if (!isSaving) onCancel(); }}>{content}</dialog>
    : <div className="modal-overlay"><div className="glass-card modal-content" role="dialog" aria-modal="true" aria-labelledby="similar-games-title" aria-busy={isSaving}>{content}</div></div>;
}
