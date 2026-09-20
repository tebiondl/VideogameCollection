import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Check, Loader2, Settings2 } from 'lucide-react';
import { DiscoveryAdmin } from './DiscoveryAdmin';
import { PaginationSettingsAdmin } from '../components/PaginationSettingsAdmin';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import { fetchWithAuth } from '../lib/api';
import type { CopyOptions } from '../lib/discovery';
import './DashboardPage.css';
import './AdminDashboard.css';

export function UserSettings() {
  const [copyOptionsDraft, setCopyOptionsDraft] = useState({ platforms: '', sources: '' });
  const [isSavingCopyOptions, setIsSavingCopyOptions] = useState(false);
  const [copyOptionsMessage, setCopyOptionsMessage] = useState('');

  useEffect(() => {
    void fetchCopyOptions();
  }, []);

  async function fetchCopyOptions() {
    try {
      const res = await fetchWithAuth('/discovery/copy-options');
      if (res.ok) {
        const data: CopyOptions = await res.json();
        setCopyOptionsDraft({ platforms: data.platforms.join('\n'), sources: data.sources.join('\n') });
      }
    } catch (err) {
      console.error('Failed to fetch owned copy options', err);
    }
  }

  async function saveCopyOptions(event: React.FormEvent) {
    event.preventDefault();
    setIsSavingCopyOptions(true);
    setCopyOptionsMessage('');
    const lines = (value: string) => [...new Set(value.split('\n').map(item => item.trim()).filter(Boolean))];
    try {
      const res = await fetchWithAuth('/discovery/copy-options', {
        method: 'PUT',
        body: JSON.stringify({ platforms: lines(copyOptionsDraft.platforms), sources: lines(copyOptionsDraft.sources) })
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.detail || 'Could not save owned copy options.');
      const data: CopyOptions = await res.json();
      setCopyOptionsDraft({ platforms: data.platforms.join('\n'), sources: data.sources.join('\n') });
      setCopyOptionsMessage('Owned copy dropdowns saved.');
    } catch (err) {
      setCopyOptionsMessage(err instanceof Error ? err.message : 'Could not save owned copy options.');
    } finally {
      setIsSavingCopyOptions(false);
    }
  }

  return (
    <div className="container vg-support-page">
      <div>
        <Link to="/dashboard/videogames" className="vg-back-link">
          <ArrowLeft size={18} />
          Back to Tracker
        </Link>
      </div>

      <VideogamePageHeader eyebrow="Personal preferences" icon={<Settings2 />} title="User Settings" description="Manage your Steam connection, owned-copy fields, and collection display preferences." />

      <nav className="admin-jump-nav" aria-label="User settings sections">
        <a href="#steam">Steam sync</a>
        <a href="#copies">Copy fields</a>
        <a href="#display">Display</a>
      </nav>

      <div className="admin-settings-stack">
        <section id="steam" className="admin-anchor-section">
          <div className="admin-group-heading"><span>CONNECTIONS & IMPORTS</span><h2>Steam and wanted games</h2><p>Manage your wishlist and owned-library schedule, connection status, match reviews, and exports.</p></div>
          <DiscoveryAdmin embedded />
        </section>

        <section id="copies" className="glass-card admin-anchor-section admin-standard-card">
          <h2 style={{ marginBottom: '.6rem' }}>Owned Copy Dropdowns</h2>
          <p className="text-secondary" style={{ marginBottom: '1.5rem' }}>These values appear in the Platform and Source dropdowns whenever you add or edit a copy. Enter one value per line; line order controls dropdown order.</p>
          <form onSubmit={saveCopyOptions}>
            <div className="admin-copy-options-grid">
              <label className="form-label">Platforms<textarea className="form-input" rows={8} value={copyOptionsDraft.platforms} onChange={event => setCopyOptionsDraft(current => ({ ...current, platforms: event.target.value }))} /></label>
              <label className="form-label">Sources<textarea className="form-input" rows={8} value={copyOptionsDraft.sources} onChange={event => setCopyOptionsDraft(current => ({ ...current, sources: event.target.value }))} /></label>
            </div>
            {copyOptionsMessage && <p className="text-secondary" role="status" style={{ marginTop: '.8rem' }}>{copyOptionsMessage}</p>}
            <button className="btn btn-primary" type="submit" disabled={isSavingCopyOptions || !copyOptionsDraft.platforms.trim() || !copyOptionsDraft.sources.trim()} style={{ marginTop: '1rem' }}>
              {isSavingCopyOptions ? <Loader2 size={18} className="spinner" /> : <Check size={18} />} Save dropdown values
            </button>
          </form>
        </section>

        <section id="display" className="admin-anchor-section">
          <div className="admin-group-heading"><span>DISPLAY</span><h2>Collection display</h2><p>Control how many games appear on each collection page.</p></div>
          <PaginationSettingsAdmin />
        </section>
      </div>
    </div>
  );
}
