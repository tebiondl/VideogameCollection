import { useEffect, useRef, useState } from 'react';
import './Modal.css';
import './DlcEditor.css';
import { Plus, X, Search, Loader2, Image as ImageIcon, ExternalLink } from 'lucide-react';
import { createPortal } from 'react-dom';
import { fetchWithAuth } from '../lib/api';
import { addManualDlc, mergeSteamDlcs, type Dlc, type DlcState } from '../lib/steamDlcs';

export type { Dlc, DlcState } from '../lib/steamDlcs';

const STATE_CYCLE: DlcState[] = ['not_owned', 'not_started', 'playing', 'stopped', 'finished'];
const STATE_LABELS: Record<DlcState, string> = {
  not_owned: 'Not Owned',
  not_started: 'Not Started',
  playing: 'Playing',
  finished: 'Finished',
  stopped: 'Stopped',
};
const STATE_COLORS: Record<DlcState, string> = {
  not_owned: 'var(--text-muted)',
  not_started: 'var(--accent-primary)',
  playing: '#38bdf8',
  finished: '#4ade80',
  stopped: '#fb923c',
};
const STATE_BG: Record<DlcState, string> = {
  not_owned: 'rgba(255,255,255,0.05)',
  not_started: 'rgba(139,92,246,0.15)',
  playing: 'rgba(56,189,248,0.14)',
  finished: 'rgba(74,222,128,0.12)',
  stopped: 'rgba(251,146,60,0.14)',
};

function parseDlcs(value: string): Dlc[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    return [];
  }
  return [];
}

interface IgdbDlc {
  name: string;
  cover_url?: string | null;
}

interface Props {
  value: string; // JSON string
  onChange: (val: string) => void;
  gameName?: string;
  gameId?: number;
  getPortalContainer?: () => Element;
  onOpenStandalone?: (gameId: number) => void;
}

