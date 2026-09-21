import { Archive, ChevronDown, Link2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { compatibleCopyFormat, compatibleCopyFormats, compatibleCopySources, isCopySourceCompatible, isSteamSource, preferredCopySource, sameCopyValue } from '../lib/copyCompatibility';
import type { OwnedCopy } from '../lib/ownedCopies';
import { parseCopies } from '../lib/ownedCopies';

export function OwnedCopiesEditor({ value, onChange, platformOptions, sourceOptions, typeOptions, platformSources, sourceTypes, onLinkSteam, onRestoreDuplicate, onMoveToOldCopy }: { value: string | null | undefined; onChange: (value: string | null) => void; platformOptions: string[]; sourceOptions: string[]; typeOptions: string[]; platformSources: Record<string, string[]>; sourceTypes: Record<string, string[]>; onLinkSteam?: (copy: OwnedCopy, index: number) => void; onRestoreDuplicate?: (copy: OwnedCopy, index: number) => void; onMoveToOldCopy?: (copy: OwnedCopy, index: number) => void }) {
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
      const isSteam = !!copy.steam_appid;
      const steamOption = sourceOptions.find(isSteamSource) || 'Steam';
      const sources = compatibleCopySources(copy.platform, copy.source ? [copy.source, ...sourceOptions] : sourceOptions, platformSources);
      const renderedSources = isSteam && !sources.some(isSteamSource) ? [steamOption, ...sources] : sources;
      const sourceValue = isSteam ? steamOption : sources.find(source => sameCopyValue(source, copy.source)) || '';
      const formats = compatibleCopyFormats(copy.platform, sourceValue, typeOptions, sourceTypes);
      const formatValue = compatibleCopyFormat(copy.platform, sourceValue, copy.format, typeOptions, sourceTypes);
      const canLinkSteam = !!onLinkSteam && (isSteam || isSteamSource(sourceValue));
      const canRestoreDuplicate = !!onRestoreDuplicate && isSteam && (!!copy.duplicate_of_appid || !!copy.merged_from_game_id);
      return <details className="owned-copy-editor" key={copy.id || index}>
      <summary className="owned-copy-heading"><span><ChevronDown size={16} /><strong>Copy {index + 1}</strong><small>{[copy.name, copy.platform || 'Choose platform', copy.format || 'Any format'].filter(Boolean).join(' · ')}</small></span><button type="button" className="icon-btn" onClick={event => { event.preventDefault(); event.stopPropagation(); remove(index); }} aria-label={`Remove copy ${index + 1}`}><Trash2 size={15} /></button></summary>
      <div className="owned-copy-grid">
        <label className="wide">Copy name / edition<input className="form-input" value={copy.name || ''} disabled={isSteam} onChange={event => update(index, { name: event.target.value || null })} placeholder="e.g. Final Fantasy VII (2013)" /></label>
        <label>Platform<select className="form-input" value={copy.platform || ''} disabled={isSteam} onChange={event => {
          const platform = event.target.value;
          const source = isCopySourceCompatible(platform, copy.source, platformSources) ? copy.source : null;
          update(index, { platform, source, format: compatibleCopyFormat(platform, source, copy.format, typeOptions, sourceTypes) });
        }}><option value="" disabled>Choose platform</option>{platforms.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Type<select className="form-input" value={formatValue} disabled={isSteam} onChange={event => update(index, { format: event.target.value })}>{formats.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Source<select className="form-input" value={sourceValue} disabled={isSteam} onChange={event => {
          const source = event.target.value;
          update(index, { source, format: compatibleCopyFormat(copy.platform, source, copy.format, typeOptions, sourceTypes) });
        }}><option value="" disabled>Choose source</option>{renderedSources.map(value => <option key={value}>{value}</option>)}</select>{isSteam && <small className="text-muted">Locked while this copy is linked to Steam.</small>}</label>
        <label>Copy playtime (hours)<input className="form-input" type="number" min="0" step="0.1" value={copy.playtime_hours ?? ''} disabled={isSteam} onChange={event => update(index, { playtime_hours: event.target.value ? Number(event.target.value) : null })} />{isSteam && <small className="text-muted">Updated automatically by Steam.{copy.counts_toward_totals === false ? ' Shared link; counted once in global analytics.' : ''}</small>}</label>
        <label>Price<input className="form-input" type="number" min="0" step="0.01" value={copy.price ?? ''} onChange={event => update(index, { price: event.target.value ? Number(event.target.value) : null })} /></label>
        <label>Currency<select className="form-input" value={copy.currency || 'EUR'} onChange={event => update(index, { currency: event.target.value })}>{['EUR', 'USD', 'GBP', 'JPY'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="wide">Store / source URL<input className="form-input" type="url" value={copy.store_url || ''} disabled={isSteam} onChange={event => update(index, { store_url: event.target.value || null })} /></label>
        {(canLinkSteam || canRestoreDuplicate || onMoveToOldCopy) && <div className="wide" style={{ display: 'flex', gap: '.65rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {onMoveToOldCopy && <button type="button" className="btn btn-secondary" disabled={!copy.platform?.trim()} onClick={() => onMoveToOldCopy(copy, index)}><Archive size={16} />Move to old copies</button>}
          {canLinkSteam && <button type="button" className="btn btn-secondary" disabled={!copy.id} onClick={() => onLinkSteam!(copy, index)}><Link2 size={16} />{copy.steam_appid ? 'Change linked Steam game' : 'Link this copy to Steam'}</button>}
          {canRestoreDuplicate && <button type="button" className="btn btn-secondary" disabled={!copy.id} onClick={() => onRestoreDuplicate!(copy, index)}><RotateCcw size={16} />Restore as separate game</button>}
          {canLinkSteam && !copy.id && <small className="text-muted">Save changes before linking this new copy.</small>}
          {onMoveToOldCopy && isSteam && <small className="text-muted">Moving this linked copy to old copies also puts its Steam link in the trash when saved, preventing sync from adding it again.</small>}
        </div>}
      </div>
    </details>})}
    <button type="button" className="btn btn-secondary" onClick={() => {
      const platform = platformOptions[0] || '';
      const source = preferredCopySource(platform, sourceOptions, false, platformSources);
      const format = compatibleCopyFormat(platform, source, typeOptions[0] || 'Any', typeOptions, sourceTypes);
      onChange(JSON.stringify([...copies, { id: crypto.randomUUID(), platform, format, source, currency: 'EUR' }]));
    }}><Plus size={16} /> Add another copy</button>
  </div>;
}
