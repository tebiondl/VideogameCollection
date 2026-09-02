import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowLeft, CalendarDays, CheckCircle2, CircleDollarSign, Crown, Dices,
  Gamepad2, Layers3, Loader2, Medal, PackageOpen, PieChart as PieChartIcon,
  ShoppingBag, Sparkles, Star, Tag, Target, Trophy, UserRound, UsersRound,
} from 'lucide-react';
import {
  Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer,
  Tooltip as RechartsTooltip, XAxis, YAxis,
} from 'recharts';
import { fetchWithAuth } from '../lib/api';
import './BoardgameAnalyticsDashboard.css';

type MatchMode = 'cooperative' | 'competitive' | 'solo';

interface Boardgame {
  id: number;
  name: string;
  image_url: string | null;
  mark: number | null;
  tags: string | null;
  library_section: 'wishlist' | 'owned' | 'external';
  price: number | null;
  expansions: string | null;
  is_expansion: boolean;
}

interface BoardgameMatch {
  id: number;
  boardgame_id: number;
  game_name: string;
  game_image_url: string | null;
  game_tags: string | null;
  played_with: string | null;
  players: { id: number; name: string }[];
  mode: MatchMode;
  result: 'victory' | 'defeat' | 'winner' | 'incomplete' | null;
  winner_name: string | null;
  played_date: string | null;
}

function matchPlayerNames(match: BoardgameMatch): string[] {
  return match.players?.length ? match.players.map(player => player.name) : parseList(match.played_with);
}

const MODE_COLORS: Record<MatchMode, string> = {
  competitive: '#fb7185',
  cooperative: '#38bdf8',
  solo: '#a78bfa',
};
const CHART_COLORS = ['#f59e0b', '#38bdf8', '#a78bfa', '#fb7185', '#34d399'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map(item => typeof item === 'string' ? item : item?.name).filter(Boolean);
    }
  } catch {
    // Older values may be comma-separated.
  }
  return value.split(',').map(item => item.trim()).filter(Boolean);
}

function normalizedName(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
}