export function DlcEditor({ value, onChange, gameName, gameId, getPortalContainer, onOpenStandalone }: Props) {
  const dlcs = parseDlcs(value);
  const latestValue = useRef(value);
  const latestGameId = useRef(gameId);
  useEffect(() => {
    latestValue.current = value;
    latestGameId.current = gameId;
  }, [value, gameId]);
  const [newName, setNewName] = useState('');
  const [showIgdbModal, setShowIgdbModal] = useState(false);
  const [igdbDlcs, setIgdbDlcs] = useState<IgdbDlc[]>([]);
  const [isSearchingIgdb, setIsSearchingIgdb] = useState(false);
  const [igdbSearchQuery, setIgdbSearchQuery] = useState('');
  const [isSearchingSteam, setIsSearchingSteam] = useState(false);
  const [steamMessage, setSteamMessage] = useState('');

  const emit = (updated: Dlc[]) => onChange(JSON.stringify(updated));

  const addDlc = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    const result = addManualDlc(dlcs, trimmed, gameName);
    if (result.dlcs !== dlcs) emit(result.dlcs);
    setSteamMessage(result.linked ? 'That DLC is already linked to Steam.' : '');
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
    } catch {
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
    const result = addManualDlc(dlcs, dlcName, gameName, 'IGDB');
    if (result.dlcs !== dlcs) emit(result.dlcs);
  };

  const handleFindSteamDlcs = async () => {
    if (!gameId || !gameName?.trim()) return;
    setIsSearchingSteam(true);
    setSteamMessage('');
    try {
      const response = await fetchWithAuth(`/videogames/${gameId}/steam-dlcs?name=${encodeURIComponent(gameName.trim())}`);
      const data = await response.json();
      if (latestGameId.current !== gameId) return;
      if (!response.ok) throw new Error(data.detail || 'Steam DLC lookup failed.');
      const result = mergeSteamDlcs(parseDlcs(latestValue.current), data.dlcs, gameName);
      if (result.added || result.updated) onChange(JSON.stringify(result.dlcs));
      setSteamMessage(result.added
        ? `Added ${result.added} Steam DLC${result.added === 1 ? '' : 's'} as Not Owned. Save Changes to keep them.`
        : result.updated ? `Linked ${result.updated} existing DLC${result.updated === 1 ? '' : 's'} to Steam. Save Changes to keep them.`
          : data.dlcs.length ? 'All Steam DLCs are already listed.' : 'Steam lists no DLCs for this game.');
    } catch (error) {
      setSteamMessage(error instanceof Error ? error.message : 'Steam DLC lookup failed.');
    } finally {
      setIsSearchingSteam(false);
    }
  };

  return (
    <div className="dlc-editor">
      {dlcs.length === 0 && (
        <p className="dlc-empty">No DLCs added yet.</p>
      )}

      <div className="dlc-list" role="region" aria-label="DLC list" tabIndex={dlcs.length ? 0 : -1}>
        {dlcs.map((dlc, idx) => (
          <div key={idx} className="dlc-row">
            <span className="dlc-name">{dlc.name}{(dlc.source || dlc.platform || dlc.playtime_hours != null) && <small style={{ display: 'block', color: 'var(--text-muted)', fontWeight: 400, marginTop: '.2rem' }}>{[dlc.source, dlc.platform, dlc.playtime_hours != null ? `${dlc.playtime_hours} hrs` : null].filter(Boolean).join(' · ')}</small>}</span>
            {dlc.standalone_game_id && <button
              type="button"
              className="icon-btn"
              onClick={() => onOpenStandalone?.(dlc.standalone_game_id!)}
              title="Open standalone collection entry"
              aria-label={`Open standalone entry for ${dlc.name}`}
            ><ExternalLink size={16} /></button>}
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
              {dlc.state === 'playing' && '▶️ '}
              {dlc.state === 'finished' && '✅ '}
              {dlc.state === 'stopped' && '⏹️ '}
              {STATE_LABELS[dlc.state]}
            </button>
            {!dlc.standalone_game_id && <button
              type="button"
              className="dlc-remove-btn"
              onClick={() => removeDlc(idx)}
              title="Remove DLC"
            >
              <X size={14} />
            </button>}
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
        <>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ width: '100%', marginTop: '0.5rem', display: 'flex', justifyContent: 'center', gap: '0.5rem', color: 'var(--accent-primary)' }}
          onClick={handleOpenIgdbSearch}
        >
          <Search size={16} /> Search IGDB for DLCs
        </button>
        {gameId && <button type="button" className="btn btn-ghost dlc-steam-search" onClick={handleFindSteamDlcs} disabled={isSearchingSteam || !gameName.trim()}>
          {isSearchingSteam ? <Loader2 className="spinner" size={16} /> : <Search size={16} />}
          {isSearchingSteam ? 'Checking Steam…' : 'Refresh Steam DLCs'}
        </button>}
        {steamMessage && <p className="dlc-search-message" role="status">{steamMessage}</p>}
        </>
      )}

      {showIgdbModal && createPortal(
        <div className="modal-overlay">
          <div className="glass-card modal-content" style={{ maxWidth: '800px', width: '90%', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="modal-header">
              <h2>IGDB DLCs for "{gameName}"</h2>
              <button type="button" className="modal-close" onClick={() => setShowIgdbModal(false)}><X size={20}/></button>
            </div>
            
            <div style={{ padding: '1rem', borderBottom: '1px solid var(--border-color)', display: 'flex', gap: '0.5rem' }}>
              <input
                type="text"
                className="form-input"
                placeholder="Search game..."
                value={igdbSearchQuery}
                onChange={e => setIgdbSearchQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); fetchIgdbDlcs(igdbSearchQuery); } }}
                style={{ flex: 1 }}
              />
              <button type="button" className="btn btn-primary" onClick={() => fetchIgdbDlcs(igdbSearchQuery)}>
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
                          <button type="button"
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
        getPortalContainer?.() || document.body
      )}
    </div>
  );
}
