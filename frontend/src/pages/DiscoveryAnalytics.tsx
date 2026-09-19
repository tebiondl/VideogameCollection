import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { BarChart3 } from 'lucide-react';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import { discoveryApi, errorMessage } from '../lib/discovery';
import './Discovery.css';

interface Stats { total: number; active: number; acquired: number; dlcs: number; nested_dlcs: number; average_hype: number | null; budgets: Record<string, number>; by_platform: Record<string, number>; by_status: Record<string, number>; by_source: Record<string, number>; by_month: Record<string, number> }
function Breakdown({ title, values }: { title: string; values: Record<string, number> }) {
  const max = Math.max(1, ...Object.values(values));
  return <section className="disc-panel"><h2>{title}</h2>{Object.keys(values).length ? Object.entries(values).map(([label, count]) => <div className="disc-bar-row" key={label}><div><span>{label}</span><strong>{count}</strong></div><div className="disc-bar-track"><div style={{ width: `${count / max * 100}%` }} /></div></div>) : <p className="disc-muted">No data yet.</p>}</section>;
}
export function DiscoveryAnalytics() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => { let cancelled = false; discoveryApi<Stats>('/analytics').then(data => { if (!cancelled) { setStats(data); setError(''); } }).catch(e => { if (!cancelled) setError(errorMessage(e)); }); return () => { cancelled = true; }; }, [reload]);
  return <div className="container discovery"><Link className="disc-back" to="/dashboard/videogames/wanted">← Back to Games I want</Link><VideogamePageHeader eyebrow="Wanted games" icon={<BarChart3 />} title="What’s on your radar" description="Anticipation, platforms and the journey from wanted to owned." />
    {error && <p className="disc-alert error" role="alert">{error} <button className="disc-text-button" onClick={() => setReload(value => value + 1)}>Retry</button></p>}
    {!stats && !error && <p className="disc-empty">Loading Discovery analytics…</p>}
    {stats && <><div className="disc-stats">{[['Games on your radar', stats.active], ['Acquired', stats.acquired], ['Average anticipation', stats.average_hype == null ? '—' : `${stats.average_hype}/10`], ['Standalone DLCs', stats.dlcs]].map(([label, value]) => <div className="disc-stat" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      {stats.total === 0 && <p className="disc-alert">Save your first game or connect Steam to start seeing your Discovery trends.</p>}
      <div className="disc-admin-grid"><Breakdown title="Platforms" values={stats.by_platform} /><Breakdown title="Status" values={stats.by_status} /><Breakdown title="Where you found them" values={stats.by_source} /><Breakdown title="Saved each month" values={stats.by_month} /></div>
      <section className="disc-panel"><h2>Target budget</h2><p className="disc-muted">Sum of target prices for games not acquired. Currencies are kept separate; games without a target price are excluded.</p><div className="disc-budget">{Object.entries(stats.budgets).map(([currency, value]) => <strong key={currency}>{new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(value)}</strong>)}{!Object.keys(stats.budgets).length && <span>No target prices set yet.</span>}</div><p className="disc-muted">{stats.nested_dlcs} DLCs are also tracked inside saved games. Nested DLCs are excluded from game totals and budgets.</p></section>
    </>}
  </div>;
}
