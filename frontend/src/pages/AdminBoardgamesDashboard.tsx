import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { Navigate, Link } from 'react-router-dom';
import { createPortal } from 'react-dom';
import { ArrowLeft, ArrowRightLeft, CalendarDays, Check, Dices, Edit2, Loader2, Plus, Shield, Tag as TagIcon, Trash2, UsersRound, X, AlertTriangle } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { PaginationSettingsAdmin } from '../components/PaginationSettingsAdmin';
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

interface Player {
  id: number;
  name: string;
  normalized_name: string;
  match_count: number;
}

interface PlayerUsageMatch {
  id: number;
  boardgame_id: number;
  game_name: string;
  played_date: string | null;
  mode: string;
  winner_name: string | null;
}

interface PlayerUsage {
  player: Player;
  matches: PlayerUsageMatch[];
}

export function AdminBoardgamesDashboard() {
  const { user } = useAuth();
  const [tags, setTags] = useState<Tag[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [newTagName, setNewTagName] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editingTagId, setEditingTagId] = useState<number | null>(null);
  const [editingTagName, setEditingTagName] = useState('');
  const [isSavingTag, setIsSavingTag] = useState(false);
  const [isCheckingUsage, setIsCheckingUsage] = useState<number | null>(null);
  const [tagUsage, setTagUsage] = useState<TagUsage | null>(null);
  const [replacementMode, setReplacementMode] = useState<'existing' | 'new'>('existing');
  const [replacementTagName, setReplacementTagName] = useState('');
  const [newReplacementTagName, setNewReplacementTagName] = useState('');
  const [isReassigning, setIsReassigning] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [isLoadingPlayers, setIsLoadingPlayers] = useState(true);
  const [editingPlayerId, setEditingPlayerId] = useState<number | null>(null);
  const [editingPlayerName, setEditingPlayerName] = useState('');
  const [isSavingPlayer, setIsSavingPlayer] = useState(false);
  const [isCheckingPlayer, setIsCheckingPlayer] = useState<number | null>(null);
  const [playerUsage, setPlayerUsage] = useState<PlayerUsage | null>(null);
  const [replacementPlayerId, setReplacementPlayerId] = useState<number | null>(null);
  const [isMergingPlayers, setIsMergingPlayers] = useState(false);
  

  useEffect(() => {
    fetchTags();
    fetchPlayers();
  }, []);

  async function fetchTags() {
    setIsLoading(true);
    try {
      const res = await fetchWithAuth('/boardgames/tags');
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
      const res = await fetchWithAuth('/boardgames/tags/global', {
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
  }

  const handleSaveTag = async (tag: Tag) => {
    const nextName = editingTagName.trim();
    if (!nextName || nextName === tag.name) {
      setEditingTagId(null);
      return;
    }
    setIsSavingTag(true);
    try {
      const res = await fetchWithAuth(`/boardgames/tags/${tag.id}`, {
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

  async function fetchPlayers() {
    setIsLoadingPlayers(true);
    try {
      const res = await fetchWithAuth('/boardgames/players');
      if (!res.ok) throw new Error('Failed to fetch players');
      setPlayers(await res.json());
    } catch (err) {
      console.error('Failed to fetch players', err);
    } finally {
      setIsLoadingPlayers(false);
    }
  }

  const deleteUnusedTag = async (tag: Tag) => {
    if (!window.confirm(`Delete the unused “${tag.name}” tag?`)) return;
    try {
      const res = await fetchWithAuth(`/boardgames/tags/${tag.id}`, { method: 'DELETE' });
      if (res.ok) setTags(current => current.filter(item => item.id !== tag.id));
      else {
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
      const res = await fetchWithAuth(`/boardgames/tags/${tag.id}/usage`);
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
    const replacementName = replacementMode === 'existing' ? replacementTagName : newReplacementTagName.trim();
    if (!replacementName) return;
    setIsReassigning(true);
    try {
      const res = await fetchWithAuth(`/boardgames/tags/${tagUsage.tag.id}/reassign`, {
        method: 'POST', body: JSON.stringify({ replacement_name: replacementName })
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

  const startEditingPlayer = (player: Player) => {
    setEditingPlayerId(player.id);
    setEditingPlayerName(player.name);
  };

  const handleSavePlayer = async (player: Player) => {
    const nextName = editingPlayerName.trim();
    if (!nextName || nextName === player.name) {
      setEditingPlayerId(null);
      return;
    }
    setIsSavingPlayer(true);
    try {
      const res = await fetchWithAuth(`/boardgames/players/${player.id}`, {
        method: 'PUT', body: JSON.stringify({ name: nextName })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'Failed to update player.');
      }
      const updated: Player = await res.json();
      setPlayers(current => current.map(item => item.id === updated.id ? updated : item).sort((a, b) => a.name.localeCompare(b.name)));
      setEditingPlayerId(null);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Error updating player');
    } finally {
      setIsSavingPlayer(false);
    }
  };

  const deleteUnusedPlayer = async (player: Player) => {
    if (!window.confirm(`Delete the unused player “${player.name}”?`)) return;
    const res = await fetchWithAuth(`/boardgames/players/${player.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.detail || 'Failed to delete player.');
    }
    setPlayers(current => current.filter(item => item.id !== player.id));
  };

  const handleDeletePlayer = async (player: Player) => {
    setIsCheckingPlayer(player.id);
    try {
      const res = await fetchWithAuth(`/boardgames/players/${player.id}/usage`);
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'Could not check this player’s matches.');
      }
      const usage: PlayerUsage = await res.json();
      if (usage.matches.length === 0) {
        await deleteUnusedPlayer(player);
        return;
      }
      setReplacementPlayerId(null);
      setPlayerUsage(usage);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Error checking player usage');
    } finally {
      setIsCheckingPlayer(null);
    }
  };

  const handleMergePlayer = async () => {
    if (!playerUsage || !replacementPlayerId) return;
    setIsMergingPlayers(true);
    try {
      const res = await fetchWithAuth(`/boardgames/players/${playerUsage.player.id}/merge`, {
        method: 'POST', body: JSON.stringify({ replacement_player_id: replacementPlayerId })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.detail || 'Failed to merge these players.');
      }
      await fetchPlayers();
      setPlayerUsage(null);
      setReplacementPlayerId(null);
    } catch (err) {
      console.error(err);
      alert(err instanceof Error ? err.message : 'Error merging players');
    } finally {
      setIsMergingPlayers(false);
    }
  };

  // Restrict access to admin only
  if (user && !user.is_admin) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <div className="container dashboard-hub">
      <div style={{ marginBottom: '1.5rem' }}>
        <Link to="/dashboard/boardgames" className="btn btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem' }}>
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

      <div style={{ maxWidth: '760px', margin: '2rem auto 0', display: 'flex', flexDirection: 'column', gap: '2rem' }}>
        <PaginationSettingsAdmin />

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
                  {editingTagId === tag.id ? (
                    <input className="form-input admin-tag-edit-input" value={editingTagName} onChange={event => setEditingTagName(event.target.value)} onKeyDown={event => {
                      if (event.key === 'Enter') handleSaveTag(tag);
                      if (event.key === 'Escape') setEditingTagId(null);
                    }} autoFocus />
                  ) : <span style={{ fontWeight: 500 }}>{tag.name}</span>}
                  <div className="admin-tag-actions">
                    {editingTagId === tag.id ? <>
                      <button className="admin-icon-button success" onClick={() => handleSaveTag(tag)} disabled={isSavingTag || !editingTagName.trim()} title="Save tag name">{isSavingTag ? <Loader2 size={18} className="spinner" /> : <Check size={18} />}</button>
                      <button className="admin-icon-button" onClick={() => setEditingTagId(null)} disabled={isSavingTag} title="Cancel editing"><X size={18} /></button>
                    </> : <>
                      <button className="admin-icon-button" onClick={() => startEditingTag(tag)} title="Edit global tag"><Edit2 size={18} /></button>
                      <button className="admin-icon-button danger" onClick={() => handleDeleteTag(tag)} disabled={isCheckingUsage === tag.id} title="Delete global tag">{isCheckingUsage === tag.id ? <Loader2 size={18} className="spinner" /> : <Trash2 size={18} />}</button>
                    </>}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-muted">No global tags found.</p>
          )}
        </div>

        <div className="glass-card admin-player-card">
          <div className="admin-section-heading">
            <div><h2><UsersRound size={22} /> Saved Players</h2><p className="text-secondary">Edit player names or merge duplicates without losing their match history.</p></div>
            <span>{players.length} players</span>
          </div>
          {isLoadingPlayers ? <div className="admin-list-loading"><Loader2 className="spinner" size={24} /></div> : players.length > 0 ? <div className="admin-player-list">
            {players.map(player => <div className="admin-player-row" key={player.id}>
              <div className="admin-player-avatar">{player.name.charAt(0).toUpperCase()}</div>
              <div className="admin-player-name">
                {editingPlayerId === player.id ? <input className="form-input admin-player-edit-input" value={editingPlayerName} onChange={event => setEditingPlayerName(event.target.value)} onKeyDown={event => {
                  if (event.key === 'Enter') handleSavePlayer(player);
                  if (event.key === 'Escape') setEditingPlayerId(null);
                }} autoFocus /> : <><strong>{player.name}</strong><small>{player.match_count} {player.match_count === 1 ? 'match' : 'matches'}</small></>}
              </div>
              <div className="admin-tag-actions">
                {editingPlayerId === player.id ? <>
                  <button className="admin-icon-button success" onClick={() => handleSavePlayer(player)} disabled={isSavingPlayer || !editingPlayerName.trim()} title="Save player name">{isSavingPlayer ? <Loader2 size={18} className="spinner" /> : <Check size={18} />}</button>
                  <button className="admin-icon-button" onClick={() => setEditingPlayerId(null)} disabled={isSavingPlayer} title="Cancel editing"><X size={18} /></button>
                </> : <>
                  <button className="admin-icon-button" onClick={() => startEditingPlayer(player)} title={`Edit ${player.name}`}><Edit2 size={18} /></button>
                  <button className="admin-icon-button danger" onClick={() => handleDeletePlayer(player)} disabled={isCheckingPlayer === player.id} title={`Delete or merge ${player.name}`}>{isCheckingPlayer === player.id ? <Loader2 size={18} className="spinner" /> : <Trash2 size={18} />}</button>
                </>}
              </div>
            </div>)}
          </div> : <p className="text-muted">No saved players yet. They will appear here after you add them to a match.</p>}
        </div>
      </div>
      {tagUsage && createPortal(
        <div className="admin-modal-backdrop" role="presentation" onMouseDown={() => !isReassigning && setTagUsage(null)}>
          <section className="admin-tag-modal" role="dialog" aria-modal="true" aria-labelledby="delete-boardgame-tag-title" onMouseDown={event => event.stopPropagation()}>
            <div className="admin-modal-header">
              <div className="admin-warning-icon"><AlertTriangle size={24} /></div>
              <div>
                <p className="admin-eyebrow">Tag in use</p>
                <h2 id="delete-boardgame-tag-title">Replace “{tagUsage.tag.name}” before deleting</h2>
                <p className="text-secondary">This tag is assigned to {tagUsage.games.length} {tagUsage.games.length === 1 ? 'board game' : 'board games'}. Choose one replacement for all of them.</p>
              </div>
              <button className="admin-modal-close" onClick={() => setTagUsage(null)} disabled={isReassigning} aria-label="Close"><X size={20} /></button>
            </div>
            <div className="admin-affected-games">
              {tagUsage.games.map(game => <div className="admin-affected-game" key={`${game.user_id}-${game.id}`}>
                {game.image_url ? <img src={game.image_url} alt="" /> : <div className="admin-game-placeholder"><Dices size={20} /></div>}
                <div><strong>{game.name}</strong><span>{game.username} · {game.status}</span></div>
              </div>)}
            </div>
            <div className="admin-replacement-panel">
              <div className="admin-mode-toggle">
                <button className={replacementMode === 'existing' ? 'active' : ''} onClick={() => setReplacementMode('existing')} disabled={tags.length <= 1}><TagIcon size={17} /> Existing tag</button>
                <button className={replacementMode === 'new' ? 'active' : ''} onClick={() => setReplacementMode('new')}><Plus size={17} /> Create new</button>
              </div>
              {replacementMode === 'existing' ? <select className="form-input" value={replacementTagName} onChange={event => setReplacementTagName(event.target.value)}>
                {tags.filter(item => item.id !== tagUsage.tag.id).map(item => <option key={item.id} value={item.name}>{item.name}</option>)}
              </select> : <input className="form-input" value={newReplacementTagName} onChange={event => setNewReplacementTagName(event.target.value)} placeholder="New replacement tag name" autoFocus />}
              <p className="admin-atomic-note">All affected games will be updated first, then the old tag will be deleted.</p>
            </div>
            <div className="admin-modal-actions">
              <button className="btn btn-secondary" onClick={() => setTagUsage(null)} disabled={isReassigning}>Cancel</button>
              <button className="btn btn-primary" onClick={handleReassignAndDelete} disabled={isReassigning || !(replacementMode === 'existing' ? replacementTagName : newReplacementTagName.trim())}>
                {isReassigning ? <Loader2 size={18} className="spinner" /> : <Check size={18} />} Reassign {tagUsage.games.length} and delete
              </button>
            </div>
          </section>
        </div>, document.body
      )}
      {playerUsage && createPortal(
        <div className="admin-modal-backdrop" role="presentation" onMouseDown={() => !isMergingPlayers && setPlayerUsage(null)}>
          <section className="admin-tag-modal admin-player-modal" role="dialog" aria-modal="true" aria-labelledby="merge-boardgame-player-title" onMouseDown={event => event.stopPropagation()}>
            <div className="admin-modal-header">
              <div className="admin-warning-icon"><ArrowRightLeft size={24} /></div>
              <div>
                <p className="admin-eyebrow">Player has match history</p>
                <h2 id="merge-boardgame-player-title">Merge “{playerUsage.player.name}” before deleting</h2>
                <p className="text-secondary">Choose the player who should inherit all {playerUsage.matches.length} {playerUsage.matches.length === 1 ? 'match' : 'matches'}.</p>
              </div>
              <button className="admin-modal-close" onClick={() => setPlayerUsage(null)} disabled={isMergingPlayers} aria-label="Close"><X size={20} /></button>
            </div>
            <div className="admin-affected-games admin-affected-matches">
              {playerUsage.matches.map(match => <div className="admin-affected-game" key={match.id}>
                <div className="admin-game-placeholder"><Dices size={20} /></div>
                <div><strong>{match.game_name}</strong><span><CalendarDays size={13} /> {match.played_date || 'Unknown date'} · {match.mode}</span></div>
              </div>)}
            </div>
            <div className="admin-replacement-panel">
              <label className="admin-player-replacement-label">Transfer matches to</label>
              <select className="form-input" value={replacementPlayerId ?? ''} onChange={event => setReplacementPlayerId(event.target.value ? Number(event.target.value) : null)}>
                <option value="">Choose another player…</option>
                {players.filter(player => player.id !== playerUsage.player.id).map(player => <option key={player.id} value={player.id}>{player.name} · {player.match_count} {player.match_count === 1 ? 'match' : 'matches'}</option>)}
              </select>
              <p className="admin-atomic-note">Every match will use the replacement player, duplicate links will be removed, and competitive wins will follow the replacement name.</p>
              {players.length <= 1 && <p className="admin-player-blocked-note">There is no other player to receive these matches yet.</p>}
            </div>
            <div className="admin-modal-actions">
              <button className="btn btn-secondary" onClick={() => setPlayerUsage(null)} disabled={isMergingPlayers}>Cancel</button>
              <button className="btn btn-primary" onClick={handleMergePlayer} disabled={isMergingPlayers || !replacementPlayerId}>
                {isMergingPlayers ? <Loader2 size={18} className="spinner" /> : <ArrowRightLeft size={18} />} Transfer matches and delete
              </button>
            </div>
          </section>
        </div>, document.body
      )}
    </div>
  );
}
