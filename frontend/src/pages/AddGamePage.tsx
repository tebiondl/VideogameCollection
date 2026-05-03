import { useState, useRef, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Upload, Loader2, X, Check, Edit2, Search, Gamepad2, HelpCircle } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { SimilarGameModal } from '../components/SimilarGameModal';
import { TagMultiSelect } from '../components/TagMultiSelect';
import { CompletionDatePicker } from '../components/CompletionDatePicker';
import { DlcEditor } from '../components/DlcEditor';
import './AddGamePage.css';

const STATUS_OPTIONS = ['Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'];

interface FileConfig {
  filename: string;
  type: 'txt' | 'word' | 'csv' | 'excel' | 'unknown';
  prompt: string;
  has_named_columns?: boolean;
  read_independently?: boolean;
  sheets?: { name: string; selected: boolean; prompt: string }[];
}

export function AddGamePage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'search' | 'manual' | 'smart'>('manual');
  const [error, setError] = useState('');

  // -------------------------
  // 1. MANUAL ENTRY STATE
  // -------------------------
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [comments, setComments] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [status, setStatus] = useState(STATUS_OPTIONS[0]);
  const [timeSpent, setTimeSpent] = useState('');
  const [mark, setMark] = useState<number | ''>('');
  const [hype, setHype] = useState<number | ''>('');
  const [completionDate, setCompletionDate] = useState('');
  const [pubYear, setPubYear] = useState<number | ''>('');
  const [completionPercentage, setCompletionPercentage] = useState<number | ''>('');
  const [tags, setTags] = useState<string[]>([]);
  const [dlcs, setDlcs] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  // -------------------------
  // SEARCH TAB STATE (IGDB)
  // -------------------------
  const [igdbQuery, setIgdbQuery] = useState('');
  const [igdbResults, setIgdbResults] = useState<any[]>([]);
  const [igdbLoading, setIgdbLoading] = useState(false);
  const [igdbError, setIgdbError] = useState('');
  const [selectedIgdbGame, setSelectedIgdbGame] = useState<any>(null);
  // Fields filled by user after selecting a game from IGDB results
  const [igdbStatus, setIgdbStatus] = useState(STATUS_OPTIONS[0]);
  const [igdbMark, setIgdbMark] = useState<number | ''>('');
  const [igdbHype, setIgdbHype] = useState<number | ''>('');
  const [igdbTimeSpent, setIgdbTimeSpent] = useState('');
  const [igdbCompletionDate, setIgdbCompletionDate] = useState('');
  const [igdbCompletionPct, setIgdbCompletionPct] = useState<number | ''>('');
  const [igdbTags, setIgdbTags] = useState<string[]>([]);
  const [igdbDlcs, setIgdbDlcs] = useState('');
  const [igdbComments, setIgdbComments] = useState('');
  const igdbDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -------------------------
  // 2. SMART IMPORT STATE
  // -------------------------
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [fileConfigs, setFileConfigs] = useState<FileConfig[]>([]);
  const [smartSession, setSmartSession] = useState<any>(null); // holds status and parsing data
  const [isSmartUploading, setIsSmartUploading] = useState(false);

  // Editor Modal inside smart review
  const [editingItem, setEditingItem] = useState<any>(null); // The imported item we are editing
  const [similarGames, setSimilarGames] = useState<any[]>([]); // For fuzzy modal
  const [showFuzzyModal, setShowFuzzyModal] = useState(false);

  const [pollTrigger, setPollTrigger] = useState(0);

  const [availableTags, setAvailableTags] = useState<any[]>([]);

  useEffect(() => {
    const fetchTags = async () => {
      try {
        const res = await fetchWithAuth('/videogames/tags');
        if (res.ok) setAvailableTags(await res.json());
      } catch (err) {
        console.error("Failed to load tags");
      }
    };
    fetchTags();
  }, []);

  // IGDB: debounced search — fires 400 ms after user stops typing
  const runIgdbSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setIgdbResults([]); return; }
    setIgdbLoading(true);
    setIgdbError('');
    try {
      const res = await fetchWithAuth(`/igdb/search?q=${encodeURIComponent(q)}&limit=12`);
      if (res.ok) {
        setIgdbResults(await res.json());
      } else {
        setIgdbError('Search failed. Please try again.');
        setIgdbResults([]);
      }
    } catch {
      setIgdbError('Network error. Is the backend running?');
      setIgdbResults([]);
    } finally {
      setIgdbLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab !== 'search') return;
    if (igdbDebounceRef.current) clearTimeout(igdbDebounceRef.current);
    if (!igdbQuery.trim()) { setIgdbResults([]); return; }
    igdbDebounceRef.current = setTimeout(() => runIgdbSearch(igdbQuery), 400);
    return () => { if (igdbDebounceRef.current) clearTimeout(igdbDebounceRef.current); };
  }, [igdbQuery, activeTab, runIgdbSearch]);

  const handleSelectIgdbGame = (game: any) => {
    setSelectedIgdbGame(game);
    setIgdbStatus(STATUS_OPTIONS[0]);
    setIgdbMark('');
    setIgdbHype('');
    setIgdbTimeSpent('');
    setIgdbCompletionDate('');
    setIgdbCompletionPct('');
    setIgdbTags([]);
    setIgdbDlcs('');
    setIgdbComments('');
  };

  const handleIgdbAddGame = async () => {
    if (!selectedIgdbGame) return;
    setIsSubmitting(true);
    setError('');
    try {
      const matches = await checkSimilar(selectedIgdbGame.name);
      if (matches.length > 0) {
        setSimilarGames(matches);
        setShowFuzzyModal(true);
        setIsSubmitting(false);
        return;
      }
      const payload = {
        name: selectedIgdbGame.name,
        description: selectedIgdbGame.summary || null,
        comments: igdbComments || null,
        image_url: selectedIgdbGame.cover_url || null,
        status: igdbStatus,
        time_spent: igdbTimeSpent || null,
        mark: igdbMark !== '' ? igdbMark : null,
        hype: igdbHype !== '' ? igdbHype : null,
        completion_date: igdbCompletionDate || null,
        publication_year: selectedIgdbGame.release_year || null,
        completion_percentage: igdbCompletionPct !== '' ? igdbCompletionPct : null,
        tags: igdbTags.length > 0 ? igdbTags.join(',') : null,
        dlcs: igdbDlcs || null,
      };
      const res = await fetchWithAuth('/videogames/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Failed to save game');
      navigate('/dashboard/videogames');
    } catch (err: any) {
      setError(err.message);
      setIsSubmitting(false);
    }
  };

  // Poll for background task completion autonomously securely escaping React's equality skips
  useEffect(() => {
    let isMounted = true;
    let timeoutId: any;

    const pollSession = async () => {
      if (activeTab !== 'smart') return;
      try {
        const res = await fetchWithAuth('/smart-import/latest');
        if (res.ok) {
          const data = await res.json();
          if (isMounted) setSmartSession(data);

          if (data.status.startsWith('failed')) {
            if (isMounted) {
              setError("Smart Import Failed: " + data.status);
              setSmartSession(null);
            }
          } else if (data.status.startsWith('processing')) {
            timeoutId = setTimeout(pollSession, 2000);
          }
        }
      } catch (e) {
        console.error("Polling error", e);
      }
    };

    if (activeTab === 'smart') {
      pollSession();
    }

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
    };
  }, [activeTab, pollTrigger]);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selected = Array.from(e.target.files);
      if (files.length + selected.length > 10) {
        setError('Maximum 10 files allowed');
        return;
      }

      setFiles(prev => [...prev, ...selected]);

      const newConfigs: FileConfig[] = [];

      for (const file of selected) {
        let type: FileConfig['type'] = 'unknown';
        const nameLower = file.name.toLowerCase();
        if (nameLower.endsWith('.txt')) type = 'txt';
        else if (nameLower.endsWith('.doc') || nameLower.endsWith('.docx')) type = 'word';
        else if (nameLower.endsWith('.csv')) type = 'csv';
        else if (nameLower.endsWith('.xls') || nameLower.endsWith('.xlsx')) type = 'excel';

        let sheets: any[] = [];
        if (type === 'excel') {
          try {
            const fd = new FormData();
            fd.append('file', file);
            const res = await fetchWithAuth('/smart-import/excel-sheets', {
              method: 'POST',
              body: fd,
            });
            if (res.ok) {
              const data = await res.json();
              sheets = data.sheets.map((s: string) => ({ name: s, selected: true, prompt: '' }));
            }
          } catch (err) {
            console.error("Failed to fetch excel sheets", err);
          }
        }

        newConfigs.push({
          filename: file.name,
          type,
          prompt: '',
          has_named_columns: type === 'csv' ? true : undefined,
          read_independently: type === 'excel' ? false : undefined,
          sheets: type === 'excel' ? sheets : undefined
        });
      }

      setFileConfigs(prev => [...prev, ...newConfigs]);
    }
  };

  const removeFile = (idx: number) => {
    const fileToRemove = files[idx];
    setFiles(prev => prev.filter((_, i) => i !== idx));
    setFileConfigs(prev => prev.filter(c => c.filename !== fileToRemove.name));
  };

  const updateConfig = (idx: number, updates: Partial<FileConfig>) => {
    setFileConfigs(prev => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], ...updates };
      return copy;
    });
  };

  const startSmartImport = async (e: React.FormEvent) => {
    e.preventDefault();
    if (files.length === 0) {
      setError('Please attach at least one file.');
      return;
    }

    setError('');
    setIsSmartUploading(true);

    const formData = new FormData();
    formData.append('config', JSON.stringify(fileConfigs));
    files.forEach(f => formData.append('files', f));

    try {
      const res = await fetchWithAuth('/smart-import/', {
        method: 'POST',
        body: formData,
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      setSmartSession(data);
      setPollTrigger(p => p + 1); // Kick off resilient autonomous polling sequence
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsSmartUploading(false);
    }
  };

  const updateSmartItemStatus = async (item: any, newStatus: string) => {
    try {
      await fetchWithAuth(`/smart-import/items/${item.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...item, review_status: newStatus })
      });
      // Updating UI optimistically
      setSmartSession((prev: any) => ({
        ...prev,
        items: prev.items.map((i: any) => i.id === item.id ? { ...i, review_status: newStatus } : i)
      }));
    } catch (err) {
      console.error(err);
    }
  };

  const setAllItemsStatus = async (status: 'accepted' | 'rejected') => {
    if (!smartSession?.items) return;
    setError('');
    // Immediate optimistic update for perfect responsivenes
    setSmartSession((prev: any) => ({
      ...prev,
      items: prev.items.map((i: any) => ({ ...i, review_status: status }))
    }));
    try {
      const res = await fetchWithAuth(`/smart-import/sessions/${smartSession.id}/bulk-status`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status })
      });
      if (!res.ok) throw new Error("Server rejected bulk update");
    } catch (err: any) {
      setError("Bulk action failed: " + err.message);
    }
  };

  const commitSmartImport = async () => {
    if (!smartSession) return;
    try {
      const res = await fetchWithAuth(`/smart-import/commit/${smartSession.id}`, { method: 'POST' });
      if (res.ok) {
        navigate('/dashboard/videogames');
      } else {
        setError("Failed to commit array to database");
      }
    } catch (e: any) {
      setError(e.message);
    }
  };


  // -------------------------
  // 3. EDITING / FUZZY MODAL LOGIC (Shared conceptually but targeted depending on Manual vs Smart)
  // -------------------------
  const checkSimilar = async (targetName: string) => {
    const checkRes = await fetchWithAuth('/videogames/check-similar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: targetName })
    });
    return checkRes.ok ? await checkRes.json() : [];
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setError('');
    setIsSubmitting(true);

    try {
      const matches = await checkSimilar(name);
      if (matches.length > 0) {
        setSimilarGames(matches);
        setShowFuzzyModal(true);
        setIsSubmitting(false);
        return;
      }
      // Safe to save
      await saveManualItem();
    } catch (err: any) {
      setError(err.message);
      setIsSubmitting(false);
    }
  };

  const saveManualItem = async () => {
    setIsSubmitting(true);
    try {
      const payload = {
        name, description: description || null, comments: comments || null, image_url: imageUrl || null,
        status, time_spent: timeSpent || null,
        mark: mark !== '' ? mark : null,
        hype: hype !== '' ? hype : null,
        completion_date: completionDate || null, publication_year: pubYear !== '' ? pubYear : null,
        completion_percentage: completionPercentage !== '' ? completionPercentage : null,
        tags: tags.length > 0 ? tags.join(',') : null,
        dlcs: dlcs || null,
      };

      const res = await fetchWithAuth('/videogames/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to save game');
      navigate('/dashboard/videogames');
    } catch (err: any) {
      setError(err.message);
      setIsSubmitting(false);
    }
  };

  // Used for updating an active item (Manual or Smart Item editing existing game)
  const performUpdateNativeData = async (gameId: number) => {
    setIsSubmitting(true);
    setShowFuzzyModal(false);
    try {
      // If we were editing a SmartItem we apply the editingItem fields. If manual, we apply manual fields.
      const payload = editingItem ? {
        name: editingItem.name, description: editingItem.description || null, comments: editingItem.comments || null, image_url: editingItem.image_url || null,
        status: editingItem.status, time_spent: editingItem.time_spent || null,
        mark: editingItem.mark !== '' ? editingItem.mark : null,
        hype: editingItem.hype !== '' ? editingItem.hype : null,
        completion_date: editingItem.completion_date || null, publication_year: editingItem.publication_year !== '' ? editingItem.publication_year : null,
        completion_percentage: editingItem.completion_percentage ?? null,
        tags: editingItem.tags || null,
        dlcs: editingItem.dlcs || null,
      } : {
        name, description: description || null, comments: comments || null, image_url: imageUrl || null,
        status, time_spent: timeSpent || null,
        mark: mark !== '' ? mark : null,
        hype: hype !== '' ? hype : null,
        completion_date: completionDate || null, publication_year: pubYear !== '' ? pubYear : null,
        completion_percentage: completionPercentage !== '' ? completionPercentage : null,
        tags: tags.length > 0 ? tags.join(',') : null,
        dlcs: dlcs || null,
      };

      const res = await fetchWithAuth(`/videogames/${gameId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error('Failed to update game');
      navigate('/dashboard/videogames');
    } catch (err: any) {
      setError(err.message);
      setIsSubmitting(false);
    }
  };

  // For saving a smart item edit back to the smart session item queue
  const saveSmartEdit = async () => {
    try {
      await fetchWithAuth(`/smart-import/items/${editingItem.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...editingItem,
          review_status: 'accepted'
        })
      });

      setSmartSession((prev: any) => ({
        ...prev,
        items: prev.items.map((i: any) => i.id === editingItem.id ? { ...editingItem, review_status: 'accepted' } : i)
      }));
      setEditingItem(null);
    } catch (err) {
      console.error(err);
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
        <h1>Add a new game to your Tracker</h1>

        <div className="tabs-container">
          <button className={`tab-btn ${activeTab === 'search' ? 'active' : ''}`} onClick={() => setActiveTab('search')}>
            Search Online
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

      {/* ------------------------------- */}
      {/* MANUAL TAB */}
      {/* ------------------------------- */}
      {activeTab === 'manual' && (
        <form onSubmit={handleManualSubmit} className="glass-card add-form">
          <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '1.5rem' }}>
            <div className="info-tooltip-container">
              <HelpCircle size={18} />
              <div className="tooltip-text">
                <strong>Game Data</strong> (Neutral background) contains general info about the game.<br/><br/>
                <strong>User Data</strong> (Blue background) contains your personal progress, review, and tags.
              </div>
            </div>
          </div>

          <div className="data-section-game">
            <h3 className="section-title">Game Data</h3>
            
            <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <div style={{ flexShrink: 0, width: '120px', height: '160px', borderRadius: 'var(--radius-md)', overflow: 'hidden', backgroundColor: 'var(--bg-tertiary)', border: '1px solid var(--border-color)' }}>
                {imageUrl ? (
                  <img src={imageUrl} alt="Cover Preview" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No Cover</div>
                )}
              </div>
              
              <div style={{ flex: 1, minWidth: '250px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Game Name *</label>
                  <input type="text" className="form-input" required value={name} onChange={e => setName(e.target.value)} />
                </div>
                <div className="form-group" style={{ margin: 0 }}>
                  <label className="form-label">Image Cover URL</label>
                  <input type="url" className="form-input" placeholder="https://..." value={imageUrl} onChange={e => setImageUrl(e.target.value)} />
                </div>
              </div>
            </div>

            <div className="form-group">
              <label className="form-label">Description</label>
              <textarea className="form-input" rows={3} value={description} onChange={e => setDescription(e.target.value)} />
            </div>

            <div className="form-group">
              <label className="form-label">Publication Year</label>
              <input type="number" min="1950" max="2100" className="form-input" placeholder="YYYY" value={pubYear} onChange={e => setPubYear(e.target.value ? Number(e.target.value) : '')} />
            </div>

            <div className="form-group">
              <label className="form-label">DLCs</label>
              <DlcEditor value={dlcs} onChange={setDlcs} />
            </div>
          </div>

          <div className="data-section-user">
            <h3 className="section-title">User Data</h3>
            <div className="form-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Status</label>
                <select className="form-input" value={status} onChange={e => setStatus(e.target.value)}>
                  {STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </div>
              {(status === 'Stopped' || status === 'Finished') && (
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Completion %</label>
                  <select className="form-input" value={completionPercentage} onChange={e => setCompletionPercentage(e.target.value ? Number(e.target.value) : '')}>
                    <option value="">--</option>
                    {[...Array(11)].map((_, i) => <option key={i * 10} value={i * 10}>{i * 10}%</option>)}
                  </select>
                </div>
              )}
              {(status === 'Finished' || status === 'Stopped') ? (
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Your Rating (1-10)</label>
                  <input type="number" min="1" max="10" className="form-input" value={mark} onChange={e => setMark(e.target.value ? Number(e.target.value) : '')} />
                </div>
              ) : (
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Hype (1-10)</label>
                  <input type="number" min="1" max="10" className="form-input" placeholder="Your anticipation…" value={hype} onChange={e => setHype(e.target.value ? Number(e.target.value) : '')} />
                </div>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">Time Spent</label>
              <input type="text" className="form-input" placeholder="e.g. 50 hrs" value={timeSpent} onChange={e => setTimeSpent(e.target.value)} />
            </div>

            {(status === 'Finished' || status === 'Stopped') && (
              <div className="form-group">
                <label className="form-label">Completion Date</label>
                <CompletionDatePicker value={completionDate} onChange={setCompletionDate} />
              </div>
            )}

            <div className="form-group">
              <label className="form-label">Comments / Review</label>
              <textarea className="form-input" rows={3} value={comments} onChange={e => setComments(e.target.value)} />
            </div>

            <div className="form-group">
              <label className="form-label">Tags</label>
              <TagMultiSelect
                availableTags={availableTags}
                selectedTagsString={tags.join(', ')}
                onChange={(newTagsStr) => setTags(newTagsStr ? newTagsStr.split(',').map(s => s.trim()) : [])}
              />
            </div>
          </div>

          <div className="form-actions" style={{ marginTop: '2rem', display: 'flex', justifyContent: 'flex-end' }}>
            <button type="submit" className="btn btn-primary" disabled={isSubmitting || !name.trim()}>
              {isSubmitting ? 'Processing...' : 'Save Game'}
            </button>
          </div>
        </form>
      )}

      {/* ------------------------------- */}
      {/* SMART TAB (Upload vs Processing vs Review) */}
      {/* ------------------------------- */}
      {activeTab === 'smart' && (
        <div className="smart-import-section">
          {(!smartSession || smartSession.status.startsWith('failed') || smartSession.status === 'completed') && (
            <div className="glass-card add-form">
              <h2 style={{ marginBottom: '1rem', color: 'var(--text-primary)' }}>AI Smart Importer</h2>
              <p className="text-secondary" style={{ marginBottom: '2rem' }}>
                Upload your excel spreadsheets, text files, or note summaries. Then instruct the AI on how to read the data format.
              </p>

              <div
                className="dropzone"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  type="file"
                  multiple
                  hidden
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept=".csv,.xlsx,.xls,.txt,.doc,.docx"
                />
                <Upload size={32} color="var(--accent-primary)" style={{ marginBottom: '1rem' }} />
                <h3>Click or drag to attach files</h3>
                <p className="text-muted">Maximum 10 files (.xlsx, .csv, .txt, .docx)</p>
              </div>

              {files.length > 0 && (
                <div className="attached-files-configs" style={{ marginTop: '2rem' }}>
                  <h3 style={{ marginBottom: '1rem' }}>File Configuration</h3>
                  {fileConfigs.map((config, idx) => {
                    if (config.type === 'unknown') return null;
                    return (
                      <div key={idx} className="glass-card" style={{ padding: '1.5rem', marginBottom: '1.5rem', background: 'var(--bg-tertiary)' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <h4 style={{ color: 'var(--accent-primary)' }}>{config.filename} <span className="badge" style={{ marginLeft: '0.5rem' }}>{config.type}</span></h4>
                          <button className="icon-btn delete" onClick={() => removeFile(idx)}><X size={16} /></button>
                        </div>

                        {config.type === 'excel' && (
                          <>
                            <div className="form-group" style={{ marginTop: '1.5rem' }}>
                              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                                <input
                                  type="checkbox"
                                  checked={config.read_independently}
                                  onChange={(e) => updateConfig(idx, { read_independently: e.target.checked })}
                                  style={{ accentColor: 'var(--accent-primary)', width: '16px', height: '16px' }}
                                />
                                Read sheets independently (one by one)
                              </label>
                            </div>

                            {!config.read_independently && (
                              <div className="form-group">
                                <label className="form-label">Global Explanation for this Excel (Optional)</label>
                                <textarea className="form-input" rows={2} placeholder="e.g. Extract the columns containing standard game properties..." value={config.prompt} onChange={e => updateConfig(idx, { prompt: e.target.value })} />
                              </div>
                            )}

                            <div className="form-group">
                              <label className="form-label">Select Sheets to Process</label>
                              {config.sheets && config.sheets.length === 0 && <span className="text-muted" style={{ fontSize: '0.85rem' }}>Loading sheets...</span>}
                              {config.sheets?.map((s, sIdx) => (
                                <div key={s.name} style={{ display: 'flex', gap: '1rem', marginBottom: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                                  <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: '150px', cursor: 'pointer', margin: 0 }}>
                                    <input
                                      type="checkbox"
                                      checked={s.selected}
                                      onChange={(e) => {
                                        const newSheets = [...config.sheets!];
                                        newSheets[sIdx].selected = e.target.checked;
                                        updateConfig(idx, { sheets: newSheets });
                                      }}
                                      style={{ accentColor: 'var(--accent-primary)', width: '16px', height: '16px' }}
                                    />
                                    <span style={{ color: s.selected ? 'inherit' : 'var(--text-muted)' }}>{s.name}</span>
                                  </label>
                                  {config.read_independently && s.selected && (
                                    <div style={{ flex: 1, minWidth: '200px' }}>
                                      <input
                                        type="text"
                                        className="form-input"
                                        placeholder={`Specific explanation for '${s.name}' (optional)`}
                                        value={s.prompt}
                                        onChange={(e) => {
                                          const newSheets = [...config.sheets!];
                                          newSheets[sIdx].prompt = e.target.value;
                                          updateConfig(idx, { sheets: newSheets });
                                        }}
                                        style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem' }}
                                      />
                                    </div>
                                  )}
                                </div>
                              ))}
                            </div>
                          </>
                        )}

                        {config.type === 'csv' && (
                          <>
                            <div className="form-group" style={{ marginTop: '1.5rem' }}>
                              <label className="form-label" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                                <input
                                  type="checkbox"
                                  checked={config.has_named_columns}
                                  onChange={(e) => updateConfig(idx, { has_named_columns: e.target.checked })}
                                  style={{ accentColor: 'var(--accent-primary)', width: '16px', height: '16px' }}
                                />
                                File has named columns
                              </label>
                            </div>
                            <div className="form-group">
                              <label className="form-label">Explanation / Prompt (Optional)</label>
                              <textarea className="form-input" rows={2} placeholder="Explain how to parse this CSV..." value={config.prompt} onChange={e => updateConfig(idx, { prompt: e.target.value })} />
                            </div>
                          </>
                        )}

                        {(config.type === 'txt' || config.type === 'word') && (
                          <div className="form-group" style={{ marginTop: '1.5rem' }}>
                            <label className="form-label">Explanation / Prompt (Optional)</label>
                            <textarea className="form-input" rows={2} placeholder={`Explain the structure of this ${config.type}...`} value={config.prompt} onChange={e => updateConfig(idx, { prompt: e.target.value })} />
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}

              <div className="form-actions" style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--border-color)', paddingTop: '1.5rem' }}>
                <button onClick={startSmartImport} className="btn btn-primary" disabled={files.length === 0 || isSmartUploading}>
                  {isSmartUploading ? 'Uploading...' : 'Read & Extract games'}
                </button>
              </div>
            </div>
          )}

          {smartSession?.status?.startsWith('processing') && (
            <div className="glass-card text-center" style={{ padding: '3rem 2rem' }}>
              <Loader2 className="spinner" size={48} color="var(--accent-primary)" style={{ margin: '0 auto 1.5rem auto' }} />
              <h2 className="text-gradient">AI is thinking...</h2>

              {(() => {
                let chunkText = "";
                let streamText = "";
                if (smartSession.status.startsWith('processing|')) {
                  const parts = smartSession.status.split('|');
                  chunkText = parts.length > 1 ? `(File chunk ${parts[1]})` : "";
                  streamText = parts.length > 2 ? parts.slice(2).join('|') : "";
                } else {
                  chunkText = smartSession.status.replace('processing: ', '');
                }

                return (
                  <>
                    {chunkText && (
                      <p className="text-accent" style={{ fontWeight: 'bold', fontSize: '1.1rem', marginTop: '1rem', color: 'var(--accent-primary)' }}>
                        {chunkText}
                      </p>
                    )}
                    {streamText && (
                      <div style={{
                        marginTop: '1.5rem', padding: '1rem', background: '#0a0a0a',
                        border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
                        textAlign: 'left', height: '250px', overflowY: 'auto',
                        fontFamily: 'monospace', fontSize: '0.85rem', color: '#a0a0a0',
                        whiteSpace: 'pre-wrap', lineHeight: '1.5'
                      }}>
                        {streamText}
                      </div>
                    )}
                  </>
                );
              })()}

              <p className="text-secondary" style={{ marginTop: '1.5rem', maxWidth: '400px', margin: '1.5rem auto 0 auto' }}>
                This is running safely in the background. You can leave this page or disconnect safely. We will keep your results paused right here for you.
              </p>
            </div>
          )}

          {smartSession?.status === 'pending_review' && (
            <div className="review-section">
              <div className="review-header glass-card">
                <div>
                  <h2>Review Extracted Data</h2>
                  <p className="text-secondary">Please check the items below. Accept or Reject the AI's findings.</p>
                </div>
                <div className="review-global-actions" style={{ display: 'flex', gap: '0.75rem' }}>
                  <button className="btn btn-secondary" onClick={() => setAllItemsStatus('accepted')} >
                    Accept All
                  </button>
                  <button className="btn btn-ghost" onClick={() => setAllItemsStatus('rejected')} style={{ color: 'var(--error-color)' }}>
                    Reject All
                  </button>
                  <button className="btn btn-primary" onClick={commitSmartImport}>
                    Commit Accepted to Tracker
                  </button>
                </div>
              </div>

              <div className="review-list">
                {smartSession.items.map((item: any) => (
                  <div key={item.id} className={`review-card glass-card status-${item.review_status}`}>
                    <div className="rc-info">
                      <div className="rc-title-row">
                        <h3>{item.name}</h3>
                        <span className="badge">{item.status}</span>
                        {item.mark && <span className="badge">⭐ {item.mark}/10</span>}
                      </div>
                      <p className="text-muted rc-desc">{item.description}</p>
                    </div>
                    <div className="rc-actions">
                      {item.review_status !== 'accepted' && (
                        <button className="icon-btn accept" onClick={() => updateSmartItemStatus(item, 'accepted')} title="Accept"><Check size={20} /></button>
                      )}
                      {item.review_status !== 'rejected' && (
                        <button className="icon-btn reject" onClick={() => updateSmartItemStatus(item, 'rejected')} title="Reject"><X size={20} /></button>
                      )}
                      <button className="icon-btn edit" onClick={() => setEditingItem(item)} title="Edit"><Edit2 size={18} /></button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------- */}
      {/* SEARCH TAB — IGDB Integration   */}
      {/* ------------------------------- */}
      {activeTab === 'search' && (
        <div className="igdb-search-section">
          {/* Search bar */}
          <div className="glass-card igdb-search-bar">
            <div className="igdb-search-input-wrap">
              <Search size={20} className="igdb-search-icon" />
              <input
                id="igdb-search-input"
                type="text"
                className="form-input igdb-search-input"
                placeholder="Search for a game online…"
                value={igdbQuery}
                onChange={e => setIgdbQuery(e.target.value)}
                autoFocus
              />
              {igdbLoading && <Loader2 size={18} className="spinner igdb-spinner" />}
              {igdbQuery && !igdbLoading && (
                <button className="igdb-clear-btn" onClick={() => { setIgdbQuery(''); setIgdbResults([]); setSelectedIgdbGame(null); }} title="Clear">
                  <X size={16} />
                </button>
              )}
            </div>
            {igdbError && <p className="igdb-error">{igdbError}</p>}
          </div>

          {/* Results grid — shown when no game is selected */}
          {!selectedIgdbGame && igdbResults.length > 0 && (
            <div className="igdb-results-grid">
              {igdbResults.map(game => (
                <button
                  key={game.igdb_id}
                  className="igdb-result-card glass-card"
                  onClick={() => handleSelectIgdbGame(game)}
                >
                  <div className="igdb-cover-wrap">
                    {game.cover_url ? (
                      <img src={game.cover_url} alt={game.name} className="igdb-cover" />
                    ) : (
                      <div className="igdb-cover igdb-no-cover">
                        <Gamepad2 size={32} color="var(--text-muted)" />
                      </div>
                    )}
                  </div>
                  <div className="igdb-card-info">
                    <h4 className="igdb-card-title">{game.name}</h4>
                    {game.release_year && (
                      <span className="igdb-card-year">{game.release_year}</span>
                    )}
                    {game.genres?.length > 0 && (
                      <div className="igdb-card-genres">
                        {game.genres.slice(0, 2).map((g: string) => (
                          <span key={g} className="badge igdb-genre-badge">{g}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          )}

          {/* Empty state */}
          {!selectedIgdbGame && igdbResults.length === 0 && !igdbLoading && (
            <div className="igdb-empty-state glass-card">
              <Gamepad2 size={48} color="var(--text-muted)" style={{ marginBottom: '1rem' }} />
              <h3 style={{ color: 'var(--text-muted)' }}>
                {igdbQuery ? 'No games found' : 'Start typing to search online'}
              </h3>
              <p className="text-secondary" style={{ marginTop: '0.5rem' }}>
                {igdbQuery
                  ? 'Try a different title or check the spelling'
                  : 'Powered by online databases'}
              </p>
            </div>
          )}

          {/* Configure & Add panel — shown after selecting a game */}
          {selectedIgdbGame && (
            <div className="igdb-detail-panel glass-card">
              {/* Back to results */}
              <button
                className="btn btn-ghost igdb-back-btn"
                onClick={() => setSelectedIgdbGame(null)}
                style={{ marginBottom: '1.5rem', padding: '0.4rem 0' }}
              >
                <ArrowLeft size={16} /> Back to results
              </button>

              <div className="igdb-detail-header">
                {/* Cover */}
                <div className="igdb-detail-cover-wrap">
                  {selectedIgdbGame.cover_url ? (
                    <img src={selectedIgdbGame.cover_url} alt={selectedIgdbGame.name} className="igdb-detail-cover" />
                  ) : (
                    <div className="igdb-detail-cover igdb-no-cover">
                      <Gamepad2 size={48} color="var(--text-muted)" />
                    </div>
                  )}
                </div>
                {/* Meta */}
                <div className="igdb-detail-meta">
                  <h2 style={{ color: 'var(--text-primary)' }}>{selectedIgdbGame.name}</h2>
                  {selectedIgdbGame.release_year && (
                    <span className="badge" style={{ marginTop: '0.5rem', display: 'inline-block' }}>
                      {selectedIgdbGame.release_year}
                    </span>
                  )}
                  {selectedIgdbGame.genres?.length > 0 && (
                    <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                      {selectedIgdbGame.genres.map((g: string) => (
                        <span key={g} className="badge igdb-genre-badge">{g}</span>
                      ))}
                    </div>
                  )}
                  {selectedIgdbGame.summary && (
                    <p className="text-secondary igdb-summary">{selectedIgdbGame.summary}</p>
                  )}
                </div>
              </div>

              <div className="igdb-config-divider" />

              <h3 style={{ marginBottom: '1.25rem', color: 'var(--text-primary)' }}>Your Play Details</h3>

              {/* Status + Rating/Hype row */}
              <div className="form-row">
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Status</label>
                  <select className="form-input" value={igdbStatus} onChange={e => setIgdbStatus(e.target.value)}>
                    {STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                  </select>
                </div>
                {(igdbStatus === 'Stopped' || igdbStatus === 'Finished') && (
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">Completion %</label>
                    <select className="form-input" value={igdbCompletionPct} onChange={e => setIgdbCompletionPct(e.target.value ? Number(e.target.value) : '')}>
                      <option value="">--</option>
                      {[...Array(11)].map((_, i) => <option key={i * 10} value={i * 10}>{i * 10}%</option>)}
                    </select>
                  </div>
                )}
                {(igdbStatus === 'Finished' || igdbStatus === 'Stopped') ? (
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">Your Rating (1-10)</label>
                    <input type="number" min="1" max="10" className="form-input" value={igdbMark} onChange={e => setIgdbMark(e.target.value ? Number(e.target.value) : '')} />
                  </div>
                ) : (
                  <div className="form-group" style={{ flex: 1 }}>
                    <label className="form-label">Hype (1-10)</label>
                    <input type="number" min="1" max="10" className="form-input" placeholder="Your anticipation…" value={igdbHype} onChange={e => setIgdbHype(e.target.value ? Number(e.target.value) : '')} />
                  </div>
                )}
              </div>

              {/* Time Spent */}
              <div className="form-group">
                <label className="form-label">Time Spent</label>
                <input type="text" className="form-input" placeholder="e.g. 50 hrs" value={igdbTimeSpent} onChange={e => setIgdbTimeSpent(e.target.value)} />
              </div>

              {/* Completion Date */}
              <div className="form-group">
                <label className="form-label">Completion Date</label>
                <CompletionDatePicker value={igdbCompletionDate} onChange={setIgdbCompletionDate} />
              </div>

              {/* DLCs */}
              <div className="form-group">
                <label className="form-label">DLCs</label>
                <DlcEditor value={igdbDlcs} onChange={setIgdbDlcs} />
              </div>

              {/* Tags */}
              <div className="form-group">
                <label className="form-label">Tags</label>
                <TagMultiSelect
                  availableTags={availableTags}
                  selectedTagsString={igdbTags.join(', ')}
                  onChange={newTagsStr => setIgdbTags(newTagsStr ? newTagsStr.split(',').map(s => s.trim()) : [])}
                />
              </div>

              {/* Action button */}
              <div className="form-actions" style={{ marginTop: '2rem', display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  className="btn btn-primary"
                  onClick={handleIgdbAddGame}
                  disabled={isSubmitting}
                >
                  {isSubmitting ? 'Saving…' : `Add "${selectedIgdbGame.name}" to Tracker`}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ------------------------------- */}
      {/* MODALS */}
      {/* ------------------------------- */}

      {/* 1. Standard Fuzzy Duplicate Modal */}
      {showFuzzyModal && !editingItem && (
        <SimilarGameModal
          matches={similarGames}
          onCancel={() => setShowFuzzyModal(false)}
          onSaveNew={() => {
            setShowFuzzyModal(false);
            saveManualItem();
          }}
          onUpdateExisting={performUpdateNativeData}
        />
      )}

      {/* 2. Embedded Smart Item Editor (Popup) */}
      {editingItem && (
        <div className="modal-overlay">
          <div className="glass-card modal-content editor-modal">
            <button className="modal-close" onClick={() => setEditingItem(null)}><X size={20} /></button>
            <h2 style={{ marginBottom: '1.5rem' }}>Edit Extracted Game</h2>

            <div className="form-group">
              <label className="form-label">Name</label>
              <input type="text" className="form-input" value={editingItem.name} onChange={e => setEditingItem({ ...editingItem, name: e.target.value })} />
            </div>

            <div className="form-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Status</label>
                <select className="form-input" value={editingItem.status} onChange={e => setEditingItem({ ...editingItem, status: e.target.value })}>
                  {STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </div>
              {(editingItem.status === 'Stopped' || editingItem.status === 'Finished') && (
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Completion %</label>
                  <select className="form-input" value={editingItem.completion_percentage ?? ''} onChange={e => setEditingItem({ ...editingItem, completion_percentage: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">--</option>
                    {[...Array(11)].map((_, i) => <option key={i * 10} value={i * 10}>{i * 10}%</option>)}
                  </select>
                </div>
              )}
              {(editingItem.status === 'Finished' || editingItem.status === 'Stopped') ? (
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Rating (1-10)</label>
                  <input type="number" min="1" max="10" className="form-input" value={editingItem.mark || ''} onChange={e => setEditingItem({ ...editingItem, mark: e.target.value ? Number(e.target.value) : '' })} />
                </div>
              ) : (
                <div className="form-group" style={{ flex: 1 }}>
                  <label className="form-label">Hype (1-10)</label>
                  <input type="number" min="1" max="10" className="form-input" placeholder="Your anticipation…" value={editingItem.hype || ''} onChange={e => setEditingItem({ ...editingItem, hype: e.target.value ? Number(e.target.value) : '' })} />
                </div>
              )}
            </div>

            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Tags</label>
              <TagMultiSelect
                availableTags={availableTags}
                selectedTagsString={editingItem.tags || ''}
                onChange={(newTags) => setEditingItem({ ...editingItem, tags: newTags })}
              />
            </div>

            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">Completion Date</label>
              <CompletionDatePicker
                value={editingItem.completion_date || ''}
                onChange={(val) => setEditingItem({ ...editingItem, completion_date: val })}
              />
            </div>

            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
              <label className="form-label">DLCs</label>
              <DlcEditor
                value={editingItem.dlcs || ''}
                onChange={(val) => setEditingItem({ ...editingItem, dlcs: val })}
              />
            </div>

            <div className="modal-actions" style={{ marginTop: '2rem' }}>
              <button className="btn btn-ghost" onClick={async () => {
                // Optional explicitly check Fuzzy Match during edit!
                const matches = await checkSimilar(editingItem.name);
                if (matches.length > 0) {
                  setSimilarGames(matches);
                  // Since we are already inside a modal hack, we trigger a stacked modal visibility
                  setShowFuzzyModal(true);
                } else {
                  saveSmartEdit();
                }
              }}>
                Verify & Save Edit
              </button>
            </div>

            {showFuzzyModal && (
              <div style={{ marginTop: '2rem', padding: '1.5rem', backgroundColor: 'var(--bg-tertiary)', borderRadius: 'var(--radius-md)' }}>
                <h4 className="text-error" style={{ marginBottom: '1rem' }}>Warning: Existing Games Detected!</h4>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {similarGames.map(g => (
                    <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span>{g.name} ({g.status})</span>
                      <button className="btn btn-secondary" style={{ padding: '0.4rem 1rem' }} onClick={() => performUpdateNativeData(g.id)}>
                        Overwrite existing Game
                      </button>
                    </div>
                  ))}
                  <button className="btn btn-primary" style={{ marginTop: '1rem' }} onClick={() => { setShowFuzzyModal(false); saveSmartEdit(); }}>
                    Save as duplicate nonetheless
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
