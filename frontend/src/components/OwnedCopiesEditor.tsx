import { ChevronDown, Link2, Plus, Trash2 } from 'lucide-react';
import type { OwnedCopy } from '../lib/ownedCopies';
import { parseCopies } from '../lib/ownedCopies';

export function OwnedCopiesEditor({ value, onChange, platformOptions, sourceOptions, onLinkSteam }: { value: string | null | undefined; onChange: (value: string | null) => void; platformOptions: string[]; sourceOptions: string[]; onLinkSteam?: (copy: OwnedCopy, index: number) => void }) {
  const copies = parseCopies(value);
  const update = (index: number, patch: Partial<OwnedCopy>) => {
    const next = copies.map((copy, copyIndex) => copyIndex === index ? { ...copy, ...patch } : copy);
    onChange(JSON.stringify(next));
  };
  const remove = (index: number) => {
    const copy = copies[index];
    const message = copy.steam_appid
      ? 'Move this linked Steam copy to the trash? Steam sync will not add it again unless you restore it.'
      : 'Delete this copy?';
    if (!window.confirm(message)) return;
    const next = copies.filter((_, copyIndex) => copyIndex !== index);
    onChange(next.length ? JSON.stringify(next) : null);
  };
  return <div className="owned-copies-editor">
    {copies.map((copy, index) => {
      const platforms = copy.platform && !platformOptions.includes(copy.platform) ? [copy.platform, ...platformOptions] : platformOptions;
      const sources = copy.source && !sourceOptions.includes(copy.source) ? [copy.source, ...sourceOptions] : sourceOptions;
      const isSteam = !!copy.steam_appid;
      return <details className="owned-copy-editor" key={copy.id || index}>
      <summary className="owned-copy-heading"><span><ChevronDown size={16} /><strong>Copy {index + 1}</strong><small>{[copy.name, copy.platform || 'Choose platform', copy.format || 'Any format'].filter(Boolean).join(' · ')}</small></span><button type="button" className="icon-btn" onClick={event => { event.preventDefault(); event.stopPropagation(); remove(index); }} aria-label={`Remove copy ${index + 1}`}><Trash2 size={15} /></button></summary>
      <div className="owned-copy-grid">
        <label className="wide">Copy name / edition<input className="form-input" value={copy.name || ''} onChange={event => update(index, { name: event.target.value || null })} placeholder="e.g. Final Fantasy VII (2013)" /></label>
        <label>Platform<select className="form-input" value={copy.platform || ''} onChange={event => update(index, { platform: event.target.value })}><option value="" disabled>Choose platform</option>{platforms.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Format<select className="form-input" value={copy.format || 'Any'} onChange={event => update(index, { format: event.target.value })}>{['Any', 'Physical', 'Digital'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Source<select className="form-input" value={isSteam ? 'Steam' : copy.source || ''} disabled={isSteam} onChange={event => update(index, { source: event.target.value })}><option value="" disabled>Choose source</option>{(isSteam && !sources.includes('Steam') ? ['Steam', ...sources] : sources).map(value => <option key={value}>{value}</option>)}</select>{isSteam && <small className="text-muted">Locked while this copy is linked to Steam.</small>}</label>
        <label>Copy playtime (hours)<input className="form-input" type="number" min="0" step="0.1" value={copy.playtime_hours ?? ''} disabled={isSteam} onChange={event => update(index, { playtime_hours: event.target.value ? Number(event.target.value) : null })} />{isSteam && <small className="text-muted">Updated automatically by Steam.</small>}</label>
        <label>Price<input className="form-input" type="number" min="0" step="0.01" value={copy.price ?? ''} onChange={event => update(index, { price: event.target.value ? Number(event.target.value) : null })} /></label>
        <label>Currency<select className="form-input" value={copy.currency || 'EUR'} onChange={event => update(index, { currency: event.target.value })}>{['EUR', 'USD', 'GBP', 'JPY'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="wide">Store / source URL<input className="form-input" type="url" value={copy.store_url || ''} onChange={event => update(index, { store_url: event.target.value || null })} /></label>
        {onLinkSteam && <div className="wide"><button type="button" className="btn btn-secondary" disabled={!copy.id} onClick={() => onLinkSteam(copy, index)}><Link2 size={16} />{copy.steam_appid ? 'Change linked Steam game' : 'Link this copy to Steam'}</button>{!copy.id && <small className="text-muted" style={{ display: 'block', marginTop: '.4rem' }}>Save changes before linking this new copy.</small>}</div>}
      </div>
    </details>})}
    <button type="button" className="btn btn-secondary" onClick={() => onChange(JSON.stringify([...copies, { id: crypto.randomUUID(), platform: platformOptions[0] || '', format: 'Any', source: sourceOptions[0] || '', currency: 'EUR' }]))}><Plus size={16} /> Add another copy</button>
  </div>;
}
