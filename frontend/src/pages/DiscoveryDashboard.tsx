import { useEffect, useState } from 'react';
import { ArrowUpRight, CalendarDays, Compass, Gamepad2, PackageCheck, Plus } from 'lucide-react';
import { WantedGameEditor } from '../components/WantedGameEditor';
import { discoveryApi, emptyWanted, errorMessage, timestamp } from '../lib/discovery';
import type { DiscoverySettings, Release, Timeline, WantedDraft, WantedGame } from '../lib/discovery';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import './Discovery.css';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function monthCells(month: string) {
  const [year, monthNumber] = month.split('-').map(Number);
  const first = new Date(year, monthNumber - 1, 1);
  const days = new Date(year, monthNumber, 0).getDate();
  const leading = (first.getDay() + 6) % 7;
  return [...Array(leading).fill(null), ...Array.from({ length: days }, (_, index) => index + 1)];
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
  const today = new Date().toLocaleDateString('en-CA');

  useEffect(() => {
    let cancelled = false;
    Promise.all([discoveryApi<WantedGame[]>('/games'), discoveryApi<DiscoverySettings>('/settings')]).then(([wanted, settings]) => {
      if (!cancelled) { setGames(wanted); setRegion(settings.region); }
    }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reload]);
  useEffect(() => {
    let cancelled = false;
    discoveryApi<Timeline>(`/timeline?region=${encodeURIComponent(region)}`).then(data => { if (!cancelled) { setTimeline(data); setError(''); } }).catch(reason => { if (!cancelled) setError(errorMessage(reason)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [region, reload]);

  function saveRelease(release: Release) {
    setEditing({ draft: { ...emptyWanted(), name: release.name, description: release.description || '', image_url: release.image_url,
      platform: release.platform || 'Nintendo Switch', format: 'Physical', release_date: release.release_date,
      publication_year: Number(release.release_date.slice(0, 4)), store_url: release.source_url } });
  }

  return <div className="container discovery discovery-only">
    <VideogamePageHeader eyebrow="Release radar" icon={<Compass />} title="Discovery" description="See what is new and what is arriving next. More discovery sources will join this calendar over time." />
    <section className="disc-timeline-section">
      <div className="disc-section-heading"><div><p className="disc-eyebrow">ON THE HORIZON</p><h2><CalendarDays size={23} /> Switch physical release calendar</h2></div><div className="disc-inline"><label className="disc-check"><input type="checkbox" checked={hideOwned} onChange={event => setHideOwned(event.target.checked)} /> Hide owned</label><select aria-label="Release region" value={region} onChange={event => { setTimeline(null); setLoading(true); setRegion(event.target.value); }}>{['Europe', 'North America', 'Japan'].map(value => <option key={value}>{value}</option>)}</select></div></div>
      <p className="disc-muted">Last month and this month · Nintendo Switch family · Retail physical editions</p>
      {error && <div className="disc-alert error" role="alert">{error} <button className="disc-text-button" onClick={() => setReload(value => value + 1)}>Retry</button></div>}
      {message && <p className="disc-alert success" role="status">{message}</p>}
      {loading && !timeline && <p className="disc-empty">Loading the release calendar…</p>}
      {timeline && <>
        {timeline.warning && <p className="disc-alert" role="status">{timeline.warning}</p>}
        <div className="disc-calendars">{timeline.months.map(month => {
          const releases = timeline.games.filter(game => game.release_date.startsWith(month) && (!hideOwned || !game.owned));
          const byDay = new Map<number, Release[]>();
          releases.forEach(release => { const day = Number(release.release_date.slice(8)); byDay.set(day, [...(byDay.get(day) || []), release]); });
          return <section className="disc-calendar-month" key={month}>
            <div className="disc-month-heading"><h3>{new Date(`${month}-02T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h3><span>{releases.length} releases</span></div>
            <div className="disc-calendar-grid">{WEEKDAYS.map(day => <div className="disc-calendar-weekday" key={day}>{day}</div>)}{monthCells(month).map((day, index) => <div className={`disc-calendar-day ${day ? '' : 'empty'} ${day && `${month}-${String(day).padStart(2, '0')}` === today ? 'today' : ''}`} key={`${month}-${index}`}>
              {day && <span className="disc-day-number">{day}</span>}
              {day && byDay.get(day)?.map(release => {
                const saved = release.saved || games.some(game => game.name.toLowerCase() === release.name.toLowerCase());
                return <article className="disc-calendar-release" key={release.id} title={release.notes || release.name}>
                  <div className="disc-calendar-cover">{release.image_url ? <img src={release.image_url} alt="" loading="lazy" /> : <Gamepad2 size={16} />}</div>
                  <div className="disc-calendar-game"><strong>{release.name}</strong><div className="disc-badges"><span className="disc-badge physical">PHYSICAL</span>{release.platform && <span className="disc-badge">{release.platform === 'Nintendo Switch 2' ? 'SWITCH 2' : release.platform.includes('/') ? 'SWITCH 1 + 2' : 'SWITCH'}</span>}{release.notes?.includes('Game-Key Card') && <span className="disc-badge dlc">KEY CARD</span>}</div><a href={release.source_url} target="_blank" rel="noreferrer" aria-label={`Source for ${release.name}`}>{release.source} <ArrowUpRight size={11} /></a></div>
                  <button className="disc-icon-button" disabled={saved || release.owned} onClick={() => saveRelease(release)} aria-label={saved ? `${release.name} saved` : `Save ${release.name} to Games I want`}>{saved || release.owned ? <PackageCheck size={15} /> : <Plus size={15} />}</button>
                </article>;
              })}
            </div>)}</div>
          </section>;
        })}</div>
        <p className="disc-source-note">{timeline.coverage} Refreshed: {timestamp(timeline.updated_at)}. Refreshes daily.</p>
      </>}
    </section>
    {editing && <WantedGameEditor initial={editing.draft} title="Save to Games I want" onClose={() => setEditing(null)} onSave={async draft => { await discoveryApi('/games', { method: 'POST', body: JSON.stringify(draft) }); setMessage(`${draft.name} saved to Games I want.`); setReload(value => value + 1); }} />}
  </div>;
}
