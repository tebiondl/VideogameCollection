import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, Search, Upload, Edit2, X } from 'lucide-react';
import { WantedGameEditor } from '../components/WantedGameEditor';
import { discoveryApi, emptyWanted, errorMessage, fromIgdb } from '../lib/discovery';
import type { WantedDraft, IgdbGame } from '../lib/discovery';
import { parseWantedImport } from '../lib/wantedImport';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import './Discovery.css';

export function DiscoverySmartAdd() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IgdbGame[]>([]);
  const [text, setText] = useState('');
  const [inputFormat, setInputFormat] = useState('names');
  const [drafts, setDrafts] = useState<WantedDraft[]>([]);
  const [editor, setEditor] = useState<{ draft: WantedDraft; index?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function search(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    try { const data = await discoveryApi<IgdbGame[]>(`/igdb/search?q=${encodeURIComponent(query)}`); setResults(data); if (!data.length) setMessage('No IGDB matches. Try another title or paste a list below.'); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  function preview() {
    setError(''); setMessage('');
    try { setDrafts(parseWantedImport(text, inputFormat)); } catch (e) { setError(errorMessage(e)); }
  }
  async function commit() {
    setBusy(true); setError('');
    try { const result = await discoveryApi<{ added: number; skipped: number }>('/import', { method: 'POST', body: JSON.stringify({ games: drafts }) }); setMessage(`${result.added} games saved to Discovery. ${result.skipped} existing entries skipped.`); setDrafts([]); setText(''); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  return <div className="container discovery">
    <Link className="disc-back" to="/dashboard/videogames/wanted">← Back to Games I want</Link>
    <VideogamePageHeader eyebrow="Games I want" icon={<Sparkles />} title="Smart Add" description="Find game metadata or review an entire list before saving it to Games I want." actions={<Link className="btn btn-secondary" to="/dashboard/videogames/settings#steam">Connect Steam wishlist</Link>} />
    {error && <p className="disc-alert error" role="alert">{error}</p>}{message && <p className="disc-alert success" role="status">{message}</p>}
    <section className="disc-panel"><h2>Find with IGDB</h2><p className="disc-muted">Uses your existing Twitch integration, including DLCs and expansions.</p><form className="disc-inline" onSubmit={search}><input aria-label="Find game with IGDB" value={query} onChange={e => setQuery(e.target.value)} placeholder="Game or DLC title…" required /><button className="btn btn-primary" disabled={busy || !query.trim()}><Search size={17} /> {busy ? 'Searching…' : 'Search'}</button></form>
      <div className="disc-search-results">{results.map(game => <button key={game.igdb_id} onClick={() => setEditor({ draft: fromIgdb(game) })}><span>{game.name} {game.is_dlc ? '· DLC' : ''}</span><small>{game.release_year || 'TBA'} · {game.platforms.join(', ')}</small></button>)}</div>
    </section>
    <section className="disc-panel"><div className="disc-section-heading"><h2>Import a list</h2><label className="btn btn-secondary disc-upload"><Upload size={17} /> Choose file<input type="file" accept=".txt,.csv,.json" onChange={async e => {
      const file = e.target.files?.[0]; if (!file) return;
      if (file.size > 1024 * 1024) { setError('Choose a file smaller than 1 MB.'); return; }
      try { setText(await file.text()); setInputFormat(file.name.endsWith('.json') ? 'json' : file.name.endsWith('.csv') ? 'csv' : 'names'); setDrafts([]); setError(''); } catch (error) { setError(errorMessage(error)); }
    }} /></label></div><p className="disc-muted">Paste one title per line, CSV with a “name” column, or a JSON array. Up to 500 games per import. Duplicates are skipped and existing entries stay unchanged.</p>
      <label className="disc-field">Input format<select value={inputFormat} onChange={e => { setInputFormat(e.target.value); setDrafts([]); }}><option value="names">One title per line</option><option value="csv">CSV with headers</option><option value="json">JSON array</option></select></label>
      <textarea className="disc-import-text" aria-label="Games to import" rows={8} value={text} onChange={e => { setText(e.target.value); setDrafts([]); }} placeholder={'Hollow Knight: Silksong\nMetroid Prime 4: Beyond'} />
      <details className="disc-muted"><summary>Supported import fields</summary><p>{Object.keys(emptyWanted()).join(', ')}</p><p>CSV: is_dlc uses true/false; prices and scores use numbers. DLCs use a JSON array of objects with name and state (not_owned, not_started, playing, stopped, finished).</p></details>
      <button className="btn btn-secondary" disabled={!text.trim() || busy} onClick={preview}>Preview import</button>
      {drafts.length > 0 && <div className="disc-import-preview"><div className="disc-section-heading"><h3>Review {drafts.length} games</h3><button className="btn btn-primary" disabled={busy} onClick={commit}>{busy ? 'Saving…' : 'Save reviewed games'}</button></div><p className="disc-muted">Edit a row to add IGDB metadata, change fields, or attach DLCs before saving.</p>{drafts.map((draft, index) => <div className="disc-import-row" key={index}><span>{draft.name} {draft.is_dlc && <b className="disc-badge dlc">DLC</b>}<small>{draft.platform || 'Platform unspecified'}</small></span><button className="disc-icon-button" disabled={busy} aria-label={`Edit import ${draft.name}`} onClick={() => setEditor({ draft, index })}><Edit2 size={16} /></button><button className="disc-icon-button" disabled={busy} aria-label={`Remove import ${draft.name}`} onClick={() => setDrafts(drafts.filter((_, row) => row !== index))}><X size={16} /></button></div>)}</div>}
    </section>
    {editor && <WantedGameEditor title={editor.index === undefined ? 'Save game from IGDB' : 'Review imported game'} initial={editor.draft} onClose={() => setEditor(null)} onSave={async draft => {
      if (editor.index !== undefined) setDrafts(drafts.map((row, index) => index === editor.index ? draft : row));
      else { await discoveryApi('/games', { method: 'POST', body: JSON.stringify(draft) }); setMessage(`${draft.name} saved to Discovery.`); }
    }} />}
  </div>;
}
