import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Compass, Database, Download, EyeOff, LayoutList, Loader2, Palette, RefreshCw, Settings2, Shield, Workflow } from 'lucide-react';
import { DiscoveryAdmin } from './DiscoveryAdmin';
import { PaginationSettingsAdmin } from '../components/PaginationSettingsAdmin';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import { useAuth } from '../context/AuthContext';
import { ACCENTS, saveAccent, savedAccent } from '../lib/appearance';
import type { AccentId } from '../lib/appearance';
import { discoveryApi, errorMessage, payload, timestamp } from '../lib/discovery';
import type { DiscoverySettings, WantedGame } from '../lib/discovery';
import type { CatalogResponse } from '../lib/physicalCatalog';
import './DashboardPage.css';
import './AdminDashboard.css';
import './UserSettings.css';

const REGIONS = ['Europe', 'North America', 'Japan'];
const SETTINGS_CHANGED = 'discovery-settings-changed';

function Section({ id, eyebrow, title, description, children }: { id: string; eyebrow: string; title: string; description: string; children: ReactNode }) {
  return <section id={id} className="settings-section">
    <header><span>{eyebrow}</span><h2>{title}</h2><p>{description}</p></header>
    {children}
  </section>;
}

function Row({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return <div className="settings-row"><div><strong>{title}</strong>{hint && <p>{hint}</p>}</div><div className="settings-control">{children}</div></div>;
}

function AppearanceSettings() {
  const [accent, setAccent] = useState<AccentId>(savedAccent);
  return <div className="settings-card">
    <Row title="Accent colour" hint="Used for buttons, highlights and charts. Saved on this device.">
      <div className="settings-swatches" role="radiogroup" aria-label="Accent colour">
        {ACCENTS.map(option => <button type="button" key={option.id} role="radio" aria-checked={accent === option.id} title={option.label}
          style={{ background: option.color }} onClick={() => { setAccent(option.id); saveAccent(option.id); }}>
          {accent === option.id && <Check size={16} />}<span>{option.label}</span>
        </button>)}
      </div>
    </Row>
  </div>;
}

function DiscoverySettingsCard() {
  const [settings, setSettings] = useState<DiscoverySettings | null>(null);
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [view, setView] = useState(() => { try { return localStorage.getItem('discovery-view') === 'catalog' ? 'catalog' : 'calendar'; } catch { return 'calendar'; } });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    discoveryApi<DiscoverySettings>('/settings').then(setSettings).catch(reason => setError(errorMessage(reason)));
    discoveryApi<CatalogResponse>('/catalog').then(setCatalog).catch(() => {});
  }, []);
  const hidden = catalog?.games.filter(game => game.hidden).length ?? 0;
  const physical = catalog?.games.length ?? 0;

  async function saveRegion(region: string) {
    if (!settings) return;
    setBusy(true); setError(''); setMessage('');
    try {
      // The settings endpoint replaces the whole record, so resend the Steam fields unchanged.
      const current = await discoveryApi<DiscoverySettings>('/settings');
      const updated = await discoveryApi<DiscoverySettings>('/settings', { method: 'PUT', body: JSON.stringify({
        steam_id: current.steam_id, steam_api_key: null, sync_enabled: current.sync_enabled, sync_wishlist: current.sync_wishlist,
        sync_collection: current.sync_collection, sync_hours: current.sync_hours, region,
      }) });
      setSettings(updated); setMessage('Release region saved.');
      window.dispatchEvent(new Event(SETTINGS_CHANGED));
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function refreshCatalog() {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await discoveryApi<{ message: string }>('/catalog/refresh', { method: 'POST' });
      setMessage(response.message); setCatalog(await discoveryApi<CatalogResponse>('/catalog'));
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  async function restoreHidden() {
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await discoveryApi<{ restored: number }>('/catalog/hidden', { method: 'DELETE' });
      setMessage(`${response.restored} hidden ${response.restored === 1 ? 'game is' : 'games are'} back in the catalog.`);
      setCatalog(await discoveryApi<CatalogResponse>('/catalog'));
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }

  return <div className="settings-card">
    {error && <p className="disc-alert error" role="alert">{error}</p>}
    {message && <p className="disc-alert success" role="status">{message}</p>}
    <Row title="Release calendar region" hint="Which market the monthly physical release calendar follows.">
      <select className="form-input" value={settings?.region || 'Europe'} disabled={!settings || busy} onChange={event => void saveRegion(event.target.value)} aria-label="Release calendar region">
        {REGIONS.map(region => <option key={region}>{region}</option>)}
      </select>
    </Row>
    <Row title="Discovery opens on" hint="The view shown first when you open Discovery. Saved on this device.">
      <select className="form-input" value={view} aria-label="Default Discovery view" onChange={event => { setView(event.target.value); try { localStorage.setItem('discovery-view', event.target.value); } catch { /* private storage */ } }}>
        <option value="calendar">Release calendar</option><option value="catalog">Physical catalog</option>
      </select>
    </Row>
    <Row title="Physical catalog" hint={catalog ? <>{physical.toLocaleString()} physical Switch and Switch 2 games. {catalog.status.running ? `Refreshing now: ${catalog.status.phase || 'working'}…` : `Last refreshed: ${timestamp(catalog.status.listing_at)}.`} It refreshes on its own every few days.</> : 'Loading…'}>
      <button className="btn btn-secondary" disabled={busy || !catalog || catalog.status.running} onClick={() => void refreshCatalog()}>{catalog?.status.running ? <Loader2 size={16} className="spinner" /> : <RefreshCw size={16} />} Refresh now</button>
    </Row>
    <Row title="Hidden catalog games" hint={hidden ? `${hidden} ${hidden === 1 ? 'game is' : 'games are'} marked “Don’t show”. Restore single games from the catalog’s Hidden games button.` : 'Nothing is hidden right now.'}>
      <button className="btn btn-secondary" disabled={busy || !hidden} onClick={() => void restoreHidden()}><EyeOff size={16} /> Restore all</button>
    </Row>
  </div>;
}

function DataSettings({ isAdmin }: { isAdmin: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function download(name: string, load: () => Promise<unknown>) {
    setBusy(true); setError('');
    try {
      const url = URL.createObjectURL(new Blob([JSON.stringify(await load(), null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  return <div className="settings-card">
    {error && <p className="disc-alert error" role="alert">{error}</p>}
    <Row title="Games I want" hint="An editable JSON backup. Restore it through Smart Add.">
      <button className="btn btn-secondary" disabled={busy} onClick={() => void download('games-i-want.json', async () => (await discoveryApi<WantedGame[]>('/games')).map(payload))}><Download size={16} /> Export</button>
    </Row>
    <Row title="Full database backups" hint={isAdmin ? 'Create, download and restore complete snapshots of every collection.' : 'Complete snapshots are created automatically and managed by an administrator.'}>
      {isAdmin ? <Link className="btn btn-secondary" to="/dashboard/admin#maintenance"><Database size={16} /> Open backups</Link> : <span className="settings-note">Automatic</span>}
    </Row>
  </div>;
}

export function UserSettings() {
  const { user } = useAuth();
  const isAdmin = !!user?.is_admin;
  const sections = [
    { id: 'appearance', label: 'Appearance', icon: <Palette size={16} /> },
    { id: 'steam', label: 'Steam sync', icon: <Workflow size={16} /> },
    { id: 'discovery', label: 'Discovery', icon: <Compass size={16} /> },
    ...(isAdmin ? [{ id: 'display', label: 'Lists', icon: <LayoutList size={16} /> }] : []),
    { id: 'data', label: 'Your data', icon: <Database size={16} /> },
  ];
  const [active, setActive] = useState(() => window.location.hash.slice(1) || 'appearance');
  useEffect(() => {
    const observer = new IntersectionObserver(entries => {
      const top = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (top) setActive(top.target.id);
    }, { rootMargin: '-90px 0px -55% 0px' });
    document.querySelectorAll('.settings-section').forEach(node => observer.observe(node));
    return () => observer.disconnect();
  }, [isAdmin]);
  useEffect(() => {
    // Deep links such as /settings#steam land on the right section once it has rendered.
    const id = window.location.hash.slice(1);
    if (id) window.setTimeout(() => document.getElementById(id)?.scrollIntoView(), 50);
  }, []);

  return (
    <div className="container vg-support-page">
      <div>
        <Link to="/dashboard/videogames" className="vg-back-link">
          <ArrowLeft size={18} />
          Back to Videogames
        </Link>
      </div>

      <VideogamePageHeader eyebrow="Personal preferences" icon={<Settings2 />} title="Settings" description="How the tracker looks, what it syncs and where your data goes." />

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {sections.map(section => <a key={section.id} href={`#${section.id}`} aria-current={active === section.id ? 'true' : undefined}>{section.icon}{section.label}</a>)}
          {isAdmin && <><hr /><Link to="/dashboard/admin"><Shield size={16} />Videogame admin</Link><Link to="/dashboard/boardgames/admin"><Shield size={16} />Board game admin</Link></>}
        </nav>

        <div className="settings-content">
          <Section id="appearance" eyebrow="LOOK & FEEL" title="Appearance" description="Make the tracker yours.">
            <AppearanceSettings />
          </Section>
          <Section id="steam" eyebrow="CONNECTIONS" title="Steam sync" description="Your wishlist and owned-library schedule, match reviews and sync history.">
            <p><Link className="btn btn-secondary" to="/dashboard/videogames/steam-purchases">Import purchase prices</Link></p>
            <DiscoveryAdmin embedded />
          </Section>
          <Section id="discovery" eyebrow="RELEASES" title="Discovery" description="The release calendar and the physical Switch catalog.">
            <DiscoverySettingsCard />
          </Section>
          {isAdmin && <Section id="display" eyebrow="LISTS" title="Collection lists" description="Page limits offered in the videogame and board-game libraries. Applies to every user.">
            <PaginationSettingsAdmin />
          </Section>}
          <Section id="data" eyebrow="EXPORT & BACKUP" title="Your data" description="Take your lists with you.">
            <DataSettings isAdmin={isAdmin} />
          </Section>
        </div>
      </div>
    </div>
  );
}
