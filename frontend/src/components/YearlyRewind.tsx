import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowLeft, Award, BadgeCheck, CalendarDays, CircleSlash, Clock3, Coins, Crown, Eye, Flame, Gamepad2,
  Gem, Hourglass, Layers3, Medal, MonitorPlay, Puzzle, Rocket, Sparkles, Star, Tags, Target, ThumbsDown,
  Timer, TrendingDown, TrendingUp, Trophy, Zap
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip as RechartsTooltip, XAxis, YAxis
} from 'recharts';
import { buildYearlyRewind, rewindYears, type RewindBreakdownRow, type RewindEntry, type RewindGame } from '../lib/yearlyRewind';
import { tagNames } from '../lib/videogameStats';
import './YearlyRewind.css';

interface YearlyRewindProps {
  games: RewindGame[];
  rankingIds?: number[];
  onClose: () => void;
}

const REWIND_COLORS = ['hsl(var(--accent-h) 90% 66%)', '#22d3ee', '#f97316', '#ec4899', '#84cc16', '#facc15'];
const TOOLTIP_STYLE = { background: 'hsl(225 9% 12.2%)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 10 };
const MONTH_NAMES: Record<string, string> = {
  Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April', May: 'May', Jun: 'June',
  Jul: 'July', Aug: 'August', Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December',
};

function formatHours(value: number): string {
  return value >= 1000
    ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value)}h`
    : `${value.toFixed(value >= 100 ? 0 : 1)}h`;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const formatMark = (mark?: number | null) => (mark == null ? '' : `${Number.isInteger(mark) ? mark : mark.toFixed(1)}/10`);

interface Moment { id: string; icon: ReactNode; label: string; entry: RewindEntry; detail: string }
interface Curiosity { id: string; icon: ReactNode; value: string | number; title: string; note: string }
interface TimelineItem { id: string; icon: ReactNode; label: string; value: string; note: string }

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

function RewindBars({ rows, byHours }: { rows: RewindBreakdownRow[]; byHours: boolean }) {
  const value = (row: RewindBreakdownRow) => (byHours ? row.hours : row.games);
  const top = Math.max(...rows.map(value), 1);
  return (
    <div className="rewind-tag-bars">
      {rows.map((row, index) => (
        <div key={row.name}>
          <span>{row.name}</span><span>{byHours ? formatHours(row.hours) : plural(row.games, 'game')}</span>
          <i style={{ width: `${Math.max(8, (value(row) / top) * 100)}%`, background: REWIND_COLORS[index % REWIND_COLORS.length] }} />
        </div>
      ))}
    </div>
  );
}

export function YearlyRewind({ games, rankingIds, onClose }: YearlyRewindProps) {
  const availableYears = useMemo(() => rewindYears(games), [games]);
  const [selectedYear, setSelectedYear] = useState(availableYears[0]);
  const rewind = useMemo(() => buildYearlyRewind(games, selectedYear, { rankingIds }), [games, selectedYear, rankingIds]);
  const money = (value: number) => new Intl.NumberFormat(undefined, {
    style: 'currency', currency: rewind.spending?.currency || 'EUR', maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);

  const goty = rewind.gameOfTheYear;
  const fan = (rewind.mostPlayed.length ? rewind.mostPlayed : rewind.topRated).slice(0, 5);
  const tagsByHours = (rewind.tags[0]?.hours || 0) > 0;
  const platformsByHours = (rewind.platforms[0]?.hours || 0) > 0;
  const showMonths = rewind.monthly.length > 0;
  const showStatuses = rewind.statuses.length > 1;
  const showPlatforms = rewind.platforms.length > 0;
  const showDecades = rewind.decades.length > 1;
  const hypeDetail = (entry: RewindEntry) => `Hype ${entry.game.hype} → rated ${formatMark(entry.game.mark)}`;

  // Every card below is built only when its data exists, so nothing is ever shown empty.
  const moments: Moment[] = [];
  if (rewind.biggestSurprise) moments.push({ id: 'surprise', icon: <TrendingUp size={15} />, label: 'Biggest surprise', entry: rewind.biggestSurprise, detail: hypeDetail(rewind.biggestSurprise) });
  if (rewind.biggestLetdown) moments.push({ id: 'letdown', icon: <TrendingDown size={15} />, label: 'Biggest letdown', entry: rewind.biggestLetdown, detail: hypeDetail(rewind.biggestLetdown) });
  if (rewind.lowestRated) moments.push({ id: 'lowest', icon: <ThumbsDown size={15} />, label: 'Lowest rated', entry: rewind.lowestRated, detail: `You gave it ${formatMark(rewind.lowestRated.game.mark)}` });
  if (rewind.longestFinish) moments.push({ id: 'longest', icon: <Hourglass size={15} />, label: 'Longest finish', entry: rewind.longestFinish, detail: `${formatHours(rewind.longestFinish.hours)} to the credits` });
  if (rewind.shortestFinish) moments.push({ id: 'shortest', icon: <Timer size={15} />, label: 'Shortest finish', entry: rewind.shortestFinish, detail: `Done in ${formatHours(rewind.shortestFinish.hours)}` });
  if (rewind.oldestGame && rewind.newestGame) {
    moments.push({ id: 'oldest', icon: <Gem size={15} />, label: 'Oldest game', entry: rewind.oldestGame, detail: `Released in ${rewind.oldestGame.game.publication_year}` });
    moments.push({ id: 'newest', icon: <Rocket size={15} />, label: 'Newest game', entry: rewind.newestGame, detail: `Released in ${rewind.newestGame.game.publication_year}` });
  }
  if (rewind.spending?.bestValue) moments.push({ id: 'value', icon: <Coins size={15} />, label: 'Best value', entry: rewind.spending.bestValue.entry, detail: `${money(rewind.spending.bestValue.perHour)} per hour` });

  const curiosities: Curiosity[] = [];
  if (rewind.marathons) curiosities.push({ id: 'marathons', icon: <Flame />, value: rewind.marathons, title: 'Marathon games', note: 'Games with 50+ recorded hours' });
  if (rewind.quickWins) curiosities.push({ id: 'quick', icon: <Zap />, value: rewind.quickWins, title: 'Quick wins', note: 'Finished in under 12 hours' });
  if (rewind.perfectScores) curiosities.push({ id: 'perfect', icon: <Medal />, value: rewind.perfectScores, title: 'Perfect 10s', note: 'Your highest honors' });
  if (rewind.completionists.length) curiosities.push({ id: 'complete', icon: <BadgeCheck />, value: rewind.completionists.length, title: '100% completed', note: 'Nothing left to find' });
  if (rewind.abandoned.length) curiosities.push({ id: 'abandoned', icon: <CircleSlash />, value: rewind.abandoned.length, title: 'Left unfinished', note: 'Games you stopped playing' });
  if (rewind.sameYearReleases) curiosities.push({ id: 'fresh', icon: <Rocket />, value: rewind.sameYearReleases, title: `${rewind.year} releases`, note: 'Played the year they came out' });
  if (rewind.deepCuts) curiosities.push({ id: 'deep', icon: <Gem />, value: rewind.deepCuts, title: 'Deep cuts', note: 'Ten or more years old when played' });
  if (rewind.averageAge != null) curiosities.push({ id: 'age', icon: <CalendarDays />, value: `${rewind.averageAge.toFixed(1)}y`, title: 'Average game age', note: 'Years between release and play' });
  if (rewind.averageHours != null) curiosities.push({ id: 'journey', icon: <Target />, value: formatHours(rewind.averageHours), title: 'Average journey', note: `Across ${plural(rewind.timedGames, 'game')} with recorded time` });
  if (rewind.tags.length) curiosities.push({ id: 'tags', icon: <Layers3 />, value: rewind.tags.length, title: 'Tags explored', note: 'The variety in your year' });
  if (rewind.dlcPlayed.length) curiosities.push({ id: 'dlc', icon: <Puzzle />, value: rewind.dlcPlayed.length, title: 'Expansions played', note: 'DLC tracked as its own entry' });
  if (rewind.watched.length) curiosities.push({ id: 'watched', icon: <Eye />, value: rewind.watched.length, title: 'Games watched', note: 'Viewed, not played, so not counted above' });

  const timeline: TimelineItem[] = [];
  if (rewind.firstFinish) timeline.push({ id: 'first', icon: <Award />, label: 'First finish', value: rewind.firstFinish.game.name, note: rewind.firstFinish.game.completion_date || '' });
  if (rewind.lastFinish) timeline.push({ id: 'last', icon: <Sparkles />, label: 'Final finish', value: rewind.lastFinish.game.name, note: rewind.lastFinish.game.completion_date || '' });
  if (rewind.busiestMonth) timeline.push({ id: 'month', icon: <Trophy />, label: 'Busiest month', value: MONTH_NAMES[rewind.busiestMonth.month], note: `${plural(rewind.busiestMonth.games, 'game')} finished` });
  if (rewind.oldestGame && rewind.newestGame) timeline.push({ id: 'range', icon: <CalendarDays />, label: 'Release range', value: `${rewind.oldestGame.game.publication_year} — ${rewind.newestGame.game.publication_year}`, note: 'The eras you visited' });
  if (rewind.formats.length) timeline.push({ id: 'format', icon: <MonitorPlay />, label: 'Format', value: rewind.formats.map(row => `${row.games} ${row.name.toLocaleLowerCase()}`).join(' · '), note: 'Games you own a copy of' });

  // Sections come and go with the data, so they are numbered in the order they end up on screen.
  const sectionIds = [
    rewind.mostPlayed.length > 0 && 'played',
    rewind.topRated.length > 1 && 'rated',
    moments.length > 0 && 'moments',
    (showMonths || showStatuses) && 'rhythm',
    (showPlatforms || showDecades) && 'where',
    curiosities.length > 0 && 'curiosities',
    !!rewind.spending && 'spending',
    'library',
  ].filter((id): id is string => !!id);
  const sectionNumber = (id: string) => String(sectionIds.indexOf(id) + 1).padStart(2, '0');
  const library = [...rewind.played].sort((a, b) => b.hours - a.hours || (b.game.mark || 0) - (a.game.mark || 0) || a.game.name.localeCompare(b.game.name));

  return (
    <div className="rewind-shell">
      <div className="rewind-aurora rewind-aurora-one" />
      <div className="rewind-aurora rewind-aurora-two" />
      <nav className="rewind-nav">
        <button className="rewind-back" onClick={onClose}><ArrowLeft size={18} /> Statistics</button>
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
        <p>{rewind.played.length
          ? `${plural(rewind.played.length, 'world')}, one unforgettable year.`
          : 'Your next great gaming year is waiting to be tracked.'}</p>
        <div className="rewind-cover-fan" aria-hidden="true">
          {fan.map(({ game }, index) => (
            <div key={game.id} style={{ '--cover-index': index + (5 - fan.length) / 2 } as React.CSSProperties}><GameCover game={game} /></div>
          ))}
        </div>
      </header>

      {rewind.played.length === 0 ? (
        <section className="rewind-empty">
          <Gamepad2 size={44} />
          <h2>No tracked activity for {selectedYear}</h2>
          <p>A game joins the rewind of the year in its completion date. Games you are playing that have no date yet appear in the current year. Not Started and Viewed games are never included.</p>
        </section>
      ) : (
        <main className="rewind-content">
          <section className="rewind-stat-strip">
            <div><Gamepad2 /><span>{rewind.played.length}</span><small>{rewind.played.length === 1 ? 'game' : 'games'} in your year</small></div>
            <div><Clock3 /><span>{rewind.timedGames ? formatHours(rewind.totalHours) : '—'}</span><small>recorded playtime</small></div>
            <div><Trophy /><span>{rewind.finished.length}</span><small>credits rolled</small></div>
            <div><Star /><span>{rewind.averageRating != null ? rewind.averageRating.toFixed(1) : '—'}</span><small>{rewind.ratedGames ? `average of ${plural(rewind.ratedGames, 'rating')}` : 'average rating'}</small></div>
          </section>

          {goty && (
            <section className="rewind-feature-card">
              <div className="rewind-feature-art">
                {goty.game.image_url ? <img src={goty.game.image_url} alt="" /> : <div className="rewind-cover-placeholder"><Crown size={54} /></div>}
                <div className="rewind-feature-shade" />
              </div>
              <div className="rewind-feature-copy">
                <div className="rewind-kicker"><Crown size={16} /> Game of the year</div>
                <h2>{goty.game.name}</h2>
                <p>{goty.game.mark ? `Your ${formatMark(goty.game.mark)} champion` : 'The title that defined your year'}{goty.hours ? ` · ${formatHours(goty.hours)} recorded` : ''}</p>
                <div className="rewind-feature-tags">{tagNames(goty.game.tags).slice(0, 4).map(tag => <span key={tag}>{tag}</span>)}</div>
              </div>
            </section>
          )}

          {rewind.mostPlayed.length > 0 && (
            <section className="rewind-section">
              <div className="rewind-section-heading"><div><span>{sectionNumber('played')}</span><h2>Your most played</h2></div><p>Lifetime playtime recorded for games in this rewind.</p></div>
              <div className="rewind-podium">
                {rewind.mostPlayed.slice(0, 5).map(({ game, hours }, index) => (
                  <article key={game.id} className={index === 0 ? 'rewind-top-game' : ''}>
                    <GameCover game={game} rank={index + 1} />
                    <div><h3>{game.name}</h3><p><Clock3 size={14} /> {formatHours(hours)}</p></div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {rewind.topRated.length > 1 && (
            <section className="rewind-section">
              <div className="rewind-section-heading"><div><span>{sectionNumber('rated')}</span><h2>Your highest rated</h2></div><p>Ties follow the order of your personal ranking.</p></div>
              <div className="rewind-podium">
                {rewind.topRated.slice(0, 5).map(({ game }, index) => (
                  <article key={game.id} className={index === 0 ? 'rewind-top-game' : ''}>
                    <GameCover game={game} rank={index + 1} />
                    <div><h3>{game.name}</h3><p><Star size={14} /> {formatMark(game.mark)}</p></div>
                  </article>
                ))}
              </div>
            </section>
          )}

          <section className={`rewind-two-column${rewind.tags.length ? '' : ' rewind-single'}`}>
            {rewind.tags.length > 0 && (
              <article className="rewind-panel rewind-tag-panel">
                <div className="rewind-panel-icon"><Tags /></div>
                <p className="rewind-kicker">Your favorite lane</p>
                <h2>{rewind.tags[0].name}</h2>
                <p>{tagsByHours ? `${formatHours(rewind.tags[0].hours)} recorded across ${plural(rewind.tags[0].games, 'game')}` : `${plural(rewind.tags[0].games, 'game')} this year`}</p>
                <RewindBars rows={rewind.tags.slice(0, 5)} byHours={tagsByHours} />
              </article>
            )}
            <article className="rewind-panel rewind-persona-panel">
              <div className="rewind-persona-orbit"><Zap /><i /><i /><i /></div>
              <p className="rewind-kicker">Your player type</p>
              <h2>{rewind.persona}</h2>
              <p>{rewind.personaCopy}</p>
            </article>
          </section>

          {moments.length > 0 && (
            <section className="rewind-section">
              <div className="rewind-section-heading"><div><span>{sectionNumber('moments')}</span><h2>Standout moments</h2></div><p>The extremes of your year, one game each.</p></div>
              <div className="rewind-moment-grid">
                {moments.map(moment => (
                  <article key={moment.id}>
                    <GameCover game={moment.entry.game} />
                    <div>
                      <p className="rewind-moment-label">{moment.icon}{moment.label}</p>
                      <h3>{moment.entry.game.name}</h3>
                      <p>{moment.detail}</p>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}

          {(showMonths || showStatuses) && (
            <section className="rewind-section">
              <div className="rewind-section-heading"><div><span>{sectionNumber('rhythm')}</span><h2>The rhythm of your year</h2></div><p>{showMonths ? 'Finishes with a month in their completion date.' : 'How the games of your year ended up.'}</p></div>
              <div className={`rewind-chart-grid${showMonths && showStatuses ? '' : ' rewind-single'}`}>
                {showMonths && (
                  <article className="rewind-panel rewind-chart-card">
                    <h3>Credits rolled by month</h3>
                    <ResponsiveContainer width="100%" height={250} minWidth={0}>
                      <BarChart data={rewind.monthly}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" vertical={false} />
                        <XAxis dataKey="month" stroke="#94a3b8" tickLine={false} axisLine={false} />
                        <YAxis allowDecimals={false} stroke="#94a3b8" tickLine={false} axisLine={false} />
                        <RechartsTooltip cursor={{ fill: 'rgba(255,255,255,.04)' }} contentStyle={TOOLTIP_STYLE} />
                        <Bar dataKey="games" fill="hsl(var(--accent-h) 90% 66%)" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </article>
                )}
                {showStatuses && (
                  <article className="rewind-panel rewind-chart-card">
                    <h3>Your year by status</h3>
                    <ResponsiveContainer width="100%" height={250} minWidth={0}>
                      <PieChart>
                        <Pie data={rewind.statuses} dataKey="value" nameKey="name" innerRadius={58} outerRadius={92} paddingAngle={4}>
                          {rewind.statuses.map((entry, index) => <Cell key={entry.name} fill={REWIND_COLORS[index % REWIND_COLORS.length]} />)}
                        </Pie>
                        <RechartsTooltip contentStyle={TOOLTIP_STYLE} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="rewind-legend">{rewind.statuses.map((entry, index) => <span key={entry.name}><i style={{ background: REWIND_COLORS[index % REWIND_COLORS.length] }} />{entry.name} · {entry.value}</span>)}</div>
                  </article>
                )}
              </div>
            </section>
          )}

          {(showPlatforms || showDecades) && (
            <section className="rewind-section">
              <div className="rewind-section-heading"><div><span>{sectionNumber('where')}</span><h2>Where and when</h2></div><p>The platforms you played on and the eras your games came from.</p></div>
              <div className={`rewind-chart-grid${showPlatforms && showDecades ? '' : ' rewind-single'}`}>
                {showPlatforms && (
                  <article className="rewind-panel">
                    <p className="rewind-kicker">Platform of the year</p>
                    <h3 className="rewind-panel-title">{rewind.platforms[0].name}</h3>
                    <RewindBars rows={rewind.platforms.slice(0, 5)} byHours={platformsByHours} />
                  </article>
                )}
                {showDecades && (
                  <article className="rewind-panel">
                    <p className="rewind-kicker">Favorite release decade</p>
                    <h3 className="rewind-panel-title">{[...rewind.decades].sort((a, b) => b.games - a.games)[0].name}</h3>
                    <RewindBars rows={rewind.decades.map(row => ({ ...row, hours: 0 }))} byHours={false} />
                  </article>
                )}
              </div>
            </section>
          )}

          {curiosities.length > 0 && (
            <section className="rewind-awards">
              <div className="rewind-section-heading"><div><span>{sectionNumber('curiosities')}</span><h2>Your cabinet of curiosities</h2></div><p>Small stories hiding inside the numbers.</p></div>
              <div className="rewind-award-grid">
                {curiosities.map(item => <article key={item.id}>{item.icon}<strong>{item.value}</strong><h3>{item.title}</h3><p>{item.note}</p></article>)}
              </div>
            </section>
          )}

          {rewind.spending && (
            <section className="rewind-section">
              <div className="rewind-section-heading"><div><span>{sectionNumber('spending')}</span><h2>What your year cost</h2></div><p>Prices of the copies you own of these games, whenever you bought them.</p></div>
              <div className="rewind-timeline-panel rewind-flush" style={{ gridTemplateColumns: `repeat(${rewind.spending.costPerHour != null ? 3 : 2}, 1fr)` }}>
                <div><Coins /><span>Spent on these games</span><strong>{money(rewind.spending.total)}</strong><small>{plural(rewind.spending.pricedGames, 'game')} with a price</small></div>
                {rewind.spending.costPerHour != null && <div><Clock3 /><span>Cost per hour</span><strong>{money(rewind.spending.costPerHour)}</strong><small>Priced games with recorded time</small></div>}
                <div><Crown /><span>Most expensive</span><strong>{rewind.spending.mostExpensive.entry.game.name}</strong><small>{money(rewind.spending.mostExpensive.cost)}</small></div>
              </div>
            </section>
          )}

          {timeline.length > 0 && (
            <section className="rewind-timeline-panel" style={{ gridTemplateColumns: `repeat(${Math.min(timeline.length, 3)}, 1fr)` }}>
              {timeline.map(item => <div key={item.id}>{item.icon}<span>{item.label}</span><strong>{item.value}</strong><small>{item.note}</small></div>)}
            </section>
          )}

          <section className="rewind-section rewind-library-section">
            <div className="rewind-section-heading"><div><span>{sectionNumber('library')}</span><h2>Every game in your rewind</h2></div><p>{rewind.played.length === 1 ? '1 memory' : `${rewind.played.length} memories`}, collected in one place.</p></div>
            <div className="rewind-library-grid">
              {library.map(({ game, hours }) => (
                <article key={game.id}>
                  <GameCover game={game} />
                  <h3>{game.name}</h3>
                  <p>{hours ? formatHours(hours) : game.status}{game.mark ? ` · ${formatMark(game.mark)}` : ''}</p>
                </article>
              ))}
            </div>
          </section>

          <footer className="rewind-footer">
            <Sparkles />
            <h2>That was your {selectedYear}.</h2>
            <p>Playtime is the lifetime total recorded for each game, not only the hours played in {selectedYear}.</p>
            <button onClick={onClose}><ArrowLeft size={18} /> Back to statistics</button>
          </footer>
        </main>
      )}
    </div>
  );
}
