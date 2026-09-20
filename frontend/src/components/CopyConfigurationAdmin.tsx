import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { EMPTY_COPY_OPTIONS, type CopyOptions } from '../lib/discovery';

const lines = (value: string) => [...new Set(value.split('\n').map(item => item.trim()).filter(Boolean))];

export function CopyConfigurationAdmin() {
  const [draft, setDraft] = useState({ platforms: '', sources: '', types: '', oldConsoles: '' });
  const [platformSources, setPlatformSources] = useState<Record<string, string[]>>({});
  const [sourceTypes, setSourceTypes] = useState<Record<string, string[]>>({});
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const platforms = useMemo(() => lines(draft.platforms), [draft.platforms]);
  const sources = useMemo(() => lines(draft.sources), [draft.sources]);
  const types = useMemo(() => lines(draft.types), [draft.types]);

  const load = (data: CopyOptions) => {
    setDraft({
      platforms: data.platforms.join('\n'), sources: data.sources.join('\n'),
      types: data.types.join('\n'), oldConsoles: data.old_consoles.join('\n'),
    });
    setPlatformSources(data.platform_sources);
    setSourceTypes(data.source_types);
  };

  useEffect(() => {
    void fetchWithAuth('/discovery/copy-options').then(async response => {
      if (response.ok) load(await response.json());
    }).catch(() => load(EMPTY_COPY_OPTIONS));
  }, []);

  const toggle = (mapping: Record<string, string[]>, setMapping: React.Dispatch<React.SetStateAction<Record<string, string[]>>>, left: string, right: string) => {
    const selected = mapping[left] || [];
    setMapping({ ...mapping, [left]: selected.includes(right) ? selected.filter(value => value !== right) : [...selected, right] });
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true); setMessage('');
    const payload = {
      platforms, sources, types, old_consoles: lines(draft.oldConsoles),
      platform_sources: Object.fromEntries(platforms.map(platform => [platform, (platformSources[platform] || []).filter(source => sources.includes(source))])),
      source_types: Object.fromEntries(sources.map(source => [source, (sourceTypes[source] || []).filter(type => types.includes(type))])),
    };
    try {
      const response = await fetchWithAuth('/discovery/copy-options', { method: 'PUT', body: JSON.stringify(payload) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || 'Could not save copy configuration.');
      load(await response.json());
      setMessage('Copy lists and compatibility rules saved.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Could not save copy configuration.');
    } finally { setSaving(false); }
  }

  return <section id="copies" className="glass-card admin-anchor-section admin-standard-card">
    <h2>Copy Configuration</h2>
    <p className="text-secondary admin-copy-intro">Edit the values used by copy forms, then choose which combinations are valid. One value per line; order controls dropdown order.</p>
    <form onSubmit={save}>
      <div className="admin-copy-options-grid three-columns">
        <label className="form-label">Platforms<textarea className="form-input" rows={9} value={draft.platforms} onChange={event => setDraft(current => ({ ...current, platforms: event.target.value }))} /></label>
        <label className="form-label">Sources<textarea className="form-input" rows={9} value={draft.sources} onChange={event => setDraft(current => ({ ...current, sources: event.target.value }))} /></label>
        <label className="form-label">Types<textarea className="form-input" rows={9} value={draft.types} onChange={event => setDraft(current => ({ ...current, types: event.target.value }))} /></label>
      </div>

      <div className="admin-compatibility-section">
        <h3>Platform × Source</h3>
        <p className="text-secondary">For every platform, select every source that can be used with it.</p>
        <div className="admin-compatibility-list">{platforms.map(platform => <fieldset key={platform}><legend>{platform}</legend><div>{sources.map(source => <label key={source}><input type="checkbox" checked={(platformSources[platform] || []).includes(source)} onChange={() => toggle(platformSources, setPlatformSources, platform, source)} />{source}</label>)}</div></fieldset>)}</div>
      </div>

      <div className="admin-compatibility-section">
        <h3>Source × Type</h3>
        <p className="text-secondary">For every source, select every valid copy type.</p>
        <div className="admin-compatibility-list">{sources.map(source => <fieldset key={source}><legend>{source}</legend><div>{types.map(type => <label key={type}><input type="checkbox" checked={(sourceTypes[source] || []).includes(type)} onChange={() => toggle(sourceTypes, setSourceTypes, source, type)} />{type}</label>)}</div></fieldset>)}</div>
      </div>

      <div className="admin-old-console-list">
        <label className="form-label">Old-copy consoles<textarea className="form-input" rows={10} value={draft.oldConsoles} onChange={event => setDraft(current => ({ ...current, oldConsoles: event.target.value }))} /></label>
        <p className="text-secondary">This separate list is used for historical copies that the user played but no longer owns.</p>
      </div>
      {message && <p className="text-secondary" role="status">{message}</p>}
      <button className="btn btn-primary" type="submit" disabled={saving || !platforms.length || !sources.length || !types.length || !lines(draft.oldConsoles).length}>
        {saving ? <Loader2 size={18} className="spinner" /> : <Check size={18} />} Save copy configuration
      </button>
    </form>
  </section>;
}
