import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Navigate, Link } from 'react-router-dom';
import { Shield, Plus, Trash2, Loader2, ArrowLeft } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import './DashboardPage.css'; // Reuse basic styles

interface Tag {
  id: number;
  name: string;
  user_id: number | null;
}

export function AdminDashboard() {
  const { user } = useAuth();
  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newTagName, setNewTagName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);

  useEffect(() => {
    fetchTags();
  }, []);

  const fetchTags = async () => {
    setIsLoading(true);
    try {
      const res = await fetchWithAuth('/videogames/tags');
      if (res.ok) {
        const data: Tag[] = await res.json();
        // Filter only global tags
        setTags(data.filter(t => t.user_id === null));
      }
    } catch (err) {
      console.error('Failed to fetch tags', err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddTag = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTagName.trim()) return;

    setIsSubmitting(true);
    try {
      const res = await fetchWithAuth('/videogames/tags/global', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTagName.trim() })
      });
      
      if (res.ok) {
        const newTag = await res.json();
        setTags([...tags, newTag]);
        setNewTagName('');
      } else {
        alert('Failed to add tag. You might not have permission.');
      }
    } catch (err) {
      console.error(err);
      alert('Error adding tag');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteTag = async (id: number) => {
    if (!window.confirm("Are you sure you want to delete this global tag? It may affect existing users' games.")) return;
    
    try {
      const res = await fetchWithAuth(`/videogames/tags/${id}`, {
        method: 'DELETE'
      });
      
      if (res.ok) {
        setTags(tags.filter(t => t.id !== id));
      } else {
        alert('Failed to delete tag. You might not have permission.');
      }
    } catch (err) {
      console.error(err);
      alert('Error deleting tag');
    }
  };

  const handleMigratePlaytime = async () => {
    if (!window.confirm("Are you sure you want to run the AI migration for playtime? This might take a while if there are many games.")) return;
    
    setIsMigrating(true);
    try {
      const res = await fetchWithAuth('/videogames/admin/migrate-playtime', {
        method: 'POST'
      });
      
      const data = await res.json();
      if (res.ok) {
        alert(data.message + ". Games migrated: " + data.migrated);
      } else {
        alert('Migration failed: ' + data.detail);
      }
    } catch (err) {
      console.error(err);
      alert('Error during migration');
    } finally {
      setIsMigrating(false);
    }
  };

  // Restrict access to admin only
  if (user && !user.is_admin) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="container dashboard-hub">
      <div style={{ marginBottom: '1.5rem' }}>
        <Link to="/dashboard/videogames" className="btn btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem' }}>
          <ArrowLeft size={18} />
          Back to Tracker
        </Link>
      </div>

      <header className="hub-header" style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <Shield size={40} className="text-primary" />
        <div>
          <h1 className="text-gradient">Admin Dashboard</h1>
          <p className="text-secondary">Manage global application settings</p>
        </div>
      </header>

      <div style={{ maxWidth: '600px', marginTop: '2rem', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        <div className="glass-card" style={{ padding: '2rem' }}>
          <h2 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Data Management
          </h2>
          <p className="text-secondary" style={{ marginBottom: '1.5rem' }}>
            Use AI to intelligently parse legacy string "time spent" entries into numeric playtime hours.
          </p>
          <button 
            className="btn btn-primary" 
            onClick={handleMigratePlaytime}
            disabled={isMigrating}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {isMigrating ? <><Loader2 size={18} className="spinner" /> Migrating Data...</> : 'Migrate Playtime Data'}
          </button>
        </div>

        <div className="glass-card" style={{ padding: '2rem' }}>
          <h2 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            Global Tags Manager
          </h2>
          
          <form onSubmit={handleAddTag} style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
            <input 
              type="text" 
              className="form-input" 
              placeholder="New tag name (e.g., Action)" 
              value={newTagName}
              onChange={(e) => setNewTagName(e.target.value)}
              style={{ flex: 1 }}
            />
            <button 
              type="submit" 
              className="btn btn-primary" 
              disabled={!newTagName.trim() || isSubmitting}
            >
              {isSubmitting ? <Loader2 size={18} className="spinner" /> : <Plus size={18} />}
              Add Tag
            </button>
          </form>

          {isLoading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
              <Loader2 className="spinner" size={24} />
            </div>
          ) : tags.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {tags.map(tag => (
                <div key={tag.id} style={{ 
                  display: 'flex', 
                  justifyContent: 'space-between', 
                  alignItems: 'center',
                  padding: '1rem',
                  backgroundColor: 'var(--bg-secondary)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-color)'
                }}>
                  <span style={{ fontWeight: 500 }}>{tag.name}</span>
                  <button 
                    className="icon-btn delete-btn" 
                    onClick={() => handleDeleteTag(tag.id)} 
                    title="Delete Global Tag"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted">No global tags found.</p>
          )}
        </div>
      </div>
    </div>
  );
}
