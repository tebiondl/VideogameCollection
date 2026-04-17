import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { SimilarGameModal } from '../components/SimilarGameModal';
import './AddGamePage.css';

const AVAILABLE_TAGS = ['Gacha', 'Online', 'Runs'];
const STATUS_OPTIONS = ['Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'];

export function AddGamePage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'search'|'manual'|'smart'>('manual');
  
  // Form State
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [status, setStatus] = useState(STATUS_OPTIONS[0]);
  const [timeSpent, setTimeSpent] = useState('');
  const [mark, setMark] = useState<number | ''>('');
  const [completionDate, setCompletionDate] = useState('');
  const [pubYear, setPubYear] = useState<number | ''>('');
  const [tags, setTags] = useState<string[]>([]);

  // Modal State
  const [similarGames, setSimilarGames] = useState<any[]>([]);
  const [showModal, setShowModal] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const toggleTag = (tag: string) => {
    setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  };

  const constructPayload = () => ({
    name,
    description: description || null,
    image_url: imageUrl || null,
    status,
    time_spent: timeSpent || null,
    mark: mark !== '' ? mark : null,
    completion_date: completionDate || null,
    publication_year: pubYear !== '' ? pubYear : null,
    tags: tags.length > 0 ? tags.join(',') : null
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    
    setError('');
    setIsSubmitting(true);
    
    try {
      // 1. Check for similar games
      const checkRes = await fetchWithAuth('/videogames/check-similar', {
        method: 'POST',
        body: JSON.stringify({ name })
      });
      
      if (!checkRes.ok) throw new Error('Failed to verify duplicates');
      const matches = await checkRes.json();
      
      if (matches.length > 0) {
        setSimilarGames(matches);
        setShowModal(true);
        setIsSubmitting(false);
        return; // Halt logic to let user decide
      }
      
      // 2. No matches, safe to save directly
      await performSave();
      
    } catch (err: any) {
      setError(err.message);
      setIsSubmitting(false);
    }
  };

  const performSave = async () => {
    setIsSubmitting(true);
    try {
      const res = await fetchWithAuth('/videogames/', {
        method: 'POST',
        body: JSON.stringify(constructPayload())
      });
      
      if (!res.ok) throw new Error('Failed to save game');
      navigate('/dashboard/videogames');
    } catch (err: any) {
      setError(err.message);
      setIsSubmitting(false);
    }
  };

  const performUpdate = async (gameId: number) => {
    setIsSubmitting(true);
    setShowModal(false);
    try {
      const res = await fetchWithAuth(`/videogames/${gameId}`, {
        method: 'PUT',
        body: JSON.stringify(constructPayload())
      });
      
      if (!res.ok) throw new Error('Failed to update game');
      navigate('/dashboard/videogames');
    } catch (err: any) {
      setError(err.message);
      setIsSubmitting(false);
    }
  };

  return (
    <div className="container" style={{ padding: '2rem 1.5rem', maxWidth: '800px' }}>
      <div style={{ marginBottom: '2rem' }}>
        <Link to="/dashboard/videogames" className="btn btn-ghost" style={{ padding: '0.5rem 0' }}>
          <ArrowLeft size={18} />
          Back to Videogames
        </Link>
      </div>

      <header className="add-game-header">
        <h1>Add somewhat to your Vault</h1>
        
        <div className="tabs-container">
          <button className={`tab-btn ${activeTab === 'search' ? 'active' : ''}`} onClick={() => setActiveTab('search')}>
            Search API
          </button>
          <button className={`tab-btn ${activeTab === 'manual' ? 'active' : ''}`} onClick={() => setActiveTab('manual')}>
            Manual Entry
          </button>
          <button className={`tab-btn ${activeTab === 'smart' ? 'active' : ''}`} onClick={() => setActiveTab('smart')}>
            Smart Import
          </button>
        </div>
      </header>

      {error && <div className="auth-error" style={{ marginBottom: '1.5rem' }}>{error}</div>}

      {activeTab === 'manual' ? (
        <form onSubmit={handleSubmit} className="glass-card add-form">
          <div className="form-group">
            <label className="form-label">Game Name *</label>
            <input type="text" className="form-input" required value={name} onChange={e => setName(e.target.value)} />
          </div>
          
          <div className="form-row">
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Status</label>
              <select className="form-input" value={status} onChange={e => setStatus(e.target.value)}>
                {STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Your Rating (1-10)</label>
              <input type="number" min="1" max="10" className="form-input" value={mark} onChange={e => setMark(e.target.value ? Number(e.target.value) : '')} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Description / Review</label>
            <textarea className="form-input" rows={3} value={description} onChange={e => setDescription(e.target.value)} />
          </div>

          <div className="form-group">
            <label className="form-label">Image Cover URL</label>
            <input type="url" className="form-input" placeholder="https://..." value={imageUrl} onChange={e => setImageUrl(e.target.value)} />
          </div>

          <div className="form-row">
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Time Spent</label>
              <input type="text" className="form-input" placeholder="e.g. 50 hrs" value={timeSpent} onChange={e => setTimeSpent(e.target.value)} />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Completion Date</label>
              <input type="text" className="form-input" placeholder="YYYY or YYYY-MM-DD" value={completionDate} onChange={e => setCompletionDate(e.target.value)} />
            </div>
             <div className="form-group" style={{ flex: 1 }}>
              <label className="form-label">Publication Year</label>
              <input type="number" min="1950" max="2100" className="form-input" placeholder="YYYY" value={pubYear} onChange={e => setPubYear(e.target.value ? Number(e.target.value) : '')} />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Tags</label>
            <div className="tags-container">
              {AVAILABLE_TAGS.map(tag => (
                <label key={tag} className="tag-checkbox">
                  <input type="checkbox" checked={tags.includes(tag)} onChange={() => toggleTag(tag)} />
                  <span className="tag-label">{tag}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="form-actions" style={{ marginTop: '2rem', display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={isSubmitting || !name.trim()}>
              {isSubmitting ? 'Processing...' : 'Save Game'}
            </button>
          </div>
        </form>
      ) : (
        <div className="glass-card text-center" style={{ padding: '4rem 2rem' }}>
          <h2 style={{ color: 'var(--text-muted)' }}>Feature Coming Soon</h2>
          <p className="text-secondary" style={{ marginTop: '0.5rem' }}>
            The {activeTab} function is still under development. Please use Manual Entry for now.
          </p>
        </div>
      )}

      {showModal && (
        <SimilarGameModal 
          matches={similarGames}
          onCancel={() => setShowModal(false)}
          onSaveNew={() => {
            setShowModal(false);
            performSave();
          }}
          onUpdateExisting={performUpdate}
        />
      )}
    </div>
  );
}