function validDate(value: string | null | undefined): Date | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function modeLabel(mode: MatchMode): string {
  return mode === 'cooperative' ? 'Co-op' : mode.charAt(0).toUpperCase() + mode.slice(1);
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : pluralForm}`;
}

function GameImage({ name, image }: { name: string; image: string | null }) {
  return image
    ? <img src={image} alt={`${name} cover`} />
    : <span className="bga-cover-fallback"><Dices size={22} /></span>;
}

export function BoardgameAnalyticsDashboard() {
  const [games, setGames] = useState<Boardgame[]>([]);
  const [matches, setMatches] = useState<BoardgameMatch[]>([]);
  const [selectedYear, setSelectedYear] = useState<'all' | number>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    const loadAnalytics = async () => {
      setIsLoading(true);
      setLoadError('');
      try {
        const [gamesResponse, matchesResponse] = await Promise.all([
          fetchWithAuth('/boardgames/'),
          fetchWithAuth('/boardgames/matches'),
        ]);
        if (!gamesResponse.ok || !matchesResponse.ok) throw new Error('Analytics data could not be loaded.');
        const [gameData, matchData] = await Promise.all([gamesResponse.json(), matchesResponse.json()]);
        setGames(gameData);
        setMatches(matchData);
      } catch (error) {
        console.error(error);
        setLoadError('We could not load your tabletop statistics. Please try again.');
      } finally {
        setIsLoading(false);
      }
    };
    loadAnalytics();
  }, []);

  const years = useMemo(() => {
    const values = new Set<number>();
    matches.forEach(match => {
      const date = validDate(match.played_date);
      if (date) values.add(date.getFullYear());
    });
    return [...values].sort((a, b) => b - a);
  }, [matches]);

  const stats = useMemo(() => {
    const gamesById = new Map(games.map(game => [game.id, game]));
    const periodMatches = selectedYear === 'all'
      ? matches
      : matches.filter(match => validDate(match.played_date)?.getFullYear() === selectedYear);
    const datedMatches = periodMatches.filter(match => validDate(match.played_date));
    const unknownDates = periodMatches.length - datedMatches.length;

    const gameCounts = new Map<number, { id: number; game: Boardgame | null; name: string; image: string | null; plays: number; lastPlayed: string | null }>();
    const playerCounts = new Map<string, { name: string; plays: number; wins: number }>();
    const winnerCounts = new Map<string, { name: string; wins: number }>();
    const tagCounts = new Map<string, { name: string; plays: number; games: Set<number> }>();
    const modeCounts: Record<MatchMode, number> = { competitive: 0, cooperative: 0, solo: 0 };
    const dayCounts = DAYS.map(day => ({ day, plays: 0 }));
    const dateCounts = new Map<string, number>();

    periodMatches.forEach(match => {
      const game = gamesById.get(match.boardgame_id) || null;
      const currentGame = gameCounts.get(match.boardgame_id) || {
        id: match.boardgame_id,
        game,
        name: match.game_name,
        image: match.game_image_url,
        plays: 0,
        lastPlayed: null,
      };
      currentGame.plays += 1;
      if (match.played_date && (!currentGame.lastPlayed || match.played_date > currentGame.lastPlayed)) {
        currentGame.lastPlayed = match.played_date;
      }
      gameCounts.set(match.boardgame_id, currentGame);

      if (match.mode in modeCounts) modeCounts[match.mode] += 1;
      matchPlayerNames(match).forEach(player => {
        const key = normalizedName(player);
        const entry = playerCounts.get(key) || { name: player, plays: 0, wins: 0 };
        entry.plays += 1;
        playerCounts.set(key, entry);
      });
      if (match.mode === 'competitive' && match.winner_name) {
        const winnerKey = normalizedName(match.winner_name);
        const winner = winnerCounts.get(winnerKey) || { name: match.winner_name, wins: 0 };
        winner.wins += 1;
        winnerCounts.set(winnerKey, winner);
        const player = playerCounts.get(winnerKey);
        if (player) player.wins += 1;
      }
      parseList(match.game_tags ?? game?.tags).forEach(tag => {
        const key = normalizedName(tag);
        const entry = tagCounts.get(key) || { name: tag, plays: 0, games: new Set<number>() };
        entry.plays += 1;
        entry.games.add(match.boardgame_id);
        tagCounts.set(key, entry);
      });

      const date = validDate(match.played_date);
      if (date && match.played_date) {
        dayCounts[date.getDay()].plays += 1;
        dateCounts.set(match.played_date, (dateCounts.get(match.played_date) || 0) + 1);
      }
    });

    const rankedGames = [...gameCounts.values()].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
    const rankedPlayers = [...playerCounts.values()].sort((a, b) => b.plays - a.plays || a.name.localeCompare(b.name));
    const rankedWinners = [...winnerCounts.values()].sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
    const rankedTags = [...tagCounts.values()]
      .map(tag => ({ ...tag, games: tag.games.size }))
      .sort((a, b) => b.plays - a.plays || b.games - a.games || a.name.localeCompare(b.name));
    const modeData = (Object.keys(modeCounts) as MatchMode[])
      .map(mode => ({ name: modeLabel(mode), value: modeCounts[mode], color: MODE_COLORS[mode] }))
      .filter(entry => entry.value > 0);

    let activityData: { label: string; plays: number }[];
    if (selectedYear === 'all') {
      const yearCounts = new Map<number, number>();
      datedMatches.forEach(match => {
        const year = validDate(match.played_date)?.getFullYear();
        if (year) yearCounts.set(year, (yearCounts.get(year) || 0) + 1);
      });
      activityData = [...yearCounts].sort(([a], [b]) => a - b).map(([year, plays]) => ({ label: String(year), plays }));
    } else {
      activityData = MONTHS.map(label => ({ label, plays: 0 }));
      datedMatches.forEach(match => {
        const date = validDate(match.played_date);
        if (date) activityData[date.getMonth()].plays += 1;
      });
    }

    const cooperativeSolo = periodMatches.filter(match => match.mode !== 'competitive' && (match.result === 'victory' || match.result === 'defeat'));
    const victories = cooperativeSolo.filter(match => match.result === 'victory').length;
    const defeats = cooperativeSolo.filter(match => match.result === 'defeat').length;
    const successRate = cooperativeSolo.length ? Math.round((victories / cooperativeSolo.length) * 100) : null;
    const playedGameIds = new Set(periodMatches.map(match => match.boardgame_id));
    const ownedBaseGames = games.filter(game => game.library_section === 'owned' && !game.is_expansion);
    const ownedPlayed = ownedBaseGames.filter(game => playedGameIds.has(game.id)).length;
    const shelfCoverage = ownedBaseGames.length ? Math.round((ownedPlayed / ownedBaseGames.length) * 100) : 0;
    const attachedExpansions = ownedBaseGames.reduce((sum, game) => sum + parseList(game.expansions).length, 0);
    const standaloneOwnedExpansions = games.filter(game => game.library_section === 'owned' && game.is_expansion).length;
    const wishlist = games.filter(game => game.library_section === 'wishlist');
    const wishlistValue = wishlist.reduce((sum, game) => sum + Math.max(0, Number(game.price) || 0), 0);
    const ratedOwned = ownedBaseGames.filter(game => typeof game.mark === 'number' && game.mark > 0);
    const averageRating = ratedOwned.length ? ratedOwned.reduce((sum, game) => sum + (game.mark || 0), 0) / ratedOwned.length : null;
    const topRated = [...ratedOwned].sort((a, b) => (b.mark || 0) - (a.mark || 0) || a.name.localeCompare(b.name)).slice(0, 5);
    const peakDate = [...dateCounts].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0] || null;
    const busiestDay = [...dayCounts].sort((a, b) => b.plays - a.plays)[0];

    return {
      periodMatches, datedMatches, unknownDates, rankedGames, rankedPlayers, rankedWinners,
      rankedTags, modeData, activityData, dayCounts, victories, defeats, successRate,
      ownedBaseGames, ownedPlayed, shelfCoverage, attachedExpansions, standaloneOwnedExpansions,
      wishlist, wishlistValue, averageRating, topRated, peakDate, busiestDay,
    };
  }, [games, matches, selectedYear]);

  const periodLabel = selectedYear === 'all' ? 'all time' : String(selectedYear);
  const topGame = stats.rankedGames[0];
  const topPlayer = stats.rankedPlayers[0];
  const topMode = stats.modeData[0] ? [...stats.modeData].sort((a, b) => b.value - a.value)[0] : null;
  const topTag = stats.rankedTags[0];
  const maxGamePlays = Math.max(stats.rankedGames[0]?.plays || 0, 1);
  const maxPlayerPlays = Math.max(stats.rankedPlayers[0]?.plays || 0, 1);
  const maxTagPlays = Math.max(stats.rankedTags[0]?.plays || 0, 1);

  return (
    <div className="bga-page">
      <div className="bga-glow bga-glow-one" />
      <div className="bga-glow bga-glow-two" />
      <main className="bga-shell">
        <nav className="bga-nav">
          <Link to="/dashboard/boardgames" className="btn btn-secondary"><ArrowLeft size={18} /> Board Game Vault</Link>
          <label className="bga-year-picker">
            <CalendarDays size={17} /><span>Period</span>
            <select value={selectedYear} onChange={event => setSelectedYear(event.target.value === 'all' ? 'all' : Number(event.target.value))}>
              <option value="all">All time</option>
              {years.map(year => <option key={year} value={year}>{year}</option>)}
            </select>
          </label>
        </nav>

        <header className="bga-hero">
          <div>
            <p className="bga-kicker"><Sparkles size={16} /> Table intelligence</p>
            <h1>Your board game story,<br /><span>told by the table.</span></h1>
            <p>Real play history, collection reach, favorite opponents and the games that keep coming back.</p>
          </div>
          <div className="bga-hero-dice" aria-hidden="true"><Dices /><span>{stats.periodMatches.length}</span><small>plays · {periodLabel}</small></div>
        </header>

        {isLoading ? (
          <div className="bga-loading"><Loader2 className="spinner" size={34} /> Reading your score sheets…</div>
        ) : loadError ? (
          <div className="bga-empty"><Dices size={36} /><h2>Analytics unavailable</h2><p>{loadError}</p></div>
        ) : (
          <>
            <section className="bga-stat-grid">
              <article><span className="amber"><Gamepad2 /></span><div><small>Recorded plays</small><strong>{stats.periodMatches.length}</strong><p>{stats.datedMatches.length} with an exact date</p></div></article>
              <article><span className="blue"><Layers3 /></span><div><small>Games reached</small><strong>{stats.rankedGames.length}</strong><p>{stats.shelfCoverage}% of your owned shelf</p></div></article>
              <article><span className="violet"><UsersRound /></span><div><small>Table companions</small><strong>{stats.rankedPlayers.length}</strong><p>{topPlayer ? `${topPlayer.name} joined ${topPlayer.plays} times` : 'No players recorded yet'}</p></div></article>
              <article><span className="green"><Trophy /></span><div><small>Co-op & solo success</small><strong>{stats.successRate === null ? '—' : `${stats.successRate}%`}</strong><p>{stats.victories} wins · {stats.defeats} losses</p></div></article>
            </section>

            {stats.periodMatches.length === 0 ? (
              <section className="bga-empty"><Dices size={42} /><h2>No matches recorded for {periodLabel}</h2><p>Log a match in the Board Game Vault and it will appear here automatically.</p><Link to="/dashboard/boardgames" className="btn btn-primary">Record a match</Link></section>
            ) : (
              <>
                <section className="bga-feature-grid">
                  <article className="bga-feature-game">
                    <div className="bga-feature-art"><GameImage name={topGame.name} image={topGame.image} /><div className="bga-feature-overlay" /></div>
                    <div className="bga-feature-copy"><p className="bga-kicker"><Crown size={15} /> Most played</p><h2>{topGame.name}</h2><strong>{plural(topGame.plays, 'play')}</strong><p>{Math.round((topGame.plays / stats.periodMatches.length) * 100)}% of every match you logged{topGame.lastPlayed ? ` · last played ${topGame.lastPlayed}` : ''}</p></div>
                  </article>
                  <article className="bga-quick-insights">
                    <div><span><PieChartIcon /></span><small>Favorite format</small><strong>{topMode?.name || '—'}</strong><p>{topMode ? plural(topMode.value, 'play') : 'No mode data'}</p></div>
                    <div><span><Tag /></span><small>Most-played tag</small><strong>{topTag?.name || '—'}</strong><p>{topTag ? `${topTag.plays} plays across ${plural(topTag.games, 'game')}` : 'Add tags to games'}</p></div>
                    <div><span><CalendarDays /></span><small>Peak game day</small><strong>{stats.peakDate?.[0] || '—'}</strong><p>{stats.peakDate ? plural(stats.peakDate[1], 'match', 'matches') : 'No exact dates'}</p></div>
                    <div><span><UserRound /></span><small>Table regular</small><strong>{topPlayer?.name || '—'}</strong><p>{topPlayer ? plural(topPlayer.plays, 'shared match', 'shared matches') : 'No companions recorded'}</p></div>
                  </article>
                </section>

                <section className="bga-chart-grid">
                  <article className="bga-panel bga-activity-panel">
                    <div className="bga-panel-heading"><div><p className="bga-kicker">Play rhythm</p><h2>{selectedYear === 'all' ? 'Matches by year' : `The months of ${selectedYear}`}</h2></div><span>{stats.unknownDates ? `${stats.unknownDates} without date` : 'All dated'}</span></div>
                    <ResponsiveContainer width="100%" height={280} minWidth={0}>
                      <BarChart data={stats.activityData} margin={{ top: 10, right: 8, left: -22, bottom: 0 }}>
                        <defs><linearGradient id="bgaActivity" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#fbbf24" /><stop offset="100%" stopColor="#f97316" /></linearGradient></defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" vertical={false} /><XAxis dataKey="label" tickLine={false} axisLine={false} stroke="#94a3b8" /><YAxis allowDecimals={false} tickLine={false} axisLine={false} stroke="#94a3b8" />
                        <RechartsTooltip cursor={{ fill: 'rgba(255,255,255,.04)' }} contentStyle={{ background: '#171923', border: '1px solid rgba(255,255,255,.12)', borderRadius: 12 }} /><Bar dataKey="plays" fill="url(#bgaActivity)" radius={[6, 6, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </article>
                  <article className="bga-panel bga-mode-panel">
                    <div className="bga-panel-heading"><div><p className="bga-kicker">How you play</p><h2>Match modes</h2></div></div>
                    <div className="bga-mode-content">
                      <ResponsiveContainer width="58%" height={245} minWidth={0}><PieChart><Pie data={stats.modeData} dataKey="value" nameKey="name" innerRadius={64} outerRadius={94} paddingAngle={4}>{stats.modeData.map(entry => <Cell key={entry.name} fill={entry.color} />)}</Pie><RechartsTooltip contentStyle={{ background: '#171923', border: '1px solid rgba(255,255,255,.12)', borderRadius: 12 }} /></PieChart></ResponsiveContainer>
                      <div className="bga-mode-legend">{stats.modeData.map(entry => <div key={entry.name}><i style={{ background: entry.color }} /><span>{entry.name}</span><strong>{entry.value}</strong></div>)}</div>
                    </div>
                  </article>
                </section>

                <section className="bga-data-grid">
                  <article className="bga-panel">
                    <div className="bga-panel-heading"><div><p className="bga-kicker">The rotation</p><h2>Most played games</h2></div><span>{stats.rankedGames.length} unique</span></div>
                    <div className="bga-ranked-list">{stats.rankedGames.slice(0, 8).map((entry, index) => <div key={entry.id} className="bga-ranked-row"><b>{index + 1}</b><GameImage name={entry.name} image={entry.image} /><div><strong>{entry.name}</strong><i><em style={{ width: `${Math.max(5, (entry.plays / maxGamePlays) * 100)}%` }} /></i></div><span>{entry.plays}</span></div>)}</div>
                  </article>
                  <article className="bga-panel">
                    <div className="bga-panel-heading"><div><p className="bga-kicker">Around your table</p><h2>Frequent companions</h2></div><span>{stats.rankedPlayers.length} players</span></div>
                    <div className="bga-player-list">{stats.rankedPlayers.slice(0, 8).map((player, index) => <div key={normalizedName(player.name)}><span className="bga-player-avatar">{player.name.charAt(0).toUpperCase()}</span><div><strong>{player.name}</strong><i><em style={{ width: `${Math.max(5, (player.plays / maxPlayerPlays) * 100)}%` }} /></i></div><p><strong>{player.plays}</strong><small>games</small></p>{index === 0 && <Medal className="bga-player-medal" size={18} />}</div>)}{stats.rankedPlayers.length === 0 && <p className="bga-muted">Add who you played with to reveal your regular table.</p>}</div>
                  </article>
                </section>

                <section className="bga-data-grid">
                  <article className="bga-panel">
                    <div className="bga-panel-heading"><div><p className="bga-kicker">What reaches the table</p><h2>Tags by actual plays</h2></div></div>
                    <div className="bga-tag-list">{stats.rankedTags.slice(0, 7).map((tag, index) => <div key={normalizedName(tag.name)}><span>{tag.name}</span><strong>{tag.plays} plays</strong><i><em style={{ width: `${Math.max(5, (tag.plays / maxTagPlays) * 100)}%`, background: CHART_COLORS[index % CHART_COLORS.length] }} /></i><small>{plural(tag.games, 'game')}</small></div>)}{stats.rankedTags.length === 0 && <p className="bga-muted">Tag your played games to see which styles dominate your table.</p>}</div>
                  </article>
                  <article className="bga-panel">
                    <div className="bga-panel-heading"><div><p className="bga-kicker">Weekly ritual</p><h2>Favorite play days</h2></div><span>{stats.busiestDay.plays ? `${stats.busiestDay.day} leads` : 'No dated matches'}</span></div>
                    <ResponsiveContainer width="100%" height={255} minWidth={0}><BarChart data={stats.dayCounts} margin={{ top: 10, right: 0, left: -26, bottom: 0 }}><CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,.08)" vertical={false} /><XAxis dataKey="day" tickLine={false} axisLine={false} stroke="#94a3b8" /><YAxis allowDecimals={false} tickLine={false} axisLine={false} stroke="#94a3b8" /><RechartsTooltip cursor={{ fill: 'rgba(255,255,255,.04)' }} contentStyle={{ background: '#171923', border: '1px solid rgba(255,255,255,.12)', borderRadius: 12 }} /><Bar dataKey="plays" fill="#38bdf8" radius={[6, 6, 0, 0]} /></BarChart></ResponsiveContainer>
                  </article>
                </section>
              </>
            )}

            <section className="bga-collection-section">
              <div className="bga-section-heading"><div><p className="bga-kicker">Beyond the score sheet</p><h2>Your collection at a glance</h2></div><p>Collection totals are current; shelf reach shows how much you played during the selected period.</p></div>
              <div className="bga-collection-grid">
                <article><span><PackageOpen /></span><strong>{stats.ownedBaseGames.length}</strong><h3>Base games owned</h3><p>{stats.ownedBaseGames.length - stats.ownedPlayed} have not reached the table in this period</p></article>
                <article><span><Layers3 /></span><strong>{stats.attachedExpansions + stats.standaloneOwnedExpansions}</strong><h3>Expansions owned</h3><p>{stats.attachedExpansions} attached to their base games</p></article>
                <article><span><ShoppingBag /></span><strong>{stats.wishlist.length}</strong><h3>Wishlist candidates</h3><p>{stats.wishlist.filter(game => game.is_expansion).length} are expansions</p></article>
                <article><span><CircleDollarSign /></span><strong>{new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(stats.wishlistValue)}</strong><h3>Known wishlist value</h3><p>{stats.wishlist.filter(game => Number(game.price) > 0).length} entries have a recorded price</p></article>
                <article><span><Star /></span><strong>{stats.averageRating?.toFixed(1) || '—'}</strong><h3>Average shelf rating</h3><p>Across {stats.topRated.length ? plural(stats.ownedBaseGames.filter(game => typeof game.mark === 'number' && game.mark > 0).length, 'rated game') : 'no rated games'}</p></article>
                <article><span><Target /></span><strong>{stats.shelfCoverage}%</strong><h3>Period shelf reach</h3><p>{stats.ownedPlayed} of {stats.ownedBaseGames.length} owned games played</p></article>
              </div>
            </section>

            {(stats.topRated.length > 0 || stats.rankedWinners.length > 0) && <section className="bga-honours-grid">
              {stats.topRated.length > 0 && <article className="bga-panel"><div className="bga-panel-heading"><div><p className="bga-kicker">Your verdict</p><h2>Highest-rated shelf games</h2></div></div><div className="bga-honour-list">{stats.topRated.map((game, index) => <div key={game.id}><b>{index + 1}</b><GameImage name={game.name} image={game.image_url} /><span><strong>{game.name}</strong><small>Your collection rating</small></span><em>{game.mark}/10</em></div>)}</div></article>}
              {stats.rankedWinners.length > 0 && <article className="bga-panel"><div className="bga-panel-heading"><div><p className="bga-kicker">Competitive hall of fame</p><h2>Names on the trophy</h2></div></div><div className="bga-honour-list">{stats.rankedWinners.slice(0, 5).map((winner, index) => <div key={normalizedName(winner.name)}><b>{index + 1}</b><span className="bga-trophy-mark"><Trophy size={18} /></span><span><strong>{winner.name}</strong><small>Recorded competitive winner</small></span><em>{plural(winner.wins, 'win')}</em></div>)}</div></article>}
            </section>}

            <footer className="bga-footnote"><CheckCircle2 size={17} /><p>Calculated from {games.length} tracked game records and {matches.length} logged matches. Friend-owned games affect play analytics, but never your collection totals.</p></footer>
          </>
        )}
      </main>
    </div>
  );
}
