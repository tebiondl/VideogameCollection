import { useEffect, useState } from 'react';
import { Check, GripVertical, Loader2, Plus, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { EMPTY_COPY_OPTIONS, type CopyOptions } from '../lib/discovery';

type ListKey = 'platforms' | 'sources' | 'types';

function uniqueName(base: string, values: string[]) {
  let candidate = base;
  let suffix = 2;
  while (values.some(value => value.trim().toLocaleLowerCase() === candidate.toLocaleLowerCase())) candidate = `${base} ${suffix++}`;
  return candidate;
}

function EditableList({ title, values, onRename, onAdd, onRemove, onMove }: {
  title: string;
  values: string[];
  onRename: (index: number, value: string) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onMove: (from: number, to: number) => void;
}) {
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  return <section className="admin-option-column">
    <div className="admin-option-heading"><h3>{title}</h3><span>{values.length}</span></div>
    <div className="admin-option-rows">{values.map((value, index) => <div
      className={`admin-option-row${dropIndex === index ? ' drag-target' : ''}`}
      key={`${title}-${index}`}
      onDragEnter={event => { event.preventDefault(); if (draggedIndex !== null) setDropIndex(index); }}
      onDragOver={event => event.preventDefault()}
      onDrop={event => {
        event.preventDefault();
        if (draggedIndex !== null && draggedIndex !== index) onMove(draggedIndex, index);
        setDraggedIndex(null); setDropIndex(null);
      }}
    >
      <span
        className="admin-drag-handle"
        draggable
        role="button"
        tabIndex={0}
        aria-label={`Drag ${value || title} to reorder`}
        title="Drag to reorder"
        onDragStart={event => {
          setDraggedIndex(index); setDropIndex(index);
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData('text/plain', String(index));
        }}
        onDragEnd={() => { setDraggedIndex(null); setDropIndex(null); }}
      ><GripVertical size={17} /></span>
      <input className="form-input" aria-label={`${title} ${index + 1}`} value={value} onChange={event => onRename(index, event.target.value)} />
      <button type="button" className="admin-icon-button danger" onClick={() => onRemove(index)} disabled={values.length === 1} aria-label={`Delete ${value || title}`}><Trash2 size={16} /></button>
    </div>)}</div>
    <button type="button" className="admin-add-option" onClick={onAdd}><Plus size={15} /> Add {title.slice(0, -1).toLocaleLowerCase()}</button>
  </section>;
}

function RuleRow({ label, selected, options, itemLabel, onAdd, onRemove }: {
  label: string;
  selected: string[];
  options: string[];
  itemLabel: string;
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const available = options.filter(value => !selected.includes(value));
  return <div className="admin-rule-row">
    <strong>{label}</strong>
    <div className="admin-rule-tags">
      {selected.map(value => <button type="button" key={value} className="admin-rule-chip" onClick={() => onRemove(value)} title={`Remove ${value}`}><span>{value}</span><span aria-hidden="true">×</span></button>)}
      {selected.length === 0 && <span className="admin-rule-empty">No {itemLabel}s added</span>}
      {available.length > 0 && <label className="admin-rule-add"><Plus size={14} /><select aria-label={`Add ${itemLabel} to ${label}`} value="" onChange={event => { if (event.target.value) onAdd(event.target.value); }}><option value="">Add {itemLabel}…</option>{available.map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
    </div>
  </div>;
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

  const move = (kind: ListKey, from: number, to: number) => setDraft(current => {
    if (from === to || from < 0 || to < 0 || from >= current[kind].length || to >= current[kind].length) return current;
    const values = [...current[kind]];
    const [moved] = values.splice(from, 1);
    values.splice(to, 0, moved);
    const next = { ...current, [kind]: values } as CopyOptions;
    if (kind === 'sources') {
      next.platform_sources = Object.fromEntries(Object.entries(current.platform_sources).map(
        ([platform, selected]) => [platform, values.filter(value => selected.includes(value))],
      ));
    } else if (kind === 'types') {
      next.source_types = Object.fromEntries(Object.entries(current.source_types).map(
        ([source, selected]) => [source, values.filter(value => selected.includes(value))],
      ));
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
    <p className="text-secondary admin-copy-intro">Edit the shared values used by current and old copies. Drag the handles to choose their dropdown order, then save. Old copies use this same Platform list.</p>
    <form onSubmit={save}>
      <div className="admin-copy-options-grid three-columns">
        <EditableList title="Platforms" values={draft.platforms} onRename={(index, value) => rename('platforms', index, value)} onAdd={() => add('platforms')} onRemove={index => remove('platforms', index)} onMove={(from, to) => move('platforms', from, to)} />
        <EditableList title="Sources" values={draft.sources} onRename={(index, value) => rename('sources', index, value)} onAdd={() => add('sources')} onRemove={index => remove('sources', index)} onMove={(from, to) => move('sources', from, to)} />
        <EditableList title="Types" values={draft.types} onRename={(index, value) => rename('types', index, value)} onAdd={() => add('types')} onRemove={index => remove('types', index)} onMove={(from, to) => move('types', from, to)} />
      </div>
      <div className="admin-compatibility-section">
        <h3>Platform × Source</h3><p className="text-secondary">Each row shows only the sources currently assigned. Add another from the compact selector or click a tag to remove it.</p>
        <div className="admin-rule-rows">{draft.platforms.map((platform, index) => <RuleRow key={`${platform}-${index}`} label={platform} selected={draft.platform_sources[platform] || []} options={draft.sources} itemLabel="source" onAdd={source => toggle('platform_sources', platform, source)} onRemove={source => toggle('platform_sources', platform, source)} />)}</div>
      </div>
      <div className="admin-compatibility-section">
        <h3>Source × Type</h3><p className="text-secondary">Each row shows only the types currently assigned. Add another from the compact selector or click a tag to remove it.</p>
        <div className="admin-rule-rows">{draft.sources.map((source, index) => <RuleRow key={`${source}-${index}`} label={source} selected={draft.source_types[source] || []} options={draft.types} itemLabel="type" onAdd={type => toggle('source_types', source, type)} onRemove={type => toggle('source_types', source, type)} />)}</div>
      </div>
      {!listsAreValid && <p className="disc-alert error" role="alert">Names cannot be blank or repeated inside the same list.</p>}
      {message && <p className="text-secondary" role="status">{message}</p>}
      <button className="btn btn-primary" type="submit" disabled={saving || !listsAreValid}>{saving ? <Loader2 size={18} className="spinner" /> : <Check size={18} />} Save copy configuration</button>
    </form>
  </section>;
}
