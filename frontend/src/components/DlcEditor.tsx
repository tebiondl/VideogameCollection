import { useState } from 'react';
import { Plus, X } from 'lucide-react';

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
}

export function DlcEditor({ value, onChange }: Props) {
  const dlcs = parseDlcs(value);
  const [newName, setNewName] = useState('');

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

      <div className="dlc-add-row">
        <input
          type="text"
          className="form-input dlc-name-input"
          placeholder="DLC name…"
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
    </div>
  );
}
