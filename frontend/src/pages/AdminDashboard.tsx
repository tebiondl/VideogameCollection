import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Navigate, Link, useLocation } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { Shield, Plus, Trash2, Loader2, ArrowLeft, Edit2, Check, X, AlertTriangle, Gamepad2, Tag as TagIcon } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import { DatabaseBackups } from '../components/DatabaseBackups';
import './DashboardPage.css'; // Reuse basic styles
import './AdminDashboard.css';

interface Tag {
  id: number;
  name: string;
  user_id: number | null;
}

interface TagUsageGame {
  id: number;
  name: string;
  user_id: number;
  username: string;
  image_url: string | null;
  status: string;
}

interface TagUsage {
  tag: Tag;
  games: TagUsageGame[];
}

export function AdminDashboard() {
  const { user } = useAuth();
  const { hash } = useLocation();
  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newTagName, setNewTagName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isMigrating, setIsMigrating] = useState(false);
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editingTagName, setEditingTagName] = useState('');
  const [isSavingTag, setIsSavingTag] = useState(false);
  const [isCheckingUsage, setIsCheckingUsage] = useState<number | null>(null);
  const [tagUsage, setTagUsage] = useState<TagUsage | null>(null);
  const [replacementMode, setReplacementMode] = useState<'existing' | 'new'>('existing');
  const [replacementTagName, setReplacementTagName] = useState('');
  const [newReplacementTagName, setNewReplacementTagName] = useState('');
  const [isReassigning, setIsReassigning] = useState(false);

  useEffect(() => {
    fetchTags();
  }, []);

  async function fetchTags() {
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
  }

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
        const data = await res.json().catch(() => null);
        alert(data?.detail || 'Failed to add tag. You might not have permission.');
      }
    } catch (err) {
      console.error(err);
      alert('Error adding tag');
    } finally {
      setIsSubmitting(false);
    }
  };

  const startEditingTag = (tag: Tag) => {
    setEditingTagId(tag.id);
    setEditingTagName(tag.name);
  };

  const handleSaveTag = async (tag: Tag) => {
    const nextName = editingTagName.trim();
    if (!nextName || nextName === tag.name) {
      setEditingTagId(null);
      return;
    }
    setIsSavingTag(true);
    try {
      const res = await fetchWithAuth(`/videogames/tags/${tag.id}`, {
        method: 'PUT',
        body: JSON.stringify({ name: nextName })
      });
      if (res.ok) {
        const updatedTag: Tag = await res.json();
        setTags(current => current.map(item => item.id === updatedTag.id ? updatedTag : item));
        setEditingTagId(null);
      } else {
        const data = await res.json().catch(() => null);
        alert(data?.detail || 'Failed to update tag.');
      }
    } catch (err) {
      console.error(err);
      alert('Error updating tag');
    } finally {
      setIsSavingTag(false);
    }
  };

  const deleteUnusedTag = async (tag: Tag) => {
    if (!window.confirm(`Delete the unused “${tag.name}” tag?`)) return;
    try {
      const res = await fetchWithAuth(`/videogames/tags/${tag.id}`, { method: 'DELETE' });
      if (res.ok) {
        setTags(current => current.filter(item => item.id !== tag.id));
      } else {
        const data = await res.json().catch(() => null);
        alert(data?.detail || 'Failed to delete tag.');
      }
    } catch (err) {
      console.error(err);
      alert('Error deleting tag');
    }
  };

  const handleDeleteTag = async (tag: Tag) => {
    setIsCheckingUsage(tag.id);
    try {
      const res = await fetchWithAuth(`/videogames/tags/${tag.id}/usage`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        alert(data?.detail || 'Could not check where this tag is used.');
        return;
      }
      const usage: TagUsage = await res.json();
      if (usage.games.length === 0) {
        await deleteUnusedTag(tag);
        return;
      }
      const firstReplacement = tags.find(item => item.id !== tag.id)?.name || '';
      setReplacementTagName(firstReplacement);
      setNewReplacementTagName('');
      setReplacementMode(firstReplacement ? 'existing' : 'new');
      setTagUsage(usage);
    } catch (err) {
      console.error(err);
      alert('Error checking tag usage');
    } finally {
      setIsCheckingUsage(null);
    }
  };

  const handleReassignAndDelete = async () => {
    if (!tagUsage) return;
    const replacementName = replacementMode === 'existing'
      ? replacementTagName
      : newReplacementTagName.trim();
    if (!replacementName) return;

    setIsReassigning(true);
    try {
      const res = await fetchWithAuth(`/videogames/tags/${tagUsage.tag.id}/reassign`, {
        method: 'POST',
        body: JSON.stringify({ replacement_name: replacementName })
      });
      if (res.ok) {
        await fetchTags();
        setTagUsage(null);
      } else {
        const data = await res.json().catch(() => null);
        alert(data?.detail || 'Failed to reassign games and delete the tag.');
      }
    } catch (err) {
      console.error(err);
      alert('Error reassigning tag');
    } finally {
      setIsReassigning(false);
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

  if (['#steam', '#copies', '#display'].includes(hash)) {
    return <Navigate to={`/dashboard/videogames/settings${hash}`} replace />;
  }

  // Restrict system administration to admins; personal settings have their own page.
  if (user && !user.is_admin) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="container vg-support-page">
      <div>
        <Link to="/dashboard/videogames" className="vg-back-link">
          <ArrowLeft size={18} />
          Back to Tracker
        </Link>
      </div>

      <VideogamePageHeader eyebrow="System administration" icon={<Shield />} title="Videogame Admin" description="Manage shared tags, database backups, and system maintenance tools." />

      <nav className="admin-jump-nav" aria-label="Admin sections">
        <a href="#tags">Tags</a>
        <a href="#maintenance">Maintenance</a>
      </nav>

      <div className="admin-settings-stack">
        <section id="tags" className="glass-card admin-anchor-section admin-standard-card">
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
                  {editingTagId === tag.id ? (
                    <input
                      className="form-input admin-tag-edit-input"
                      value={editingTagName}
                      onChange={event => setEditingTagName(event.target.value)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') handleSaveTag(tag);
                        if (event.key === 'Escape') setEditingTagId(null);
                      }}
                      autoFocus
                    />
                  ) : <span style={{ fontWeight: 500 }}>{tag.name}</span>}
                  <div className="admin-tag-actions">
                    {editingTagId === tag.id ? (
                      <>
                        <button className="admin-icon-button success" onClick={() => handleSaveTag(tag)} disabled={isSavingTag || !editingTagName.trim()} title="Save tag name">
                          {isSavingTag ? <Loader2 size={18} className="spinner" /> : <Check size={18} />}
                        </button>
                        <button className="admin-icon-button" onClick={() => setEditingTagId(null)} disabled={isSavingTag} title="Cancel editing">
                          <X size={18} />
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="admin-icon-button" onClick={() => startEditingTag(tag)} title="Edit global tag">
                          <Edit2 size={18} />
                        </button>
                        <button className="admin-icon-button danger" onClick={() => handleDeleteTag(tag)} disabled={isCheckingUsage === tag.id} title="Delete global tag">
                          {isCheckingUsage === tag.id ? <Loader2 size={18} className="spinner" /> : <Trash2 size={18} />}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted">No global tags found.</p>
          )}
        </section>

        <section id="maintenance" className="glass-card admin-anchor-section admin-standard-card">
          <DatabaseBackups />
          <details className="admin-legacy-tools"><summary>Legacy maintenance tools</summary><p className="text-secondary">Parse legacy string “time spent” entries into numeric playtime hours.</p><button className="btn btn-secondary" onClick={handleMigratePlaytime} disabled={isMigrating}>{isMigrating ? <><Loader2 size={18} className="spinner" /> Migrating Data...</> : 'Migrate Playtime Data'}</button></details>
        </section>
      </div>

      {tagUsage && createPortal(
        <div className="admin-modal-backdrop" role="presentation" onMouseDown={() => !isReassigning && setTagUsage(null)}>
          <section className="admin-tag-modal" role="dialog" aria-modal="true" aria-labelledby="delete-tag-title" onMouseDown={event => event.stopPropagation()}>
            <div className="admin-modal-header">
              <div className="admin-warning-icon"><AlertTriangle size={24} /></div>
              <div>
                <p className="admin-eyebrow">Tag in use</p>
                <h2 id="delete-tag-title">Replace “{tagUsage.tag.name}” before deleting</h2>
                <p className="text-secondary">This tag is assigned to {tagUsage.games.length} {tagUsage.games.length === 1 ? 'game' : 'games'}. Choose one replacement for all of them.</p>
              </div>
              <button className="admin-modal-close" onClick={() => setTagUsage(null)} disabled={isReassigning} aria-label="Close"><X size={20} /></button>
            </div>

            <div className="admin-affected-games">
              {tagUsage.games.map(game => (
                <div className="admin-affected-game" key={`${game.user_id}-${game.id}`}>
                  {game.image_url ? <img src={game.image_url} alt="" /> : <div className="admin-game-placeholder"><Gamepad2 size={20} /></div>}
                  <div>
                    <strong>{game.name}</strong>
                    <span>{game.username} · {game.status}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="admin-replacement-panel">
              <div className="admin-mode-toggle">
                <button className={replacementMode === 'existing' ? 'active' : ''} onClick={() => setReplacementMode('existing')} disabled={tags.length <= 1}>
                  <TagIcon size={17} /> Existing tag
                </button>
                <button className={replacementMode === 'new' ? 'active' : ''} onClick={() => setReplacementMode('new')}>
                  <Plus size={17} /> Create new
                </button>
              </div>
              {replacementMode === 'existing' ? (
                <select className="form-input" value={replacementTagName} onChange={event => setReplacementTagName(event.target.value)}>
                  {tags.filter(item => item.id !== tagUsage.tag.id).map(item => <option key={item.id} value={item.name}>{item.name}</option>)}
                </select>
              ) : (
                <input className="form-input" value={newReplacementTagName} onChange={event => setNewReplacementTagName(event.target.value)} placeholder="New replacement tag name" autoFocus />
              )}
              <p className="admin-atomic-note">All affected games will be updated first, then the old tag will be deleted.</p>
            </div>

            <div className="admin-modal-actions">
              <button className="btn btn-secondary" onClick={() => setTagUsage(null)} disabled={isReassigning}>Cancel</button>
              <button className="btn btn-primary" onClick={handleReassignAndDelete} disabled={isReassigning || !(replacementMode === 'existing' ? replacementTagName : newReplacementTagName.trim())}>
                {isReassigning ? <Loader2 size={18} className="spinner" /> : <Check size={18} />}
                Reassign {tagUsage.games.length} and delete
              </button>
            </div>
          </section>
        </div>,
        document.body
      )}
    </div>
  );
}
