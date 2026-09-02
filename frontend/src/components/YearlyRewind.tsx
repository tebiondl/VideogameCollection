import { useMemo, useState } from 'react';
import {
  ArrowLeft, Award, CalendarDays, Clock3, Crown, Flame, Gamepad2,
  Gem, Layers3, Medal, Sparkles, Star, Tags, Target, Trophy, Zap
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip as RechartsTooltip, XAxis, YAxis
} from 'recharts';
import './YearlyRewind.css';

export interface RewindGame {
  id: number;
  name: string;
  image_url?: string | null;
  status?: string | null;
  playtime_hours?: number | null;
  mark?: number | null;
  hype?: number | null;
  completion_date?: string | null;
  publication_year?: number | null;
  completion_percentage?: number | null;
  tags?: string | null;
}

interface YearlyRewindProps {
  games: RewindGame[];
  onClose: () => void;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const REWIND_COLORS = ['#8b5cf6', '#22d3ee', '#f97316', '#ec4899', '#84cc16', '#facc15'];

function parseTags(raw?: string | null): string[] {
  if (!raw) return [];
  try {
    const decoded = JSON.parse(raw);
    if (Array.isArray(decoded)) return decoded.map(String).map(tag => tag.trim()).filter(Boolean);
  } catch {
    // Legacy values are stored as comma-separated strings.
  }
  return raw.split(',').map(tag => tag.trim()).filter(Boolean);
}

function yearFromDate(value?: string | null): number | null {
  const match = value?.match(/^(\d{4})/);
  return match ? Number(match[1]) : null;
}

function formatHours(value: number): string {
  return value >= 1000
    ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)}h`
    : `${value.toFixed(value >= 100 ? 0 : 1)}h`;
}

function GameCover({ game, rank }: { game: RewindGame; rank?: number }) {
  return (
    <div className="rewind-game-cover">
      {game.image_url
        ? <img src={game.image_url} alt={`${game.name} cover`} />
        : <div className="rewind-cover-placeholder"><Gamepad2 size={28} /></div>}
      {rank && <span className="rewind-rank">#{rank}</span>}
    </div>
  );
}

export function YearlyRewind({ games, onClose }: YearlyRewindProps) {
  const currentYear = new Date().getFullYear();
  const availableYears = useMemo(() => {
    const years = new Set<number>([currentYear]);
    games.forEach(game => {
      const year = yearFromDate(game.completion_date);
      if (year) years.add(year);
    });
    return [...years].sort((a, b) => b - a);
  }, [games, currentYear]);
  const [selectedYear, setSelectedYear] = useState(availableYears[0]);

  const rewind = useMemo(() => {
    const playedGames = games.filter(game => {
      const completedInYear = yearFromDate(game.completion_date) === selectedYear;
      const activeNow = selectedYear === currentYear && (game.status === 'Playing' || game.status === 'Infinite');
      return completedInYear || activeNow;
    });
    const completedGames = playedGames.filter(game => yearFromDate(game.completion_date) === selectedYear && game.status === 'Finished');
    const recordedHours = playedGames.reduce((sum, game) => sum + Math.max(0, Number(game.playtime_hours) || 0), 0);
    const ratedGames = playedGames.filter(game => typeof game.mark === 'number' && game.mark > 0);
    const averageRating = ratedGames.length
      ? ratedGames.reduce((sum, game) => sum + (game.mark || 0), 0) / ratedGames.length
      : 0;
    const mostPlayed = [...playedGames]
      .filter(game => Number(game.playtime_hours) > 0)
      .sort((a, b) => (b.playtime_hours || 0) - (a.playtime_hours || 0));
    const topRated = [...ratedGames].sort((a, b) => (b.mark || 0) - (a.mark || 0) || (b.playtime_hours || 0) - (a.playtime_hours || 0));

    const tagMap = new Map<string, { name: string; hours: number; games: number }>();
    playedGames.forEach(game => {
      parseTags(game.tags).forEach(tag => {
        const key = tag.toLocaleLowerCase();
        const entry = tagMap.get(key) || { name: tag, hours: 0, games: 0 };
        entry.hours += Math.max(0, Number(game.playtime_hours) || 0);
        entry.games += 1;
        tagMap.set(key, entry);
      });
    });
    const tags = [...tagMap.values()].sort((a, b) => b.hours - a.hours || b.games - a.games || a.name.localeCompare(b.name));

    const monthlyCompletions = MONTHS.map(month => ({ month, games: 0 }));
    completedGames.forEach(game => {
      const match = game.completion_date?.match(/^\d{4}-(\d{1,2})/);
      if (match) {
        const monthIndex = Number(match[1]) - 1;
        if (monthlyCompletions[monthIndex]) monthlyCompletions[monthIndex].games += 1;
      }
    });

    const statusMap = new Map<string, number>();
    playedGames.forEach(game => statusMap.set(game.status || 'Unknown', (statusMap.get(game.status || 'Unknown') || 0) + 1));
    const statusData = [...statusMap].map(([name, value]) => ({ name, value }));
    const datedCompletions = completedGames
      .filter(game => /^\d{4}-\d{1,2}/.test(game.completion_date || ''))
      .sort((a, b) => (a.completion_date || '').localeCompare(b.completion_date || ''));
    const releaseYears = playedGames.map(game => game.publication_year).filter((year): year is number => typeof year === 'number');
    const oldestRelease = releaseYears.length ? Math.min(...releaseYears) : null;
    const newestRelease = releaseYears.length ? Math.max(...releaseYears) : null;
    const perfectScores = ratedGames.filter(game => game.mark === 10).length;
    const marathons = playedGames.filter(game => (game.playtime_hours || 0) >= 50).length;
    const quickWins = completedGames.filter(game => (game.playtime_hours || 0) > 0 && (game.playtime_hours || 0) < 12).length;
    const deepCuts = playedGames.filter(game => game.publication_year && game.publication_year < selectedYear - 10).length;
    const averageGameLength = playedGames.length ? recordedHours / playedGames.length : 0;

    let persona = 'The Explorer';
    let personaCopy = 'You kept your year varied and made room for different kinds of adventures.';
    if (tags[0]) {
      persona = `The ${tags[0].name} Specialist`;
      personaCopy = `${tags[0].name} led your year with ${formatHours(tags[0].hours)} across ${tags[0].games} ${tags[0].games === 1 ? 'game' : 'games'}.`;
    }
    if (marathons >= Math.max(2, playedGames.length / 2)) {
      persona = 'The Deep Diver';
      personaCopy = `You went long: ${marathons} games crossed the 50-hour mark.`;
    } else if (completedGames.length >= 12) {
      persona = 'The Finisher';
      personaCopy = `${completedGames.length} finishes made this a year of rolling credits.`;
    }

    return {
      playedGames, completedGames, recordedHours, averageRating, mostPlayed, topRated,
      tags, monthlyCompletions, statusData, datedCompletions, oldestRelease, newestRelease,
      perfectScores, marathons, quickWins, deepCuts, averageGameLength, persona, personaCopy
    };
  }, [games, selectedYear, currentYear]);

  const gameOfTheYear = rewind.topRated[0] || rewind.mostPlayed[0] || rewind.playedGames[0];

  return (
    <div className="rewind-shell">
      <div className="rewind-aurora rewind-aurora-one" />
      <div className="rewind-aurora rewind-aurora-two" />
      <nav className="rewind-nav">
        <button className="rewind-back" onClick={onClose}><ArrowLeft size={18} /> Analytics</button>
        <div className="rewind-year-picker">
          <CalendarDays size={17} />
          <select value={selectedYear} onChange={event => setSelectedYear(Number(event.target.value))} aria-label="Rewind year">
            {availableYears.map(year => <option key={year} value={year}>{year}</option>)}
          </select>
        </div>
      </nav>

      <header className="rewind-hero">
        <div className="rewind-kicker"><Sparkles size={16} /> Your year in games</div>
        <h1><span>{selectedYear}</span> Rewind</h1>
        <p>{rewind.playedGames.length
          ? `${rewind.playedGames.length} worlds, one unforgettable year.`
          : 'Your next great gaming year is waiting to be tracked.'}</p>
        <div className="rewind-cover-fan" aria-hidden="true">
          {rewind.mostPlayed.slice(0, 5).map((game, index) => (
            <div key={game.id} style={{ '--cover-index': index } as React.CSSProperties}><GameCover game={game} /></div>
          ))}
        </div>
      </header>

      {rewind.playedGames.length === 0 ? (
        <section className="rewind-empty">
          <Gamepad2 size={44} />
          <h2>No tracked activity for {selectedYear}</h2>
          <p>Add a completion date to finished games to place them in a past rewind. Currently Playing and Infinite games automatically appear in the current year.</p>
        </section>
      ) : (
        <main className="rewind-content">
          <section className="rewind-stat-strip">
            <div><Gamepad2 /><span>{rewind.playedGames.length}</span><small>games in your year</small></div>
            <div><Clock3 /><span>{formatHours(rewind.recordedHours)}</span><small>recorded playtime</small></div>
            <div><Trophy /><span>{rewind.completedGames.length}</span><small>credits rolled</small></div>
            <div><Star /><span>{rewind.averageRating ? rewind.averageRating.toFixed(1) : '—'}</span><small>average rating</small></div>
          </section>

          {gameOfTheYear && (
            <section className="rewind-feature-card">
              <div className="rewind-feature-art">
                {gameOfTheYear.image_url ? <img src={gameOfTheYear.image_url} alt="" /> : <div className="rewind-cover-placeholder"><Crown size={54} /></div>}
                <div className="rewind-feature-shade" />
              </div>
              <div className="rewind-feature-copy">
                <div className="rewind-kicker"><Crown size={16} /> Game of the year</div>
                <h2>{gameOfTheYear.name}</h2>
                <p>{gameOfTheYear.mark ? `Your ${gameOfTheYear.mark}/10 champion` : 'The title that defined your year'}{gameOfTheYear.playtime_hours ? ` · ${formatHours(gameOfTheYear.playtime_hours)} recorded` : ''}</p>
                <div className="rewind-feature-tags">{parseTags(gameOfTheYear.tags).slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}</div>
              </div>
            </section>
          )}

          <section className="rewind-section">
            <div className="rewind-section-heading"><div><span>01</span><h2>Your most played</h2></div><p>Lifetime playtime recorded for games in this rewind.</p></div>
            <div className="rewind-podium">
              {rewind.mostPlayed.slice(0, 5).map((game, index) => (
                <article key={game.id} className={index === 0 ? 'rewind-top-game' : ''}>
                  <GameCover game={game} rank={index + 1} />
                  <div><h3>{game.name}</h3><p><Clock3 size={14} /> {formatHours(game.playtime_hours || 0)}</p></div>
                </article>
              ))}
            </div>
          </section>

          <section className="rewind-two-column">
            <article className="rewind-panel rewind-tag-panel">
              <div className="rewind-panel-icon"><Tags /></div>
              <p className="rewind-kicker">Your favorite lane</p>
              <h2>{rewind.tags[0]?.name || 'Genre hopper'}</h2>
              <p>{rewind.tags[0] ? `${formatHours(rewind.tags[0].hours)} recorded across ${rewind.tags[0].games} games` : 'No tags were attached to this year’s games.'}</p>
              <div className="rewind-tag-bars">
                {rewind.tags.slice(0, 5).map((tag, index) => (
                  <div key={tag.name}>
                    <span>{tag.name}</span><span>{formatHours(tag.hours)}</span>
                    <i style={{ width: `${Math.max(8, (tag.hours / Math.max(rewind.tags[0]?.hours || 1, 1)) * 100)}%`, background: REWIND_COLORS[index % REWIND_COLORS.length] }} />
                  </div>
                ))}
              </div>
            </article>
            <article className="rewind-panel rewind-persona-panel">
              <div className="rewind-persona-orbit"><Zap /><i /><i /><i /></div>
              <p className="rewind-kicker">Your player type</p>
              <h2>{rewind.persona}</h2>
              <p>{rewind.personaCopy}</p>
            </article>
          </section>

          <section className="rewind-section">
            <div className="rewind-section-heading"><div><span>02</span><h2>The rhythm of your year</h2></div><p>Finishes with a month in their completion date.</p></div>
            <div className="rewind-chart-grid">
              <article className="rewind-panel rewind-chart-card">
                <h3>Credits rolled by month</h3>
                <ResponsiveContainer width="100%" height={250} minWidth={0}>
                  <BarChart data={rewind.monthlyCompletions}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" vertical={false} />
                    <XAxis dataKey="month" stroke="#94a3b8" tickLine={false} axisLine={false} />
                    <YAxis allowDecimals={false} stroke="#94a3b8" tickLine={false} axisLine={false} />
                    <RechartsTooltip cursor={{ fill: 'rgba(255,255,255,.04)' }} contentStyle={{ background: '#17132b', border: '1px solid rgba(255,255,255,.12)', borderRadius: 10 }} />
                    <Bar dataKey="games" fill="#8b5cf6" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </article>
              <article className="rewind-panel rewind-chart-card">
                <h3>Your year by status</h3>
                <ResponsiveContainer width="100%" height={250} minWidth={0}>
                  <PieChart>
                    <Pie data={rewind.statusData} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={4}>
                      {rewind.statusData.map((entry, index) => <Cell key={entry.name} fill={REWIND_COLORS[index % REWIND_COLORS.length]} />)}
                    </Pie>
                    <RechartsTooltip contentStyle={{ background: '#17132b', border: '1px solid rgba(255,255,255,.12)', borderRadius: 10 }} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="rewind-legend">{rewind.statusData.map((entry, index) => <span key={entry.name}><i style={{ background: REWIND_COLORS[index % REWIND_COLORS.length] }} />{entry.name} · {entry.value}</span>)}</div>
              </article>
            </div>
          </section>

          <section className="rewind-awards">
            <div className="rewind-section-heading"><div><span>03</span><h2>Your cabinet of curiosities</h2></div><p>Small stories hiding inside the numbers.</p></div>
            <div className="rewind-award-grid">
              <article><Flame /><strong>{rewind.marathons}</strong><h3>Marathon games</h3><p>Games with 50+ recorded hours</p></article>
              <article><Zap /><strong>{rewind.quickWins}</strong><h3>Quick wins</h3><p>Finished in under 12 hours</p></article>
              <article><Medal /><strong>{rewind.perfectScores}</strong><h3>Perfect 10s</h3><p>Your highest honors</p></article>
              <article><Gem /><strong>{rewind.deepCuts}</strong><h3>Deep cuts</h3><p>Games over a decade old</p></article>
              <article><Layers3 /><strong>{rewind.tags.length}</strong><h3>Tags explored</h3><p>The variety in your year</p></article>
              <article><Target /><strong>{formatHours(rewind.averageGameLength)}</strong><h3>Average journey</h3><p>Recorded hours per game</p></article>
            </div>
          </section>

          {(rewind.datedCompletions.length > 0 || rewind.oldestRelease) && (
            <section className="rewind-timeline-panel">
              <div><Award /><span>First finish</span><strong>{rewind.datedCompletions[0]?.name || '—'}</strong><small>{rewind.datedCompletions[0]?.completion_date || 'No exact date'}</small></div>
              <div><Sparkles /><span>Final finish</span><strong>{rewind.datedCompletions.at(-1)?.name || '—'}</strong><small>{rewind.datedCompletions.at(-1)?.completion_date || 'No exact date'}</small></div>
              <div><CalendarDays /><span>Release range</span><strong>{rewind.oldestRelease || '—'} — {rewind.newestRelease || '—'}</strong><small>The eras you visited</small></div>
            </section>
          )}

          <section className="rewind-section rewind-library-section">
            <div className="rewind-section-heading"><div><span>04</span><h2>Every game in your rewind</h2></div><p>{rewind.playedGames.length} memories, collected in one place.</p></div>
            <div className="rewind-library-grid">
              {[...rewind.playedGames].sort((a, b) => (b.playtime_hours || 0) - (a.playtime_hours || 0)).map(game => (
                <article key={game.id}>
                  <GameCover game={game} />
                  <h3>{game.name}</h3>
                  <p>{game.playtime_hours ? formatHours(game.playtime_hours) : game.status || 'Tracked'}{game.mark ? ` · ${game.mark}/10` : ''}</p>
                </article>
              ))}
            </div>
          </section>

          <footer className="rewind-footer">
            <Sparkles />
            <h2>That was your {selectedYear}.</h2>
            <p>Playtime shown is cumulative recorded playtime for games included in the rewind.</p>
            <button onClick={onClose}><ArrowLeft size={18} /> Back to analytics</button>
          </footer>
        </main>
      )}
    </div>
  );
}
