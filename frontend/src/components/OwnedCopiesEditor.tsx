import { ChevronDown, Plus, Trash2 } from 'lucide-react';
import type { OwnedCopy } from '../lib/ownedCopies';
import { parseCopies } from '../lib/ownedCopies';

export function OwnedCopiesEditor({ value, onChange, platformOptions, sourceOptions }: { value: string | null | undefined; onChange: (value: string | null) => void; platformOptions: string[]; sourceOptions: string[] }) {
  const copies = parseCopies(value);
  const update = (index: number, patch: Partial<OwnedCopy>) => {
    const next = copies.map((copy, copyIndex) => copyIndex === index ? { ...copy, ...patch } : copy);
    onChange(JSON.stringify(next));
  };
  const remove = (index: number) => {
    const next = copies.filter((_, copyIndex) => copyIndex !== index);
    onChange(next.length ? JSON.stringify(next) : null);
  };
  return <div className="owned-copies-editor">
    {copies.map((copy, index) => {
      const platforms = copy.platform && !platformOptions.includes(copy.platform) ? [copy.platform, ...platformOptions] : platformOptions;
      const sources = copy.source && !sourceOptions.includes(copy.source) ? [copy.source, ...sourceOptions] : sourceOptions;
      return <details className="owned-copy-editor" key={copy.id || index}>
      <summary className="owned-copy-heading"><span><ChevronDown size={16} /><strong>Copy {index + 1}</strong><small>{copy.platform || 'Choose platform'} · {copy.format || 'Any format'}</small></span><button type="button" className="icon-btn" onClick={event => { event.preventDefault(); event.stopPropagation(); remove(index); }} aria-label={`Remove copy ${index + 1}`}><Trash2 size={15} /></button></summary>
      <div className="owned-copy-grid">
        <label>Platform<select className="form-input" value={copy.platform || ''} onChange={event => update(index, { platform: event.target.value })}><option value="" disabled>Choose platform</option>{platforms.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Format<select className="form-input" value={copy.format || 'Any'} onChange={event => update(index, { format: event.target.value })}>{['Any', 'Physical', 'Digital'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Source<select className="form-input" value={copy.source || ''} onChange={event => update(index, { source: event.target.value })}><option value="" disabled>Choose source</option>{sources.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Price<input className="form-input" type="number" min="0" step="0.01" value={copy.price ?? ''} onChange={event => update(index, { price: event.target.value ? Number(event.target.value) : null })} /></label>
        <label>Currency<select className="form-input" value={copy.currency || 'EUR'} onChange={event => update(index, { currency: event.target.value })}>{['EUR', 'USD', 'GBP', 'JPY'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="wide">Store / source URL<input className="form-input" type="url" value={copy.store_url || ''} onChange={event => update(index, { store_url: event.target.value || null })} /></label>
      </div>
    </details>})}
    <button type="button" className="btn btn-secondary" onClick={() => onChange(JSON.stringify([...copies, { platform: platformOptions[0] || '', format: 'Any', source: sourceOptions[0] || '', currency: 'EUR' }]))}><Plus size={16} /> Add another copy</button>
  </div>;
}
