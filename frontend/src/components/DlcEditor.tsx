import { useState } from 'react';
import { Plus, X, Search, Loader2, Image as ImageIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { fetchWithAuth } from '../lib/api';

export type DlcState = 'not_owned' | 'not_started' | 'finished';

export interface Dlc {
  name: string;
  state: DlcState;
}

const STATE_CYCLE: DlcState[] = ['not_owned', 'not_started', 'finished'];
const STATE_LABELS: Record<DlcState, string> = {
  not_owned: 'Not Owned',
  not_started: 'Not Started',
  finished: 'Finished',
};
const STATE_COLORS: Record<DlcState, string> = {
  not_owned: 'var(--text-muted)',
  not_started: 'var(--accent-primary)',
  finished: '#4ade80',
};
const STATE_BG: Record<DlcState, string> = {
  not_owned: 'rgba(255,255,255,0.05)',
  not_started: 'rgba(139,92,246,0.15)',
  finished: 'rgba(74,222,128,0.12)',
};

function parseDlcs(value: string): Dlc[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {}
  return [];
}

interface Props {
  value: string; // JSON string
  onChange: (val: string) => void;
  gameName?: string;
}

export function DlcEditor({ value, onChange, gameName }: Props) {
  const dlcs = parseDlcs(value);
  const [newName, setNewName] = useState('');
  const [showIgdbModal, setShowIgdbModal] = useState(false);
  const [igdbDlcs, setIgdbDlcs] = useState<any[]>([]);
  const [isSearchingIgdb, setIsSearchingIgdb] = useState(false);
  const [igdbSearchQuery, setIgdbSearchQuery] = useState('');

  const emit = (updated: Dlc[]) => onChange(JSON.stringify(updated));

  const addDlc = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    emit([...dlcs, { name: trimmed, state: 'not_owned' }]);
    setNewName('');
  };

  const removeDlc = (idx: number) => {
    emit(dlcs.filter((_, i) => i !== idx));
  };

  const cycleState = (idx: number) => {
    const current = dlcs[idx].state;
    const nextIdx = (STATE_CYCLE.indexOf(current) + 1) % STATE_CYCLE.length;
    const updated = [...dlcs];
    updated[idx] = { ...updated[idx], state: STATE_CYCLE[nextIdx] };
    emit(updated);
  };

  const fetchIgdbDlcs = async (query: string) => {
    if (!query) return;
    setIsSearchingIgdb(true);
    try {
      const res = await fetchWithAuth(`/igdb/dlcs?game_name=${encodeURIComponent(query)}`);
      if (res.ok) {
        setIgdbDlcs(await res.json());
      } else {
        setIgdbDlcs([]);
      }
    } catch (e) {
      setIgdbDlcs([]);
    } finally {
      setIsSearchingIgdb(false);
    }
  };

  const handleOpenIgdbSearch = async () => {
    if (!gameName) return;
    setShowIgdbModal(true);
    setIgdbSearchQuery(gameName);
    fetchIgdbDlcs(gameName);
  };

  const handleSelectIgdbDlc = (dlcName: string) => {
    if (!dlcs.some(d => d.name.toLowerCase() === dlcName.toLowerCase())) {
      emit([...dlcs, { name: dlcName, state: 'not_owned' }]);
    }
  };

  return (
    <div className="dlc-editor">
      {dlcs.length === 0 && (
        <p className="dlc-empty">No DLCs added yet.</p>
      )}

      <div className="dlc-list">
        {dlcs.map((dlc, idx) => (
          <div key={idx} className="dlc-row">
            <span className="dlc-name">{dlc.name}</span>
            <button
              type="button"
              className="dlc-state-btn"
              onClick={() => cycleState(idx)}
              title="Click to cycle state"
              style={{
                color: STATE_COLORS[dlc.state],
                backgroundColor: STATE_BG[dlc.state],
              }}
            >
              {dlc.state === 'not_owned' && '🔒 '}
              {dlc.state === 'not_started' && '⏸ '}
              {dlc.state === 'finished' && '✅ '}
              {STATE_LABELS[dlc.state]}
            </button>
            <button
              type="button"
              className="dlc-remove-btn"
              onClick={() => removeDlc(idx)}
              title="Remove DLC"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      <div className="dlc-add-row" style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem', flexWrap: 'wrap' }}>
        <input
          type="text"
          className="form-input dlc-name-input"
          placeholder="DLC name…"
          style={{ flex: 1, minWidth: '200px' }}
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addDlc(); } }}
        />
        <button
          type="button"
          className="btn btn-secondary dlc-add-btn"
          onClick={addDlc}
          disabled={!newName.trim()}
        >
          <Plus size={16} /> Add DLC
        </button>
      </div>
      
      {gameName && (
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: '100%', marginTop: '0.5rem', display: 'flex', justifyContent: 'center', gap: '0.5rem', color: 'var(--accent-primary)' }}
          onClick={handleOpenIgdbSearch}
        >
          <Search size={16} /> Search IGDB for DLCs
        </button>
      )}

      {showIgdbModal && createPortal(
        <div className="modal-overlay">
          <div className="glass-card modal-content" style={{ maxWidth: '800px', width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header">
              <h2>IGDB DLCs for "{gameName}"</h2>
              <button className="modal-close" onClick={() => setShowIgdbModal(false)}><X size={20}/></button>
            </div>
            
            <div style={{ padding: '1rem', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: '0.5rem' }}>
              <input
                type="text"
                className="form-input"
                placeholder="Search game..."
                value={igdbSearchQuery}
                onChange={e => setIgdbSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') fetchIgdbDlcs(igdbSearchQuery); }}
                style={{ flex: 1 }}
              />
              <button className="btn btn-primary" onClick={() => fetchIgdbDlcs(igdbSearchQuery)}>
                <Search size={18} />
              </button>
            </div>
            
            <div className="modal-body" style={{ overflowY: 'auto', padding: '1rem' }}>
              {isSearchingIgdb ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}>
                  <Loader2 className="spinner" size={32} />
                </div>
              ) : igdbDlcs.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-muted)' }}>
                  <p>No DLCs or Expansions found on IGDB for this game.</p>
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: '1rem' }}>
                  {igdbDlcs.map((dlc, idx) => {
                    const isAlreadyAdded = dlcs.some(d => d.name.toLowerCase() === dlc.name.toLowerCase());
                    return (
                      <div key={idx} className="glass-card" style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', opacity: isAlreadyAdded ? 0.5 : 1 }}>
                        <div style={{ height: '200px', background: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
                          {dlc.cover_url ? (
                            <img src={dlc.cover_url} alt="Cover" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          ) : (
                            <ImageIcon size={32} style={{ opacity: 0.2 }} />
                          )}
                        </div>
                        <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
                          <span style={{ fontSize: '0.85rem', fontWeight: 500, lineHeight: 1.2, flex: 1, textShadow: 'none' }} title={dlc.name}>
                            {dlc.name.length > 50 ? dlc.name.substring(0, 50) + '...' : dlc.name}
                          </span>
                          <button 
                            className="btn btn-secondary sm" 
                            style={{ width: '100%' }}
                            disabled={isAlreadyAdded}
                            onClick={() => handleSelectIgdbDlc(dlc.name)}
                          >
                            {isAlreadyAdded ? 'Added' : 'Select'}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
