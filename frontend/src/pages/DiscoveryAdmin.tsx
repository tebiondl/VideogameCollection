import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Settings2, RefreshCw, Unplug, Download, GitCompareArrows, Trash2, X, History, ShieldCheck, Wrench } from 'lucide-react';
import { discoveryApi, errorMessage, timestamp, payload, syncIsRunning } from '../lib/discovery';
import type { DiscoverySettings, SteamAuditEntry, SteamIntegrity, SteamMatchReview, WantedGame } from '../lib/discovery';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import './Discovery.css';

export function DiscoveryAdmin({ embedded = false }: { embedded?: boolean }) {
  const [settings, setSettings] = useState<DiscoverySettings | null>(null);
  const [reviews, setReviews] = useState<SteamMatchReview[]>([]);
  const [form, setForm] = useState({ steam_id: '', steam_api_key: '', sync_enabled: false, sync_wishlist: true, sync_collection: true, sync_hours: 6, region: 'Europe' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reviewBusy, setReviewBusy] = useState<number | null>(null);
  const [showUnsync, setShowUnsync] = useState(false);
  const [showReviews, setShowReviews] = useState(false);
  const [showAudit, setShowAudit] = useState(false);
  const [audit, setAudit] = useState<SteamAuditEntry[]>([]);
  const [integrity, setIntegrity] = useState<SteamIntegrity | null>(null);
  const [selectedCandidates, setSelectedCandidates] = useState<Record<number, number>>({});
  const syncing = syncIsRunning(settings?.sync_started_at);
  useEffect(() => {
    let cancelled = false;
    Promise.all([discoveryApi<DiscoverySettings>('/settings'), discoveryApi<SteamMatchReview[]>('/steam/reviews')]).then(([data, pending]) => { if (!cancelled) { setSettings(data); setReviews(pending); setForm({ steam_id: data.steam_id || '', steam_api_key: '', sync_enabled: data.sync_enabled, sync_wishlist: data.sync_wishlist, sync_collection: data.sync_collection, sync_hours: data.sync_hours, region: data.region }); } }).catch(e => { if (!cancelled) setError(errorMessage(e)); });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!syncing) return;
    const timer = window.setInterval(() => { Promise.all([discoveryApi<DiscoverySettings>('/settings'), discoveryApi<SteamMatchReview[]>('/steam/reviews')]).then(([data, pending]) => { setSettings(data); setReviews(pending); }).catch(e => setError(errorMessage(e))); }, 3000);
    return () => window.clearInterval(timer);
  }, [syncing]);
  async function save(event?: React.FormEvent, disconnect = false) {
    event?.preventDefault(); setBusy(true); setError(''); setMessage('');
    try {
      const updated = await discoveryApi<DiscoverySettings>('/settings', { method: 'PUT', body: JSON.stringify(disconnect ? { ...form, steam_id: null, steam_api_key: null, clear_steam_api_key: true, sync_enabled: false } : { ...form, steam_api_key: form.steam_api_key || null }) });
      setSettings(updated); setForm({ steam_id: updated.steam_id || '', steam_api_key: '', sync_enabled: updated.sync_enabled, sync_wishlist: updated.sync_wishlist, sync_collection: updated.sync_collection, sync_hours: updated.sync_hours, region: updated.region });
      setMessage(disconnect ? 'Steam disconnected. Your saved games are kept.' : 'Steam settings saved. The selected Steam lists will sync automatically on the server.');
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function sync() {
    setBusy(true); setError('');
    try { const response = await discoveryApi<{ message: string }>('/steam/sync', { method: 'POST' }); setMessage(response.message); setSettings(await discoveryApi<DiscoverySettings>('/settings')); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function resolveReview(review: SteamMatchReview, decision: 'same' | 'none') {
    const candidate = review.candidates.find(item => item.game_id === selectedCandidates[review.id]);
    if (decision === 'same' && !candidate) return;
    setReviewBusy(review.id); setError(''); setMessage('');
    try {
      await discoveryApi<{ resolved: boolean; collection_game_id: number | null; remaining_candidates: number }>(`/steam/reviews/${review.id}`, { method: 'POST', body: JSON.stringify({ decision, candidate_game_id: candidate?.game_id ?? null }) });
      const pending = await discoveryApi<SteamMatchReview[]>('/steam/reviews');
      setReviews(pending);
      setSelectedCandidates(current => { const next = { ...current }; delete next[review.id]; return next; });
      if (pending.length === 0) setShowReviews(false);
      if (decision === 'same') {
        setMessage(review.match_kind === 'dlc_parent' ? `${review.steam_name} is now inside ${candidate!.name}.` : `${candidate!.name} is now linked and renamed to ${review.steam_name}; its other collection data was preserved.`);
      } else {
        setMessage(review.match_kind === 'dlc_parent' ? `${review.steam_name} will stay ignored until you restore it from Trash.` : `${review.steam_name} was saved as a separate collection game.`);
      }
    } catch (e) { setError(errorMessage(e)); } finally { setReviewBusy(null); }
  }
  async function unsyncSteam() {
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await discoveryApi<{ collection_games_removed: number; steam_copies_removed: number; wanted_games_removed: number }>('/steam/imports', { method: 'DELETE' });
      const updated = await discoveryApi<DiscoverySettings>('/settings');
      setSettings(updated); setForm(current => ({ ...current, sync_enabled: false })); setReviews([]); setShowUnsync(false);
      setMessage(`Steam data removed: ${result.collection_games_removed} imported collection games, ${result.steam_copies_removed} Steam copies and ${result.wanted_games_removed} imported wanted games. Automatic sync is paused.`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function exportGames() {
    setBusy(true); setError('');
    try {
      const games = await discoveryApi<WantedGame[]>('/games');
      const url = URL.createObjectURL(new Blob([JSON.stringify(games.map(payload), null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = 'games-i-want.json'; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function openAudit() {
    setBusy(true); setError('');
    try {
      const [entries, health] = await Promise.all([
        discoveryApi<SteamAuditEntry[]>('/steam/audit?limit=150'),
        discoveryApi<SteamIntegrity>('/steam/integrity'),
      ]);
      setAudit(entries); setIntegrity(health); setShowAudit(true);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function repairIntegrity() {
    setBusy(true); setError('');
    try { setIntegrity(await discoveryApi<SteamIntegrity>('/steam/integrity/repair', { method: 'POST' })); setMessage('Steam copy projections and playtime ownership were repaired.'); }
    catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const content = <>
    {error && <p className="disc-alert error" role="alert">{error}</p>}{message && <p className="disc-alert success" role="status">{message}</p>}
    {!settings ? <p className="disc-empty">{error ? 'Settings could not be loaded. Reload to try again.' : 'Loading settings…'}</p> : <div className="disc-admin-grid">
      <section className="disc-panel"><div className="disc-section-heading"><h2>Steam library & wishlist</h2><span className="disc-badge">{settings.steam_id ? settings.sync_enabled ? 'AUTO SYNC ON' : 'CONNECTED · PAUSED' : 'NOT CONNECTED'}</span></div>
        <p className="disc-muted">Connect a public Steam profile using its SteamID64 or numeric profile URL. The wishlist needs no key. Library sync uses Steam’s supported GetOwnedGames API, which requires a Web API key. Your Steam password is never used.</p>
        <form className="disc-form" onSubmit={save}>
          <label className="disc-field">SteamID64 or numeric profile URL<input value={form.steam_id} onChange={e => setForm({ ...form, steam_id: e.target.value })} placeholder="https://steamcommunity.com/profiles/7656119…" /></label>
          <label className="disc-field">Steam Web API key <small>{settings.steam_api_key_configured ? 'Configured — leave blank to keep it, or enter a new key.' : 'Required for owned-library sync.'}</small><input type="password" autoComplete="off" value={form.steam_api_key} onChange={e => setForm({ ...form, steam_api_key: e.target.value.trim() })} placeholder={settings.steam_api_key_configured ? '••••••••••••••••••••••••••••••••' : '32-character key'} /><a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noreferrer">Get a Steam Web API key</a></label>
          <label className="disc-check"><input type="checkbox" checked={form.sync_enabled} onChange={e => setForm({ ...form, sync_enabled: e.target.checked })} /> Run Steam sync automatically</label>
          <div className="disc-sync-choices" role="group" aria-label="Steam data to sync">
            <label className="disc-check"><input type="checkbox" checked={form.sync_wishlist} onChange={e => setForm({ ...form, sync_wishlist: e.target.checked })} /> Sync my Steam wishlist</label>
            <label className="disc-check"><input type="checkbox" checked={form.sync_collection} onChange={e => setForm({ ...form, sync_collection: e.target.checked })} /> Sync my owned Steam collection</label>
          </div>
          <div className="disc-form-grid"><label>Sync frequency<select value={form.sync_hours} onChange={e => setForm({ ...form, sync_hours: Number(e.target.value) })}><option value={6}>Every 6 hours · 4 times a day</option><option value={8}>Every 8 hours · 3 times a day</option></select></label><label>Default release region<select value={form.region} onChange={e => setForm({ ...form, region: e.target.value })}>{['Europe', 'North America', 'Japan'].map(region => <option key={region}>{region}</option>)}</select></label></div>
          {form.sync_enabled && !form.sync_wishlist && !form.sync_collection && <p className="disc-field-error" role="alert">Select at least one Steam list to use automatic sync.</p>}
          <button className="btn btn-primary" disabled={busy || syncing || (form.sync_enabled && !form.sync_wishlist && !form.sync_collection)}>Save connection & preferences</button>
        </form>
        <div className="disc-sync-status"><dl><div><dt>Last successful sync</dt><dd>{timestamp(settings.last_sync_at)}</dd></div><div><dt>Next automatic sync</dt><dd>{settings.sync_enabled ? timestamp(settings.next_sync_at) : 'Paused'}</dd></div><div><dt>Wishlist import</dt><dd>{settings.last_import_count} new games</dd></div><div><dt>Library import</dt><dd>{settings.last_owned_import_count} new collection games</dd></div><div><dt>IGDB auto-completion</dt><dd>{settings.last_igdb_match_count} games matched</dd></div></dl>{syncing && <p role="status">Sync in progress… This page updates automatically.</p>}{settings.sync_error && <p className="disc-alert" role="status">{settings.sync_error}</p>}</div>
        <div className="disc-actions"><button className="btn btn-secondary" disabled={busy || !settings.steam_id || syncing} onClick={sync}><RefreshCw size={16} /> Sync now</button><button className="btn btn-secondary" disabled={busy || !settings.steam_id || syncing} onClick={() => save(undefined, true)}><Unplug size={16} /> Disconnect</button><button className="btn disc-danger-button" disabled={busy || syncing} onClick={() => setShowUnsync(true)}><Trash2 size={16} /> Unsync Steam data</button></div>
        <div className="disc-match-launch">
          <div><h3><GitCompareArrows size={18} /> Doubtful Steam matches</h3><p>Review possible matches without filling the Admin page with game entries.</p></div>
          <button className="btn btn-secondary" onClick={() => setShowReviews(true)}><GitCompareArrows size={16} /> Review matches <span className="disc-count">{reviews.length}</span></button>
        </div>
        <div className="disc-match-launch">
          <div><h3><History size={18} /> Sync history & integrity</h3><p>Inspect link decisions and verify that every copy, entitlement and projection agrees.</p></div>
          <button className="btn btn-secondary" disabled={busy} onClick={openAudit}><ShieldCheck size={16} /> Open audit</button>
        </div>
        <p className="disc-source-note">Each enabled Steam list syncs independently while preserving your edits. Exact identities and strong, unambiguous title matches link automatically; doubtful matches wait in the review popup. Choosing a collection game links the copy and uses Steam’s title. Existing console copies remain attached. If wishlist sync is enabled without collection sync, games that disappear from Steam’s wishlist stay in Games I want and are marked for review.</p>
      </section>
      <div><section className="disc-panel"><h2>Your data</h2><p className="disc-muted">Download an editable backup of Games I want. Restore it through Smart Add as JSON.</p><button className="btn btn-secondary" disabled={busy} onClick={exportGames}><Download size={17} /> Export wanted games</button></section><section className="disc-panel"><h2>Release sources</h2><p className="disc-muted">Europe combines Nintendo’s public catalog with Nintendo Life’s monthly retail guide, cached for 24 hours. IGDB remains the fallback when both sources are unavailable.</p><p className="disc-muted">Switch and Switch 2 releases are identified separately, including Game-Key Card and code-in-box listings. Regional and limited-print releases can still differ.</p></section></div>
    </div>}
    {showUnsync && <div className="disc-confirm-backdrop" onMouseDown={() => !busy && setShowUnsync(false)}>
      <section className="disc-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="unsync-title" onMouseDown={event => event.stopPropagation()}>
        <button className="disc-confirm-close" aria-label="Close" disabled={busy} onClick={() => setShowUnsync(false)}><X size={19} /></button>
        <div className="disc-confirm-icon"><Trash2 size={24} /></div>
        <h2 id="unsync-title">Unsync all Steam data?</h2>
        <p>This will pause automatic sync and remove Steam-imported games from your collection and Games I want, all Steam copies, saved links and doubtful matches.</p>
        <p>Games that existed before Steam was linked and any non-Steam copies will stay. Your Steam ID and API key will remain saved so you can regenerate the imports later.</p>
        <div className="disc-actions"><button className="btn btn-secondary" disabled={busy} onClick={() => setShowUnsync(false)}>Cancel</button><button className="btn disc-danger-button solid" disabled={busy} onClick={unsyncSteam}>{busy ? 'Removing…' : 'Yes, unsync and remove'}</button></div>
      </section>
    </div>}
    {showReviews && <div className="disc-confirm-backdrop" onMouseDown={() => reviewBusy === null && setShowReviews(false)}>
      <section className="disc-confirm-dialog disc-review-dialog" role="dialog" aria-modal="true" aria-labelledby="reviews-title" onMouseDown={event => event.stopPropagation()}>
        <button className="disc-confirm-close" aria-label="Close" disabled={reviewBusy !== null} onClick={() => setShowReviews(false)}><X size={19} /></button>
        <div className="disc-confirm-icon review"><GitCompareArrows size={24} /></div>
        <div className="disc-review-dialog-heading"><div><h2 id="reviews-title">Doubtful Steam matches</h2><p>Choose one collection game for each Steam title, or choose None of these.</p></div><span className="disc-count">{reviews.length}</span></div>
        <div className="disc-review-dialog-list">
          {reviews.length === 0 ? <p className="disc-review-empty">No doubtful Steam matches right now.</p> : reviews.map(review => <article className="disc-match-review" key={review.id}>
            <div className="disc-review-steam-title"><small>{review.match_kind === 'dlc_parent' ? 'STEAM DLC · CHOOSE PARENT' : 'STEAM GAME'}</small><strong>{review.steam_name}</strong><span>{review.candidates.length} possible {review.candidates.length === 1 ? 'match' : 'matches'}</span></div>
            <div className="disc-candidate-list" role="radiogroup" aria-label={`Collection match for ${review.steam_name}`}>{review.candidates.map(candidate => <label className={`disc-candidate ${selectedCandidates[review.id] === candidate.game_id ? 'selected' : ''}`} key={candidate.game_id}>
              <input type="radio" name={`review-${review.id}`} value={candidate.game_id} checked={selectedCandidates[review.id] === candidate.game_id} disabled={reviewBusy !== null} onChange={() => setSelectedCandidates(current => ({ ...current, [review.id]: candidate.game_id }))} />
              <span className="disc-candidate-copy"><small>COLLECTION CANDIDATE</small><strong>{candidate.name}</strong><span>{Math.round(candidate.confidence * 100)}% title similarity</span></span>
            </label>)}</div>
            <div className="disc-match-choice-actions"><button className="btn btn-primary" disabled={reviewBusy !== null || !selectedCandidates[review.id]} onClick={() => resolveReview(review, 'same')}>{review.match_kind === 'dlc_parent' ? 'Choose parent game' : 'Choose selected game'}</button><button className="btn btn-secondary" disabled={reviewBusy !== null} onClick={() => resolveReview(review, 'none')}>{review.match_kind === 'dlc_parent' ? 'Keep DLC ignored' : 'None of these'}</button></div>
          </article>)}
        </div>
        <div className="disc-actions"><button className="btn btn-secondary" disabled={reviewBusy !== null} onClick={() => setShowReviews(false)}>Close</button></div>
      </section>
    </div>}
    {showAudit && <div className="disc-confirm-backdrop" onMouseDown={() => !busy && setShowAudit(false)}>
      <section className="disc-confirm-dialog disc-review-dialog" role="dialog" aria-modal="true" aria-labelledby="audit-title" onMouseDown={event => event.stopPropagation()}>
        <button className="disc-confirm-close" aria-label="Close" disabled={busy} onClick={() => setShowAudit(false)}><X size={19} /></button>
        <div className="disc-confirm-icon review"><History size={24} /></div>
        <div className="disc-review-dialog-heading"><div><h2 id="audit-title">Steam sync history</h2><p>Persistent decisions for this connected Steam account.</p></div></div>
        {integrity && <div className={`disc-alert ${integrity.healthy ? 'success' : 'error'}`}><strong>{integrity.healthy ? 'Integrity check passed' : 'Integrity issues found'}</strong><br />{integrity.copies} copies · {integrity.steam_entitlements} Steam entitlements{!integrity.healthy && <> · {Object.values(integrity.issues).reduce((sum, value) => sum + value, 0)} issues</>}</div>}
        {integrity && !integrity.healthy && <button className="btn btn-secondary" disabled={busy} onClick={repairIntegrity}><Wrench size={16} /> Repair safe inconsistencies</button>}
        <div className="disc-review-dialog-list">{audit.length === 0 ? <p className="disc-review-empty">No Steam decisions recorded yet.</p> : audit.map(entry => <article className="disc-match-review" key={entry.id}><div className="disc-review-steam-title"><small>{timestamp(entry.created_at)}</small><strong>{entry.action.replaceAll('_', ' ')}</strong><span>{entry.steam_appid ? `Steam app ${entry.steam_appid}` : 'Account event'}{entry.collection_game_id ? ` · Collection game ${entry.collection_game_id}` : ''}</span></div></article>)}</div>
        <div className="disc-actions"><button className="btn btn-secondary" onClick={() => setShowAudit(false)}>Close</button></div>
      </section>
    </div>}
  </>;
  if (embedded) return <div className="discovery admin-steam-panel">{content}</div>;
  return <div className="container discovery">
    <Link className="disc-back" to="/dashboard/videogames/wanted">← Back to Games I want</Link>
    <VideogamePageHeader eyebrow="Games I want" icon={<Settings2 />} title="Wanted games admin" description="Your Steam connection, release preferences and data." />
    {content}
  </div>;
}
