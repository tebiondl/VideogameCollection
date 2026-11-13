import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BarChart3, CalendarCheck, Clock3, Coins, Copy, Eye, Flame, Gamepad2, Hourglass, Library, Loader2, Medal, Sparkles, Star, Target, Trophy } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { fetchWithAuth } from '../lib/api';
import { YearlyRewind } from '../components/YearlyRewind';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import { calculateVideogameStats, topRankedGames, type StatsGame } from '../lib/videogameStats';
import './AnalyticsDashboard.css';

// Categorical slots in a fixed order, checked for colour-blind separation on the dark card surface.
// A status keeps its colour whichever statuses are present.
const STATUS_COLORS: Record<string, string> = {
  'Not Started': '#3987e5', Playing: '#d95926', Finished: '#199e70', Viewed: '#c98500', Stopped: '#d55181', Infinite: '#9085e9',
};
const SERIES = 'var(--accent-primary)';
const number = (value: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${number(Math.abs(value))}`;
const tooltipStyle = { backgroundColor: 'var(--bg-raised)', border: '1px solid var(--border-strong)', borderRadius: 10, color: 'var(--text-primary)', fontSize: 13 };
const tooltipProps = { contentStyle: tooltipStyle, itemStyle: { color: 'var(--text-primary)' }, labelStyle: { color: 'var(--text-secondary)' }, cursor: { fill: 'rgba(255,255,255,.04)' } };
const axis = { stroke: 'var(--border-strong)', tick: { fill: 'var(--text-muted)', fontSize: 12 }, tickLine: false };

function Metric({ label, value, note, icon }: { label: string; value: string | number; note?: string; icon: ReactNode }) {
  return <div className="vg-stat-metric"><span className="vg-stat-icon">{icon}</span><div><p>{label}</p><strong>{value}</strong>{note && <small>{note}</small>}</div></div>;
}

function ChartCard({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <section className="vg-stat-panel"><header><h3>{title}</h3>{hint && <p>{hint}</p>}</header>{children}</section>;
}

function SectionHeading({ id, index, title }: { id: string; index: string; title: string }) {
  return <div className="vg-stat-section-heading" id={id}><span>{index}</span><h2>{title}</h2></div>;
}

/** Ranked horizontal bars with the value written beside each one. */
function BarList({ rows, format = number, empty, max }: { rows: Array<{ name: string; value: number; note?: string }>; format?: (value: number) => string; empty: string; max?: number }) {
  if (!rows.length) return <p className="vg-stat-none">{empty}</p>;
  const top = max ?? Math.max(...rows.map(row => row.value), 1);
  return <div className="vg-stat-bars">{rows.map(row => <div key={row.name} title={`${row.name}: ${format(row.value)}${row.note ? ` · ${row.note}` : ''}`}>
    <span>{row.name}</span><div><i style={{ width: `${Math.max(2, row.value / top * 100)}%` }} /></div><strong>{format(row.value)}{row.note && <small>{row.note}</small>}</strong>
  </div>)}</div>;
}

function TopList({ rows, empty }: { rows: Array<{ key: string | number; name: string; value: string }>; empty: string }) {
  if (!rows.length) return <p className="vg-stat-none">{empty}</p>;
  return <ol className="vg-stat-toplist">{rows.map(row => <li key={row.key}><span title={row.name}>{row.name}</span><strong>{row.value}</strong></li>)}</ol>;
}

function Columns({ data, name, unit = '' }: { data: Array<{ name: string; value: number }>; name: string; unit?: string }) {
  return <div className="vg-stat-chart"><ResponsiveContainer minWidth={0}><BarChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }} barCategoryGap="22%">
    <CartesianGrid stroke="var(--border-color)" vertical={false} />
    <XAxis dataKey="name" {...axis} /><YAxis allowDecimals={false} {...axis} axisLine={false} />
    <Tooltip {...tooltipProps} formatter={value => [`${number(Number(value))}${unit}`, name]} />
    <Bar dataKey="value" name={name} fill={SERIES} radius={[4, 4, 0, 0]} maxBarSize={44} />
  </BarChart></ResponsiveContainer></div>;
}

const SECTIONS = [['progress', 'Progress'], ['playtime', 'Playtime'], ['taste', 'Taste'], ['library', 'Library'], ['spending', 'Spending']];

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
  if (showRewind && !loading) return <YearlyRewind games={games} rankingIds={rankingIds} onClose={() => setShowRewind(false)} />;

  const year = new Date().getFullYear();
  const statuses = stats.statusCounts.filter(row => row.value);
  const money = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: stats.mainCurrency, maximumFractionDigits: value >= 100 ? 0 : 2 }).format(value);
  const anyCurrency = (value: number, currency: string) => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value);

  return <div className="container vg-support-page vg-stat-page">
    <Link to="/dashboard/videogames" className="vg-back-link"><ArrowLeft size={18} /> Back to Videogames</Link>
    <VideogamePageHeader eyebrow="Collection insights" icon={<BarChart3 />} title="Statistics" description="A closer look at what you own, what you play, and what you love." actions={<button className="btn btn-primary" disabled={loading || !!error} onClick={() => setShowRewind(true)}><Sparkles size={18} /> Open Yearly Rewind</button>} />
    {loading ? <div className="vg-stat-loading"><Loader2 className="spinner" size={32} /></div> : error ? <div className="glass-card vg-stat-empty" role="alert">{error}</div> : <>
      <div className="vg-stat-hero">
        <Metric label="Games in collection" value={stats.totalGames} note={`${stats.dlcGames} standalone DLC · ${stats.hiddenGames} hidden`} icon={<Gamepad2 />} />
        <Metric label="Time played" value={`${number(stats.totalPlaytime)} h`} note={`${number(stats.totalPlaytime / 24)} days · Steam time counted once`} icon={<Clock3 />} />
        <Metric label="Finished games" value={stats.finishedGames} note={`${number(stats.finishRate * 100)}% of games started`} icon={<Trophy />} />
        <Metric label="Average rating" value={stats.avgRating == null ? '—' : number(stats.avgRating)} note={`${stats.ratedCount} rated · median ${stats.medianRating == null ? '—' : number(stats.medianRating)}`} icon={<Star />} />
      </div>
      <nav className="vg-stat-jump" aria-label="Statistics sections">{SECTIONS.map(([id, label]) => <a key={id} href={`#${id}`}>{label}</a>)}</nav>

      <SectionHeading id="progress" index="01 / PROGRESS" title="How the collection is going" />
      <div className="vg-stat-grid">
        <Metric label="Currently active" value={stats.activeGames} note="Playing or Infinite" icon={<Target />} />
        <Metric label="Backlog" value={stats.backlogGames} note={stats.totalGames ? `${number(stats.backlogGames / stats.totalGames * 100)}% of the collection` : 'Games not started'} icon={<Library />} />
        <Metric label={`Finished in ${year}`} value={stats.finishedThisYear} note="Based on completion date" icon={<Medal />} />
        <Metric label="Viewed games" value={stats.viewedGames} note="Watched on YouTube or elsewhere" icon={<Eye />} />
        <Metric label="Checked records" value={`${stats.reviewedCount}/${stats.totalGames}`} note={`${stats.totalGames ? number(stats.reviewedCount / stats.totalGames * 100) : 0}% reviewed`} icon={<Sparkles />} />
      </div>
      <div className="vg-stat-charts">
        <ChartCard title="Status breakdown" hint="Every base game by its current status.">
          {statuses.length ? <div className="vg-stat-donut">
            <div className="vg-stat-chart small"><ResponsiveContainer minWidth={0}><PieChart><Pie data={statuses} dataKey="value" nameKey="name" innerRadius={62} outerRadius={92} paddingAngle={2} stroke="var(--bg-secondary)" strokeWidth={2}>{statuses.map(row => <Cell key={row.name} fill={STATUS_COLORS[row.name]} />)}</Pie><Tooltip {...tooltipProps} /></PieChart></ResponsiveContainer><div className="vg-stat-donut-total"><strong>{stats.totalGames}</strong><span>games</span></div></div>
            <ul className="vg-stat-legend">{stats.statusCounts.map(row => <li key={row.name}><i style={{ background: STATUS_COLORS[row.name] }} /><span>{row.name}</span><strong>{row.value}</strong><small>{stats.totalGames ? `${number(row.value / stats.totalGames * 100)}%` : ''}</small></li>)}</ul>
          </div> : <p className="vg-stat-none">Add games to see their status.</p>}
        </ChartCard>
        <ChartCard title={`Finishes in ${year}`} hint="Games finished each month, by completion date.">
          {stats.finishedThisYear ? <Columns data={stats.finishesByMonth} name="Finished" /> : <p className="vg-stat-none">Nothing finished this year yet. Completion dates with a month appear here.</p>}
        </ChartCard>
        <ChartCard title="Finishes by year">
          {stats.completionYears.length ? <Columns data={stats.completionYears} name="Finished" /> : <p className="vg-stat-none">Completion dates will appear here.</p>}
        </ChartCard>
        <ChartCard title="Most hyped in the backlog" hint="Not started yet, highest hype first.">
          <TopList rows={stats.backlogByHype.map(game => ({ key: game.id, name: game.name, value: `Hype ${game.hype}/10` }))} empty="Give backlog games a hype score to see what to play next." />
        </ChartCard>
      </div>

      <SectionHeading id="playtime" index="02 / PLAYTIME" title="Where the hours went" />
      <div className="vg-stat-grid">
        <Metric label="Games with logged time" value={stats.playedWithTime} note={stats.playedWithTime ? `${number(stats.totalPlaytime / stats.playedWithTime)} h on average` : 'Log playtime to see more'} icon={<Hourglass />} />
        <Metric label="Typical finished game" value={stats.medianHoursFinished == null ? '—' : `${number(stats.medianHoursFinished)} h`} note={stats.averageHoursFinished == null ? 'Median time to finish' : `Median · average ${number(stats.averageHoursFinished)} h`} icon={<CalendarCheck />} />
        <Metric label="Average completion" value={stats.averageCompletion == null ? '—' : `${number(stats.averageCompletion)}%`} note="Recorded completion of started games" icon={<Target />} />
      </div>
      <div className="vg-stat-charts">
        <ChartCard title="How long games last" hint="Games with logged time, by total hours.">
          {stats.playedWithTime ? <Columns data={stats.playtimeBuckets} name="Games" /> : <p className="vg-stat-none">Log playtime to see this.</p>}
        </ChartCard>
        <ChartCard title="Hours by status">
          <BarList rows={stats.playtimeByStatus} format={value => `${number(value)} h`} empty="Log playtime to see this." />
        </ChartCard>
        <ChartCard title="Hours by tag" hint="A game with several tags counts towards each.">
          <BarList rows={stats.hoursByTag.slice(0, 8)} format={value => `${number(value)} h`} empty="Tag played games to see your themes." />
        </ChartCard>
        <ChartCard title="Most played">
          <TopList rows={stats.mostPlayed.map(row => ({ key: row.game.id, name: row.game.name, value: `${number(row.hours)} h` }))} empty="Log playtime to see your most played games." />
        </ChartCard>
        <ChartCard title="Longest games you finished">
          <TopList rows={stats.longestFinished.map(row => ({ key: row.game.id, name: row.game.name, value: `${number(row.hours)} h` }))} empty="Finish a game with logged time to see it here." />
        </ChartCard>
      </div>

      <SectionHeading id="taste" index="03 / TASTE" title="What you love" />
      <div className="vg-stat-grid">
        <Metric label="Rated 9 or 10" value={stats.highRatedCount} note={stats.ratedCount ? `${number(stats.highRatedCount / stats.ratedCount * 100)}% of rated games` : 'Rate games to see this'} icon={<Flame />} />
        <Metric label="Rating vs. hype" value={stats.averageHypeDelta == null ? '—' : signed(stats.averageHypeDelta)} note={stats.hypeComparedCount ? `Average across ${stats.hypeComparedCount} games with both scores` : 'Needs games with a hype and a rating'} icon={<Sparkles />} />
        <Metric label="Finished but unrated" value={stats.unratedFinished} note="Finished games waiting for a rating" icon={<Star />} />
      </div>
      <div className="vg-stat-charts">
        <ChartCard title="Rating distribution">
          {stats.ratedCount ? <Columns data={stats.ratingCounts} name="Games" /> : <p className="vg-stat-none">Rate games to see the spread.</p>}
        </ChartCard>
        <ChartCard title="Average rating by tag" hint="Tags with at least three rated games.">
          <BarList rows={stats.ratingByTag.slice(0, 8).map(row => ({ name: row.name, value: row.value, note: `${row.count} games` }))} max={10} empty="Tag at least three rated games to compare tags." />
        </ChartCard>
        <ChartCard title="Average rating by release decade">
          <BarList rows={stats.ratingByDecade.map(row => ({ name: `${row.name}s`, value: row.value, note: `${row.count} games` }))} max={10} empty="Rated games with a release year appear here." />
        </ChartCard>
        <ChartCard title="Top 5 in Ranking">
          <TopList rows={topFive.map((game, index) => ({ key: game.id, name: `#${index + 1} ${game.name}`, value: `${game.mark}/10` }))} empty={rankingError || 'Rate games to see your favorites.'} />
          <Link className="vg-stat-ranking-link" to="/dashboard/videogames/ranking">Open your Ranking →</Link>
        </ChartCard>
        <ChartCard title="Pleasant surprises" hint="Rated well above the hype you gave them.">
          <TopList rows={stats.surprises.map(row => ({ key: row.game.id, name: row.game.name, value: `${row.game.hype} → ${row.game.mark} (${signed(row.delta)})` }))} empty="No game has beaten its hype yet." />
        </ChartCard>
        <ChartCard title="Letdowns" hint="Rated below the hype you gave them.">
          <TopList rows={stats.letdowns.map(row => ({ key: row.game.id, name: row.game.name, value: `${row.game.hype} → ${row.game.mark} (${signed(row.delta)})` }))} empty="Nothing has fallen short of its hype." />
        </ChartCard>
      </div>

      <SectionHeading id="library" index="04 / LIBRARY" title="What is on the shelf" />
      <div className="vg-stat-grid">
        <Metric label="Owned copies" value={stats.ownedCopies} note={`${stats.oldCopies} old copies kept in history`} icon={<Library />} />
        <Metric label="Physical / digital" value={`${stats.physicalCopies} / ${stats.digitalCopies}`} note="Among owned copies with a type" icon={<Library />} />
        <Metric label="Steam copies" value={stats.steamCopies} note="Currently linked" icon={<Gamepad2 />} />
        <Metric label="Owned more than once" value={stats.multiCopyGames} note="Games with several copies" icon={<Copy />} />
        <Metric label="DLCs owned" value={`${stats.ownedDlcs}/${stats.dlcCount}`} note="Across base-game DLC lists" icon={<Trophy />} />
      </div>
      <div className="vg-stat-charts">
        <ChartCard title="Copies by platform"><BarList rows={stats.platformCounts.slice(0, 8)} empty="Add owned copies to see platforms." /></ChartCard>
        <ChartCard title="Where copies came from"><BarList rows={stats.sourceCounts.slice(0, 8)} empty="Set a source on your copies to see this." /></ChartCard>
        <ChartCard title="Physical copies by region"><BarList rows={stats.physicalRegionCounts.slice(0, 8)} empty="Add physical copies to see their regions." /></ChartCard>
        <ChartCard title="Most used tags"><BarList rows={stats.tagCounts.slice(0, 8)} empty="Tag games to see your themes." /></ChartCard>
        <ChartCard title="Release decades">
          {stats.releaseDecades.length ? <Columns data={stats.releaseDecades.map(row => ({ ...row, name: `${row.name}s` }))} name="Games" /> : <p className="vg-stat-none">Publication years will appear here.</p>}
        </ChartCard>
      </div>

      <SectionHeading id="spending" index="05 / SPENDING" title="What it cost" />
      {stats.pricedCopies ? <>
        <div className="vg-stat-grid">
          <Metric label="Total recorded" value={money(stats.spendingByCurrency[0].value)} note={stats.spendingByCurrency.length > 1 ? `Plus ${stats.spendingByCurrency.slice(1).map(row => anyCurrency(row.value, row.name)).join(', ')}` : `${stats.pricedCopies} of ${stats.ownedCopies} copies have a price`} icon={<Coins />} />
          <Metric label="Average per copy" value={stats.averagePrice == null ? '—' : money(stats.averagePrice)} note={`Copies priced in ${stats.mainCurrency}`} icon={<Coins />} />
          <Metric label="Cost per hour" value={stats.totalPlaytime ? money(stats.spendingByCurrency[0].value / stats.totalPlaytime) : '—'} note="Recorded spend over all time played" icon={<Clock3 />} />
        </div>
        <div className="vg-stat-charts">
          <ChartCard title="Spend by platform" hint={`Copies priced in ${stats.mainCurrency}.`}><BarList rows={stats.spendingByPlatform.slice(0, 8)} format={money} empty="No priced copies." /></ChartCard>
          <ChartCard title="Most expensive copies"><TopList rows={stats.mostExpensive.map(row => ({ key: row.id, name: `${row.name}${row.platform ? ` · ${row.platform}` : ''}`, value: money(row.price) }))} empty="No priced copies." /></ChartCard>
        </div>
      </> : <p className="vg-stat-panel vg-stat-none">Add a price to your owned copies to see what the collection cost, by platform and per hour played.</p>}

      <p className="vg-stat-footnote">Statistics use visible collection games. Standalone DLC entries and hidden records are shown separately. Playtime follows each game’s selected playtime mode.</p>
    </>}
  </div>;
}
