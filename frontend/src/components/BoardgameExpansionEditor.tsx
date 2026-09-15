import { useEffect, useRef, useState } from 'react';
import { Loader2, PackageCheck, Plus, Search, X } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import './BoardgameExpansionEditor.css';

interface Props {
  bggId: number | null;
  names: string[];
  onChange: (names: string[]) => void;
}

const nameKey = (name: string) => name.trim().normalize('NFKC').toLocaleLowerCase();

export function BoardgameExpansionEditor({ bggId, names, onChange }: Props) {
  const [manualName, setManualName] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [results, setResults] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const ownedKeys = new Set(names.map(nameKey));
  const selectedToAdd = selected.filter(name => !ownedKeys.has(nameKey(name)));
  const visibleResults = results.filter(name => nameKey(name).includes(nameKey(filter)));
  const duplicateManualName = ownedKeys.has(nameKey(manualName));

  const addNames = (additions: string[]) => {
    const combined = [...names];
    const keys = new Set(combined.map(nameKey));
    for (const name of additions) {
      const clean = name.trim();
      if (clean && !keys.has(nameKey(clean))) { combined.push(clean); keys.add(nameKey(clean)); }
    }
    onChange(combined);
  };
  const addManual = () => {
    if (!manualName.trim() || duplicateManualName) return;
    addNames([manualName]); setManualName('');
  };
  const search = async () => {
    if (!bggId || isLoading) return;
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setIsOpen(true); setIsLoading(true); setError(''); setResults([]); setSelected([]); setFilter('');
    try {
      const response = await fetchWithAuth(`/boardgames/bgg/${bggId}/expansions`, { signal: controller.signal });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.detail || 'Could not load expansions from BGG.'); }
      const data: string[] = await response.json();
      if (!controller.signal.aborted) setResults(data);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Could not load expansions from BGG.');
    } finally { if (!controller.signal.aborted) setIsLoading(false); }
  };

  return <div className="bg-expansion-editor">
    <div><strong>Expansions you own</strong><span>Find expansions on BGG or add any name manually. Save the game to keep your changes.</span></div>
    <button type="button" className="bge-search-button" onClick={search} disabled={!bggId || bggId < 1 || isLoading}>{isLoading ? <Loader2 size={16} className="spinner" /> : <Search size={16} />} Search BGG expansions</button>
    {!bggId && <p>Sync the game with BGG above to look up expansions. Manual entry is always available.</p>}
    {isOpen && <section className="bge-picker" aria-label="BGG expansion picker">
      <div className="bge-picker-heading"><strong>Choose the expansions you own</strong><button type="button" onClick={() => setIsOpen(false)} aria-label="Close expansion picker"><X size={16} /></button></div>
      {isLoading ? <p role="status">Loading expansions from BGG…</p> : error ? <p className="bge-error" role="alert">{error} You can still add names manually below.</p> : <>
        <p role="status">{results.length ? `${results.length} expansions found. Already added names are marked below.` : 'BGG lists no expansions for this game. You can still add names manually below.'}</p>
        {results.length > 0 && <>
          <input className="bge-filter" aria-label="Filter BGG expansions" placeholder="Filter expansions…" value={filter} onChange={event => setFilter(event.target.value)} />
          <div className="bge-options">{visibleResults.map(name => {
            const owned = ownedKeys.has(nameKey(name));
            return <label key={name}><input type="checkbox" checked={owned || selected.includes(name)} disabled={owned} onChange={event => setSelected(current => event.target.checked ? [...current, name] : current.filter(item => item !== name))} /><span>{name}</span>{owned && <small>Already added</small>}</label>;
          })}{!visibleResults.length && <p>No expansions match this filter.</p>}</div>
          <button className="bge-search-button" type="button" disabled={!selectedToAdd.length} onClick={() => { addNames(selectedToAdd); setSelected([]); setIsOpen(false); }}><Plus size={16} /> Add selected ({selectedToAdd.length})</button>
        </>}
      </>}
    </section>}
    <div className="bg-expansion-input"><input value={manualName} onChange={event => setManualName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addManual(); } }} placeholder="Type an expansion name manually" aria-label="Manual expansion name" /><button type="button" onClick={addManual} disabled={!manualName.trim() || duplicateManualName}><Plus /> Add</button></div>
    {duplicateManualName && <p role="status">This expansion is already in your list.</p>}
    {names.length > 0 ? <div className="bg-expansion-edit-list">{names.map(name => <span key={name}><PackageCheck />{name}<button type="button" onClick={() => onChange(names.filter(item => item !== name))} aria-label={`Remove ${name}`}><X /></button></span>)}</div> : <p>No expansions added yet.</p>}
  </div>;
}
