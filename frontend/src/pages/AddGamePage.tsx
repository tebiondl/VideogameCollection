import { useState, useRef, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, Upload, Loader2, File as FileIcon, X, Check, Edit2 } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { SimilarGameModal } from '../components/SimilarGameModal';
import { TagMultiSelect } from '../components/TagMultiSelect';
import './AddGamePage.css';

const AVAILABLE_TAGS = ['Gacha', 'Online', 'Runs'];
const STATUS_OPTIONS = ['Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'];

export function AddGamePage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'search'|'manual'|'smart'>('manual');
  const [error, setError] = useState('');

  // -------------------------
  // 1. MANUAL ENTRY STATE
  // -------------------------
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [imageUrl, setImageUrl] = useState('');
  const [status, setStatus] = useState(STATUS_OPTIONS[0]);
  const [timeSpent, setTimeSpent] = useState('');
  const [mark, setMark] = useState<number | ''>('');
  const [completionDate, setCompletionDate] = useState('');
  const [pubYear, setPubYear] = useState<number | ''>('');
  const [tags, setTags] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const toggleTag = (tag: string) => setTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);

  // -------------------------
  // 2. SMART IMPORT STATE
  // -------------------------
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [smartPrompt, setSmartPrompt] = useState('');
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

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selected = Array.from(e.target.files);
      if (files.length + selected.length > 10) {
        setError('Maximum 10 files allowed');
        return;
      }
      setFiles(prev => [...prev, ...selected]);
    }
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
    formData.append('prompt', smartPrompt);
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
    try {
      const itemsToUpdate = smartSession.items.filter((i: any) => i.review_status !== status);
      for (const item of itemsToUpdate) {
        await fetchWithAuth(`/smart-import/items/${item.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...item, review_status: status })
        });
      }
      setSmartSession((prev: any) => ({
        ...prev,
        items: prev.items.map((i: any) => ({ ...i, review_status: status }))
      }));
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
        name, description: description || null, image_url: imageUrl || null,
        status, time_spent: timeSpent || null, mark: mark !== '' ? mark : null,
        completion_date: completionDate || null, publication_year: pubYear !== '' ? pubYear : null,
        tags: tags.length > 0 ? tags.join(',') : null
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
        name: editingItem.name, description: editingItem.description || null, image_url: editingItem.image_url || null,
        status: editingItem.status, time_spent: editingItem.time_spent || null, mark: editingItem.mark !== '' ? editingItem.mark : null,
        completion_date: editingItem.completion_date || null, publication_year: editingItem.publication_year !== '' ? editingItem.publication_year : null,
        tags: editingItem.tags || null
      } : {
        name, description: description || null, image_url: imageUrl || null,
        status, time_spent: timeSpent || null, mark: mark !== '' ? mark : null,
        completion_date: completionDate || null, publication_year: pubYear !== '' ? pubYear : null,
        tags: tags.length > 0 ? tags.join(',') : null
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

      {/* ------------------------------- */}
      {/* MANUAL TAB */}
      {/* ------------------------------- */}
      {activeTab === 'manual' && (
        <form onSubmit={handleManualSubmit} className="glass-card add-form">
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
            <TagMultiSelect 
              availableTags={availableTags} 
              selectedTagsString={tags.join(', ')} 
              onChange={(newTagsStr) => setTags(newTagsStr ? newTagsStr.split(',').map(s=>s.trim()) : [])} 
            />
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
              <h2 style={{ marginBottom: '1rem', color: 'var(--text-primary)' }}>AI Smart Importer (Kimi K2.5)</h2>
              <p className="text-secondary" style={{ marginBottom: '2rem' }}>
                Upload your excel spreadsheets, text files, or note summaries. Then instruct Kimi on how to read the data format.
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
                  accept=".csv,.xlsx,.xls,.txt"
                />
                <Upload size={32} color="var(--accent-primary)" style={{ marginBottom: '1rem' }} />
                <h3>Click or drag to attach files</h3>
                <p className="text-muted">Maximum 10 files (.xlsx, .csv, .txt)</p>
              </div>

              {files.length > 0 && (
                <div className="attached-files">
                  {files.map((f, i) => (
                     <div key={i} className="file-chip">
                        <FileIcon size={14} /> {f.name}
                        <button onClick={() => setFiles(files.filter((_, idx) => idx !== i))}><X size={14} /></button>
                     </div>
                  ))}
                </div>
              )}

              <div className="form-group" style={{ marginTop: '2rem' }}>
                <label className="form-label">Extraction Prompt</label>
                <textarea 
                  className="form-input" 
                  rows={4} 
                  placeholder="e.g. Columns are Title, Length, Score 1-10, and completion date. Extract my gacha game sessions specifically as 'Playing'."
                  value={smartPrompt}
                  onChange={e => setSmartPrompt(e.target.value)}
                />
              </div>

              <div className="form-actions" style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end' }}>
                 <button onClick={startSmartImport} className="btn btn-primary" disabled={files.length === 0 || isSmartUploading}>
                   {isSmartUploading ? 'Uploading...' : 'Read & Extract games'}
                 </button>
              </div>
            </div>
          )}

          {smartSession?.status?.startsWith('processing') && (
            <div className="glass-card text-center" style={{ padding: '3rem 2rem' }}>
              <Loader2 className="spinner" size={48} color="var(--accent-primary)" style={{ margin: '0 auto 1.5rem auto' }} />
              <h2 className="text-gradient">Kimi is thinking...</h2>
              
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
                  <p className="text-secondary">Please check the items below. Accept or Reject Kimi's findings.</p>
                </div>
                <div className="review-global-actions" style={{ display: 'flex', gap: '0.75rem' }}>
                  <button className="btn btn-secondary" onClick={() => setAllItemsStatus('accepted')} >
                    Accept All
                  </button>
                  <button className="btn btn-ghost" onClick={() => setAllItemsStatus('rejected')} style={{ color: 'var(--error-color)' }}>
                    Reject All
                  </button>
                  <button className="btn btn-primary" onClick={commitSmartImport}>
                    Commit Accepted to Vault
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
      {/* SEARCH TAB PLACEHOLDER */}
      {/* ------------------------------- */}
      {activeTab === 'search' && (
        <div className="glass-card text-center" style={{ padding: '4rem 2rem' }}>
          <h2 style={{ color: 'var(--text-muted)' }}>Feature Coming Soon</h2>
          <p className="text-secondary" style={{ marginTop: '0.5rem' }}>
            The API search function is still under development.
          </p>
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
            <button className="modal-close" onClick={() => setEditingItem(null)}><X size={20}/></button>
            <h2 style={{ marginBottom: '1.5rem' }}>Edit Extracted Game</h2>
            
            <div className="form-group">
               <label className="form-label">Name</label>
               <input type="text" className="form-input" value={editingItem.name} onChange={e => setEditingItem({...editingItem, name: e.target.value})}/>
            </div>

            <div className="form-row">
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Status</label>
                <select className="form-input" value={editingItem.status} onChange={e => setEditingItem({...editingItem, status: e.target.value})}>
                  {STATUS_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ flex: 1 }}>
                <label className="form-label">Rating</label>
                <input type="number" min="1" max="10" className="form-input" value={editingItem.mark || ''} onChange={e => setEditingItem({...editingItem, mark: e.target.value ? Number(e.target.value) : ''})} />
              </div>
            </div>

            <div className="form-group" style={{ gridColumn: '1 / -1' }}>
               <label className="form-label">Tags</label>
               <TagMultiSelect 
                  availableTags={availableTags}
                  selectedTagsString={editingItem.tags || ''}
                  onChange={(newTags) => setEditingItem({ ...editingItem, tags: newTags })}
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
