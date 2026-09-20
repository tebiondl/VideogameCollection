import { Plus, Trash2 } from 'lucide-react';
import { parseOldCopies } from '../lib/ownedCopies';

export function OldCopiesEditor({ value, onChange, consoleOptions }: {
  value: string | null | undefined;
  onChange: (value: string | null) => void;
  consoleOptions: string[];
}) {
  const copies = parseOldCopies(value);
  const save = (next: typeof copies) => onChange(next.length ? JSON.stringify(next) : null);
  const update = (index: number, patch: Partial<(typeof copies)[number]>) => save(
    copies.map((copy, copyIndex) => copyIndex === index ? { ...copy, ...patch } : copy),
  );
  return <div className="old-copies-editor">
    {copies.map((copy, index) => {
      const consoles = copy.console && !consoleOptions.includes(copy.console) ? [copy.console, ...consoleOptions] : consoleOptions;
      return <div className="old-copy-row" key={copy.id || index}>
        <label>Platform<select className="form-input" value={copy.console} onChange={event => update(index, { console: event.target.value })}>{consoles.map(console => <option key={console}>{console}</option>)}</select></label>
        <label>Time played (hours)<input className="form-input" type="number" min="0" step="0.1" value={copy.playtime_hours ?? ''} onChange={event => update(index, { playtime_hours: event.target.value ? Number(event.target.value) : null })} /></label>
        <button type="button" className="icon-btn" onClick={() => save(copies.filter((_, copyIndex) => copyIndex !== index))} aria-label={`Delete old copy ${index + 1}`}><Trash2 size={16} /></button>
      </div>;
    })}
    <button type="button" className="btn btn-secondary" disabled={!consoleOptions.length} onClick={() => save([...copies, { id: crypto.randomUUID(), console: consoleOptions[0], playtime_hours: null }])}><Plus size={16} /> Add old copy</button>
  </div>;
}
