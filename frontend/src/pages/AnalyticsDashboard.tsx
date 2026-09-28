import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BarChart3, Clock3, Gamepad2, Library, Loader2, Medal, Sparkles, Star, Target, Trophy } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fetchWithAuth } from '../lib/api';
import { YearlyRewind } from '../components/YearlyRewind';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import { calculateVideogameStats, topRankedGames, type StatsGame } from '../lib/videogameStats';
import './AnalyticsDashboard.css';

const COLORS = ['#818cf8', '#a78bfa', '#60a5fa', '#c084fc', '#2dd4bf', '#fbbf24'];
const number = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
const tooltipStyle = { backgroundColor: '#20232d', border: '1px solid #414655', borderRadius: 10, color: '#f5f5f5' };

function Metric({ label, value, note, icon }: { label: string; value: string | number; note?: string; icon: React.ReactNode }) {
  return <div className="glass-card vg-stat-metric"><span className="vg-stat-icon">{icon}</span><div><p>{label}</p><strong>{value}</strong>{note && <small>{note}</small>}</div></div>;
}

function ChartCard({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="glass-card vg-stat-panel"><h2>{title}</h2>{children}</section>;
}

export function AnalyticsDashboard() {
  const [games, setGames] = useState<StatsGame[]>([]);
  const [rankingIds, setRankingIds] = useState<number[]>([]);
  const [rankingError, setRankingError] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showRewind, setShowRewind] = useState(false);
  useEffect(() => {
    Promise.allSettled([
      fetchWithAuth('/videogames/').then(async response => {
        if (!response.ok) throw new Error('Could not load your collection statistics.');
        return response.json() as Promise<StatsGame[]>;
      }),
      fetchWithAuth('/ranking').then(async response => {
        if (!response.ok) throw new Error('Could not load your ranking.');
        return response.json() as Promise<{ game_ids: number[] }>;
      }),
    ]).then(([collection, ranking]) => {
      if (collection.status === 'fulfilled') setGames(collection.value);
      else setError(collection.reason instanceof Error ? collection.reason.message : 'Could not load statistics.');
      if (ranking.status === 'fulfilled') setRankingIds(ranking.value.game_ids);
      else setRankingError('Could not load your ranking right now.');
      setLoading(false);
    });
  }, []);
  const stats = useMemo(() => calculateVideogameStats(games), [games]);
  const topFive = useMemo(() => topRankedGames(games, rankingIds), [games, rankingIds]);
  if (showRewind && !loading) return <YearlyRewind games={games.filter(game => !game.hidden && !game.merged_into_game_id)} onClose={() => setShowRewind(false)} />;

  return <div className="container vg-support-page vg-stat-page">
    <Link to="/dashboard/videogames" className="vg-back-link"><ArrowLeft size={18} /> Back to Videogames</Link>
    <VideogamePageHeader eyebrow="Collection insights" icon={<BarChart3 />} title="Statistics" description="A closer look at what you own, what you play, and what you love." actions={<button className="btn btn-primary" disabled={loading || !!error} onClick={() => setShowRewind(true)}><Sparkles size={18} /> Open Yearly Rewind</button>} />
    {loading ? <div className="vg-stat-loading"><Loader2 className="spinner" size={32} /></div> : error ? <div className="glass-card vg-stat-empty" role="alert">{error}</div> : <>
      <div className="vg-stat-grid">
        <Metric label="Games in collection" value={stats.totalGames} note={`${stats.dlcGames} standalone DLC entries · ${stats.hiddenGames} hidden`} icon={<Gamepad2 />} />
        <Metric label="Time played" value={`${number(stats.totalPlaytime)} h`} note="Shared Steam time counted once" icon={<Clock3 />} />
        <Metric label="Finished games" value={stats.finishedGames} note={`${number(stats.finishRate * 100)}% of games started`} icon={<Trophy />} />
        <Metric label="Average rating" value={stats.avgRating == null ? '—' : number(stats.avgRating)} note={`${stats.ratedCount} rated · median ${stats.medianRating == null ? '—' : number(stats.medianRating)}`} icon={<Star />} />
        <Metric label="Currently active" value={stats.activeGames} note="Playing or Infinite" icon={<Target />} />
        <Metric label="Backlog" value={stats.backlogGames} note="Games not started" icon={<Library />} />
        <Metric label="Finished this year" value={stats.finishedThisYear} note="Based on completion date" icon={<Medal />} />
        <Metric label="Checked records" value={`${stats.reviewedCount}/${stats.totalGames}`} note={`${stats.totalGames ? number(stats.reviewedCount / stats.totalGames * 100) : 0}% reviewed`} icon={<Sparkles />} />
      </div>
      <div className="vg-stat-section-heading"><span>01 / PROGRESS</span><h2>How the collection is going</h2></div>
      <div className="vg-stat-charts">
        <ChartCard title="Status breakdown"><div className="vg-stat-chart">{stats.totalGames ? <ResponsiveContainer minWidth={0}><PieChart><Pie data={stats.statusCounts.filter(row => row.value)} dataKey="value" nameKey="name" innerRadius={66} outerRadius={105} paddingAngle={3}>{stats.statusCounts.filter(row => row.value).map((row, index) => <Cell key={row.name} fill={COLORS[index % COLORS.length]} />)}</Pie><Tooltip contentStyle={tooltipStyle} /></PieChart></ResponsiveContainer> : <p className="text-muted">Add games to see their status.</p>}</div><div className="vg-stat-legend">{stats.statusCounts.map((row, index) => <div key={row.name}><i style={{ background: COLORS[index % COLORS.length] }} />{row.name}<strong>{row.value}</strong></div>)}</div></ChartCard>
        <ChartCard title="Rating distribution"><div className="vg-stat-chart"><ResponsiveContainer minWidth={0}><BarChart data={stats.ratingCounts}><CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} /><XAxis dataKey="name" stroke="var(--text-muted)" /><YAxis allowDecimals={false} stroke="var(--text-muted)" /><Tooltip contentStyle={tooltipStyle} /><Bar dataKey="value" name="Games" fill="#818cf8" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div><p className="vg-stat-note">{stats.highRatedCount} games rated 9 or 10. {stats.averageCompletion == null ? 'Add completion percentages to track progress.' : `Average recorded completion of started games: ${number(stats.averageCompletion)}%.`}</p></ChartCard>
        <ChartCard title="Finishes by year"><div className="vg-stat-chart">{stats.completionYears.length ? <ResponsiveContainer minWidth={0}><BarChart data={stats.completionYears}><CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} /><XAxis dataKey="name" stroke="var(--text-muted)" /><YAxis allowDecimals={false} stroke="var(--text-muted)" /><Tooltip contentStyle={tooltipStyle} /><Bar dataKey="value" name="Finished" fill="#2dd4bf" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer> : <p className="text-muted">Completion dates will appear here.</p>}</div></ChartCard>
        <ChartCard title="Release decades"><div className="vg-stat-chart">{stats.releaseDecades.length ? <ResponsiveContainer minWidth={0}><BarChart data={stats.releaseDecades}><CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" vertical={false} /><XAxis dataKey="name" tickFormatter={value => `${value}s`} stroke="var(--text-muted)" /><YAxis allowDecimals={false} stroke="var(--text-muted)" /><Tooltip contentStyle={tooltipStyle} /><Bar dataKey="value" name="Games" fill="#c084fc" radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer> : <p className="text-muted">Publication years will appear here.</p>}</div></ChartCard>
      </div>
      <div className="vg-stat-section-heading"><span>02 / LIBRARY</span><h2>What is on the shelf</h2></div>
      <div className="vg-stat-grid vg-stat-grid-compact">
        <Metric label="Owned copies" value={stats.ownedCopies} note={`${stats.oldCopies} old copies kept in history`} icon={<Library />} />
        <Metric label="Steam copies" value={stats.steamCopies} note="Currently linked" icon={<Gamepad2 />} />
        <Metric label="Physical / digital" value={`${stats.physicalCopies} / ${stats.digitalCopies}`} note="Among owned copies with a type" icon={<Library />} />
        <Metric label="DLCs owned" value={`${stats.ownedDlcs}/${stats.dlcCount}`} note="Across base-game DLC lists" icon={<Trophy />} />
      </div>
      <div className="vg-stat-charts">
        <ChartCard title="Top platforms"><div className="vg-stat-bars">{stats.platformCounts.slice(0, 8).map(row => <div key={row.name}><span>{row.name}</span><div><i style={{ width: `${row.value / (stats.platformCounts[0]?.value || 1) * 100}%` }} /></div><strong>{row.value}</strong></div>)}{!stats.platformCounts.length && <p className="text-muted">Add owned copies to see platforms.</p>}</div></ChartCard>
        <ChartCard title="Most used tags"><div className="vg-stat-bars">{stats.tagCounts.slice(0, 8).map(row => <div key={row.name}><span>{row.name}</span><div><i style={{ width: `${row.value / (stats.tagCounts[0]?.value || 1) * 100}%` }} /></div><strong>{row.value}</strong></div>)}{!stats.tagCounts.length && <p className="text-muted">Tag games to see your themes.</p>}</div></ChartCard>
        <ChartCard title="Most played"><ol className="vg-stat-toplist">{stats.mostPlayed.map(row => <li key={row.game.id}><span>{row.game.name}</span><strong>{number(row.hours)} h</strong></li>)}{!stats.mostPlayed.length && <p className="text-muted">Log playtime to see your most played games.</p>}</ol></ChartCard>
        <ChartCard title="Top 5 in Ranking"><ol className="vg-stat-toplist">{topFive.map((game, index) => <li key={game.id}><span>#{index + 1} {game.name}</span><strong>{game.mark}/10</strong></li>)}{!topFive.length && <p className="text-muted">{rankingError || 'Rate games to see your favorites.'}</p>}</ol><Link className="vg-stat-ranking-link" to="/dashboard/videogames/ranking">Open your Ranking →</Link></ChartCard>
      </div>
      <p className="vg-stat-footnote">Statistics use visible collection games. Standalone DLC entries and hidden records are shown separately. Playtime follows each game’s selected playtime mode.</p>
    </>}
  </div>;
}
