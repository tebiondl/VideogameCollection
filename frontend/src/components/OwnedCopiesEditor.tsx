import { ChevronDown, Link2, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { OwnedCopy } from '../lib/ownedCopies';
import { parseCopies } from '../lib/ownedCopies';

const isSteamSource = (source: string | null | undefined) => source?.trim().toLocaleLowerCase() === 'steam';
const isSwitchPlatform = (platform: string | null | undefined) => /\bswitch\b/i.test(platform?.trim() || '');

export function OwnedCopiesEditor({ value, onChange, platformOptions, sourceOptions, onLinkSteam, onRestoreDuplicate }: { value: string | null | undefined; onChange: (value: string | null) => void; platformOptions: string[]; sourceOptions: string[]; onLinkSteam?: (copy: OwnedCopy, index: number) => void; onRestoreDuplicate?: (copy: OwnedCopy, index: number) => void }) {
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
      const switchCopy = isSwitchPlatform(copy.platform);
      const availableSources = switchCopy ? sourceOptions.filter(source => !isSteamSource(source)) : sourceOptions;
      const sources = copy.source && !isSteamSource(copy.source) && !availableSources.includes(copy.source) ? [copy.source, ...availableSources] : availableSources;
      const steamOption = sourceOptions.find(isSteamSource) || 'Steam';
      const sourceValue = isSteam ? steamOption : switchCopy && isSteamSource(copy.source) ? '' : isSteamSource(copy.source) ? steamOption : copy.source || '';
      const renderedSources = isSteam && !sources.some(isSteamSource) ? [steamOption, ...sources] : sources;
      const canLinkSteam = !!onLinkSteam && (isSteam || (!switchCopy && isSteamSource(copy.source)));
      const canRestoreDuplicate = !!onRestoreDuplicate && isSteam && (!!copy.duplicate_of_appid || !!copy.merged_from_game_id);
      return <details className="owned-copy-editor" key={copy.id || index}>
      <summary className="owned-copy-heading"><span><ChevronDown size={16} /><strong>Copy {index + 1}</strong><small>{[copy.name, copy.platform || 'Choose platform', copy.format || 'Any format'].filter(Boolean).join(' · ')}</small></span><button type="button" className="icon-btn" onClick={event => { event.preventDefault(); event.stopPropagation(); remove(index); }} aria-label={`Remove copy ${index + 1}`}><Trash2 size={15} /></button></summary>
      <div className="owned-copy-grid">
        <label className="wide">Copy name / edition<input className="form-input" value={copy.name || ''} disabled={isSteam} onChange={event => update(index, { name: event.target.value || null })} placeholder="e.g. Final Fantasy VII (2013)" /></label>
        <label>Platform<select className="form-input" value={copy.platform || ''} disabled={isSteam} onChange={event => {
          const platform = event.target.value;
          update(index, { platform, ...(isSwitchPlatform(platform) && isSteamSource(copy.source) ? { source: null } : {}) });
        }}><option value="" disabled>Choose platform</option>{platforms.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Format<select className="form-input" value={copy.format || 'Any'} disabled={isSteam} onChange={event => update(index, { format: event.target.value })}>{['Any', 'Physical', 'Digital'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Source<select className="form-input" value={sourceValue} disabled={isSteam} onChange={event => update(index, { source: event.target.value })}><option value="" disabled>Choose source</option>{renderedSources.map(value => <option key={value}>{value}</option>)}</select>{isSteam && <small className="text-muted">Locked while this copy is linked to Steam.</small>}</label>
        <label>Copy playtime (hours)<input className="form-input" type="number" min="0" step="0.1" value={copy.playtime_hours ?? ''} disabled={isSteam} onChange={event => update(index, { playtime_hours: event.target.value ? Number(event.target.value) : null })} />{isSteam && <small className="text-muted">Updated automatically by Steam.{copy.counts_toward_totals === false ? ' Shared link; counted once in global analytics.' : ''}</small>}</label>
        <label>Price<input className="form-input" type="number" min="0" step="0.01" value={copy.price ?? ''} onChange={event => update(index, { price: event.target.value ? Number(event.target.value) : null })} /></label>
        <label>Currency<select className="form-input" value={copy.currency || 'EUR'} onChange={event => update(index, { currency: event.target.value })}>{['EUR', 'USD', 'GBP', 'JPY'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="wide">Store / source URL<input className="form-input" type="url" value={copy.store_url || ''} disabled={isSteam} onChange={event => update(index, { store_url: event.target.value || null })} /></label>
        {(canLinkSteam || canRestoreDuplicate) && <div className="wide" style={{ display: 'flex', gap: '.65rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {canLinkSteam && <button type="button" className="btn btn-secondary" disabled={!copy.id} onClick={() => onLinkSteam!(copy, index)}><Link2 size={16} />{copy.steam_appid ? 'Change linked Steam game' : 'Link this copy to Steam'}</button>}
          {canRestoreDuplicate && <button type="button" className="btn btn-secondary" disabled={!copy.id} onClick={() => onRestoreDuplicate!(copy, index)}><RotateCcw size={16} />Restore as separate game</button>}
          {canLinkSteam && !copy.id && <small className="text-muted">Save changes before linking this new copy.</small>}
        </div>}
      </div>
    </details>})}
    <button type="button" className="btn btn-secondary" onClick={() => {
      const platform = platformOptions[0] || '';
      const source = sourceOptions.find(option => !isSwitchPlatform(platform) || !isSteamSource(option)) || '';
      onChange(JSON.stringify([...copies, { id: crypto.randomUUID(), platform, format: 'Any', source, currency: 'EUR' }]));
    }}><Plus size={16} /> Add another copy</button>
  </div>;
}
