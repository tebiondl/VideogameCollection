import { useEffect, useState } from 'react';
import { Check, Loader2, Plus, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { EMPTY_COPY_OPTIONS, type CopyOptions } from '../lib/discovery';

type ListKey = 'platforms' | 'sources' | 'types';

function uniqueName(base: string, values: string[]) {
  let candidate = base;
  let suffix = 2;
  while (values.some(value => value.trim().toLocaleLowerCase() === candidate.toLocaleLowerCase())) candidate = `${base} ${suffix++}`;
  return candidate;
}

function EditableList({ title, values, onRename, onAdd, onRemove }: {
  title: string;
  values: string[];
  onRename: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
}) {
  return <section className="admin-option-column">
    <div className="admin-option-heading"><h3>{title}</h3><span>{values.length}</span></div>
    <div className="admin-option-rows">{values.map((value, index) => <div className="admin-option-row" key={`${title}-${index}`}>
      <input className="form-input" aria-label={`${title} ${index + 1}`} value={value} onChange={event => onRename(index, event.target.value)} />
      <button type="button" className="admin-icon-button danger" onClick={() => onRemove(index)} disabled={values.length === 1} aria-label={`Delete ${value || title}`}><Trash2 size={16} /></button>
    </div>)}</div>
    <button type="button" className="admin-add-option" onClick={onAdd}><Plus size={15} /> Add {title.slice(0, -1).toLocaleLowerCase()}</button>
  </section>;
}

export function CopyConfigurationAdmin() {
  const [draft, setDraft] = useState<CopyOptions>(EMPTY_COPY_OPTIONS);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void fetchWithAuth('/discovery/copy-options').then(async response => {
      if (response.ok) setDraft(await response.json());
    }).catch(() => setDraft(EMPTY_COPY_OPTIONS));
  }, []);

  const rename = (kind: ListKey, index: number, name: string) => setDraft(current => {
    const previous = current[kind][index];
    const values = current[kind].map((value, valueIndex) => valueIndex === index ? name : value);
    let platformSources = current.platform_sources;
    let sourceTypes = current.source_types;
    if (kind === 'platforms') {
      platformSources = { ...platformSources, [name]: platformSources[previous] || [] };
      if (name !== previous) delete platformSources[previous];
    } else if (kind === 'sources') {
      platformSources = Object.fromEntries(Object.entries(platformSources).map(([platform, sources]) => [platform, sources.map(source => source === previous ? name : source)]));
      sourceTypes = { ...sourceTypes, [name]: sourceTypes[previous] || [] };
      if (name !== previous) delete sourceTypes[previous];
    } else {
      sourceTypes = Object.fromEntries(Object.entries(sourceTypes).map(([source, types]) => [source, types.map(type => type === previous ? name : type)]));
    }
    return { ...current, [kind]: values, platform_sources: platformSources, source_types: sourceTypes };
  });

  const add = (kind: ListKey) => setDraft(current => {
    const labels = { platforms: 'New platform', sources: 'New source', types: 'New type' };
    const name = uniqueName(labels[kind], current[kind]);
    const next = { ...current, [kind]: [...current[kind], name] } as CopyOptions;
    if (kind === 'platforms') next.platform_sources = { ...current.platform_sources, [name]: [] };
    if (kind === 'sources') next.source_types = { ...current.source_types, [name]: [] };
    return next;
  });

  const remove = (kind: ListKey, index: number) => setDraft(current => {
    const removed = current[kind][index];
    const next = { ...current, [kind]: current[kind].filter((_, valueIndex) => valueIndex !== index) } as CopyOptions;
    if (kind === 'platforms') {
      next.platform_sources = { ...current.platform_sources }; delete next.platform_sources[removed];
    } else if (kind === 'sources') {
      next.platform_sources = Object.fromEntries(Object.entries(current.platform_sources).map(([platform, sources]) => [platform, sources.filter(source => source !== removed)]));
      next.source_types = { ...current.source_types }; delete next.source_types[removed];
    } else {
      next.source_types = Object.fromEntries(Object.entries(current.source_types).map(([source, types]) => [source, types.filter(type => type !== removed)]));
    }
    return next;
  });

  const toggle = (mapping: 'platform_sources' | 'source_types', left: string, right: string) => setDraft(current => {
    const selected = current[mapping][left] || [];
    return { ...current, [mapping]: { ...current[mapping], [left]: selected.includes(right) ? selected.filter(value => value !== right) : [...selected, right] } };
  });

  const listsAreValid = (['platforms', 'sources', 'types'] as ListKey[]).every(kind => {
    const normalized = draft[kind].map(value => value.trim().toLocaleLowerCase());
    return normalized.length > 0 && normalized.every(Boolean) && new Set(normalized).size === normalized.length;
  });

  async function save(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setMessage('');
    const platforms = draft.platforms.map(value => value.trim());
    const sources = draft.sources.map(value => value.trim());
    const types = draft.types.map(value => value.trim());
    const payload = {
      platforms, sources, types,
      platform_sources: Object.fromEntries(draft.platforms.map((rawPlatform, index) => [platforms[index], (draft.platform_sources[rawPlatform] || []).map(source => source.trim()).filter(source => sources.includes(source))])),
      source_types: Object.fromEntries(draft.sources.map((rawSource, index) => [sources[index], (draft.source_types[rawSource] || []).map(type => type.trim()).filter(type => types.includes(type))])),
    };
    try {
      const response = await fetchWithAuth('/discovery/copy-options', { method: 'PUT', body: JSON.stringify(payload) });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || 'Could not save copy configuration.');
      setDraft(await response.json()); setMessage('Copy lists and compatibility rules saved.');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : 'Could not save copy configuration.');
    } finally { setSaving(false); }
  }

  return <section id="copies" className="glass-card admin-anchor-section admin-standard-card">
    <h2>Copy Configuration</h2>
    <p className="text-secondary admin-copy-intro">Edit the shared values used by current and old copies. Old copies use this same Platform list.</p>
    <form onSubmit={save}>
      <div className="admin-copy-options-grid three-columns">
        <EditableList title="Platforms" values={draft.platforms} onRename={(index, value) => rename('platforms', index, value)} onAdd={() => add('platforms')} onRemove={index => remove('platforms', index)} />
        <EditableList title="Sources" values={draft.sources} onRename={(index, value) => rename('sources', index, value)} onAdd={() => add('sources')} onRemove={index => remove('sources', index)} />
        <EditableList title="Types" values={draft.types} onRename={(index, value) => rename('types', index, value)} onAdd={() => add('types')} onRemove={index => remove('types', index)} />
      </div>
      <div className="admin-compatibility-section">
        <h3>Platform × Source</h3><p className="text-secondary">Each row is a platform. Click source tags to add or remove them.</p>
        <div className="admin-rule-rows">{draft.platforms.map((platform, index) => <div className="admin-rule-row" key={`${platform}-${index}`}><strong>{platform}</strong><div className="admin-rule-tags">{draft.sources.map((source, sourceIndex) => <button type="button" key={`${source}-${sourceIndex}`} className={`admin-rule-tag ${(draft.platform_sources[platform] || []).includes(source) ? 'selected' : ''}`} onClick={() => toggle('platform_sources', platform, source)}>{source}</button>)}</div></div>)}</div>
      </div>
      <div className="admin-compatibility-section">
        <h3>Source × Type</h3><p className="text-secondary">Each row is a source. Click type tags to add or remove them.</p>
        <div className="admin-rule-rows">{draft.sources.map((source, index) => <div className="admin-rule-row" key={`${source}-${index}`}><strong>{source}</strong><div className="admin-rule-tags">{draft.types.map((type, typeIndex) => <button type="button" key={`${type}-${typeIndex}`} className={`admin-rule-tag ${(draft.source_types[source] || []).includes(type) ? 'selected' : ''}`} onClick={() => toggle('source_types', source, type)}>{type}</button>)}</div></div>)}</div>
      </div>
      {!listsAreValid && <p className="disc-alert error" role="alert">Names cannot be blank or repeated inside the same list.</p>}
      {message && <p className="text-secondary" role="status">{message}</p>}
      <button className="btn btn-primary" type="submit" disabled={saving || !listsAreValid}>{saving ? <Loader2 size={18} className="spinner" /> : <Check size={18} />} Save copy configuration</button>
    </form>
  </section>;
}
