import { useEffect, useState } from 'react';
import { ArrowUpRight, CalendarDays, ChevronLeft, ChevronRight, Compass, Gamepad2, LibraryBig, PackageCheck, Plus } from 'lucide-react';
import { PhysicalCatalog } from './PhysicalCatalog';
import { WantedGameEditor } from '../components/WantedGameEditor';
import { RELEASE_MONTH_RANGE, discoveryApi, emptyWanted, errorMessage, monthKey, monthLabel, timestamp } from '../lib/discovery';
import type { DiscoverySettings, Release, Timeline, WantedDraft, WantedGame } from '../lib/discovery';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import './Discovery.css';

const MONTH_OFFSETS = Array.from({ length: RELEASE_MONTH_RANGE * 2 + 1 }, (_, index) => index - RELEASE_MONTH_RANGE);

/** Releases grouped by date in day order; days without releases are left out. */
function releaseDays(releases: Release[]): Array<[string, Release[]]> {
  const byDay = new Map<string, Release[]>();
  releases.forEach(release => { byDay.set(release.release_date, [...(byDay.get(release.release_date) || []), release]); });
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b));
}

export function DiscoveryDashboard() {
  const [games, setGames] = useState<WantedGame[]>([]);
  const [timeline, setTimeline] = useState<Timeline | null>(null);
  const [region, setRegion] = useState('Europe');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [editing, setEditing] = useState<{ draft: WantedDraft } | null>(null);
  const [hideOwned, setHideOwned] = useState(true);
  const [reload, setReload] = useState(0);
  const [view, setView] = useState<'calendar' | 'catalog'>(() => { try { return localStorage.getItem('discovery-view') === 'catalog' ? 'catalog' : 'calendar'; } catch { return 'calendar'; } });
  const choose = (value: 'calendar' | 'catalog') => { setView(value); try { localStorage.setItem('discovery-view', value); } catch { /* private storage */ } };
  const today = new Date().toLocaleDateString('en-CA');
  const thisMonth = monthKey(0);
  const monthOptions = MONTH_OFFSETS.map(offset => monthKey(offset));
  const [month, setMonth] = useState(thisMonth);

  useEffect(() => {
    let cancelled = false;
    Promise.all([discoveryApi<WantedGame[]>('/games'), discoveryApi<DiscoverySettings>('/settings')]).then(([wanted, settings]) => {
      if (!cancelled) { setGames(wanted); setRegion(settings.region); }
    }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reload]);
  useEffect(() => {
    let cancelled = false;
    discoveryApi<Timeline>(`/timeline?region=${encodeURIComponent(region)}&month=${month}`).then(data => { if (!cancelled) { setTimeline(data); setError(''); } }).catch(reason => { if (!cancelled) setError(errorMessage(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [region, month, reload]);
  // The previous month stays on screen, dimmed, until the chosen one arrives.
  const monthBusy = !!timeline && (timeline.month ?? timeline.months[0]) !== month;
  const monthIndex = monthOptions.indexOf(month);
  const shownCount = timeline ? timeline.games.filter(game => !hideOwned || !game.owned).length : 0;

  function saveRelease(release: Release) {
    setEditing({ draft: { ...emptyWanted(), name: release.name, description: release.description || '', image_url: release.image_url,
      platform: release.platform || 'Nintendo Switch', format: 'Physical', release_date: release.release_date,
      publication_year: Number(release.release_date.slice(0, 4)), store_url: release.source_url } });
  }

  return <div className="container discovery discovery-only">
    <VideogamePageHeader eyebrow="Release radar" icon={<Compass />} title="Discovery" description="See what is new and what is arriving next. More discovery sources will join this calendar over time." />
    <div className="disc-subtabs" role="tablist" aria-label="Discovery views">
      <button role="tab" aria-selected={view === 'calendar'} onClick={() => choose('calendar')}><CalendarDays size={17} /> Release calendar</button>
      <button role="tab" aria-selected={view === 'catalog'} onClick={() => choose('catalog')}><LibraryBig size={17} /> Physical catalog</button>
    </div>
    {view === 'catalog' && <PhysicalCatalog />}
    {view === 'calendar' && <section className="disc-timeline-section">
      <div className="disc-section-heading"><div><p className="disc-eyebrow">ON THE HORIZON</p><h2><CalendarDays size={23} /> Switch physical release calendar</h2></div><div className="disc-inline"><label className="disc-check"><input type="checkbox" checked={hideOwned} onChange={event => setHideOwned(event.target.checked)} /> Hide owned</label><select aria-label="Release region" value={region} onChange={event => { setTimeline(null); setLoading(true); setRegion(event.target.value); }}>{['Europe', 'North America', 'Japan'].map(value => <option key={value}>{value}</option>)}</select></div></div>
      <p className="disc-muted">Nintendo Switch family · Retail physical editions</p>
      <nav className="disc-month-nav" aria-label="Choose a month">
        <button type="button" className="disc-month-step" disabled={monthIndex <= 0} onClick={() => setMonth(monthOptions[monthIndex - 1])} aria-label="Previous month"><ChevronLeft size={18} /></button>
        <select className="disc-month-select" value={month} onChange={event => setMonth(event.target.value)} aria-label="Month">
          {monthOptions.map(option => <option key={option} value={option}>{monthLabel(option)}{option === thisMonth ? ' · now' : ''}</option>)}
        </select>
        <button type="button" className="disc-month-step" disabled={monthIndex >= monthOptions.length - 1} onClick={() => setMonth(monthOptions[monthIndex + 1])} aria-label="Next month"><ChevronRight size={18} /></button>
        {month !== thisMonth && <button type="button" className="disc-text-button disc-month-today" onClick={() => setMonth(thisMonth)}>This month</button>}
        <span className="disc-month-count" aria-live="polite">{!timeline || monthBusy ? 'Loading…' : `${shownCount} ${shownCount === 1 ? 'release' : 'releases'}`}</span>
      </nav>
      {error && <div className="disc-alert error" role="alert">{error} <button className="disc-text-button" onClick={() => setReload(value => value + 1)}>Retry</button></div>}
      {message && <p className="disc-alert success" role="status">{message}</p>}
      {loading && !timeline && <p className="disc-empty">Loading the release calendar…</p>}
      {timeline && <>
        {timeline.warning && <p className="disc-alert" role="status">{timeline.warning}</p>}
        <div className={`disc-calendars ${monthBusy ? 'is-loading' : ''}`} aria-busy={monthBusy}>{timeline.months.map(shownMonth => {
          const releases = timeline.games.filter(game => game.release_date.startsWith(shownMonth) && (!hideOwned || !game.owned));
          return <section className="disc-calendar-month" key={shownMonth}>
            {releases.length === 0 ? <p className="disc-agenda-empty">No releases this month.</p> : <ol className="disc-agenda">{releaseDays(releases).map(([date, dayReleases]) => {
              const when = new Date(`${date}T12:00:00`);
              const state = date === today ? 'today' : date < today ? 'past' : '';
              return <li className={`disc-agenda-day ${state}`} key={date} aria-current={state === 'today' ? 'date' : undefined}>
                <time className="disc-agenda-date" dateTime={date}>
                  <span className="disc-agenda-weekday">{state === 'today' ? 'Today' : when.toLocaleDateString(undefined, { weekday: 'short' })}</span>
                  <strong>{when.getDate()}</strong>
                  <span className="disc-agenda-month">{when.toLocaleDateString(undefined, { month: 'short' })}</span>
                </time>
                <div className="disc-agenda-games">{dayReleases.map(release => {
                  const saved = release.saved || games.some(game => game.name.toLowerCase() === release.name.toLowerCase());
                  return <article className="disc-calendar-release" key={release.id} title={release.notes || release.name}>
                    <div className="disc-calendar-cover">{release.image_url ? <img src={release.image_url} alt="" loading="lazy" /> : <Gamepad2 size={18} />}</div>
                    <div className="disc-calendar-game"><strong>{release.name}</strong><div className="disc-badges"><span className="disc-badge physical">PHYSICAL</span>{release.platform && <span className="disc-badge">{release.platform === 'Nintendo Switch 2' ? 'SWITCH 2' : release.platform.includes('/') ? 'SWITCH 1 + 2' : 'SWITCH'}</span>}{release.notes?.includes('Game-Key Card') && <span className="disc-badge dlc">KEY CARD</span>}{release.owned && <span className="disc-badge">OWNED</span>}</div><a href={release.source_url} target="_blank" rel="noreferrer" aria-label={`Source for ${release.name}`}>{release.source} <ArrowUpRight size={11} /></a></div>
                    <button className="disc-icon-button" disabled={saved || release.owned} onClick={() => saveRelease(release)} title={release.owned ? 'Already in your collection' : saved ? 'Already in Games I want' : 'Save to Games I want'} aria-label={saved ? `${release.name} saved` : `Save ${release.name} to Games I want`}>{saved || release.owned ? <PackageCheck size={16} /> : <Plus size={16} />}</button>
                  </article>;
                })}</div>
              </li>;
            })}</ol>}
          </section>;
        })}</div>
        <p className="disc-source-note">{timeline.coverage} Refreshed: {timestamp(timeline.updated_at)}. Refreshes daily.</p>
      </>}
    </section>}
    {editing && <WantedGameEditor initial={editing.draft} title="Save to Games I want" onClose={() => setEditing(null)} onSave={async draft => { await discoveryApi('/games', { method: 'POST', body: JSON.stringify(draft) }); setMessage(`${draft.name} saved to Games I want.`); setReload(value => value + 1); }} />}
  </div>;
}
