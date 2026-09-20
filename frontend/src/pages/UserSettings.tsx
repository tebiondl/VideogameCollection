import { Link } from 'react-router-dom';
import { ArrowLeft, Settings2 } from 'lucide-react';
import { DiscoveryAdmin } from './DiscoveryAdmin';
import { PaginationSettingsAdmin } from '../components/PaginationSettingsAdmin';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import './DashboardPage.css';
import './AdminDashboard.css';

export function UserSettings() {
  return (
    <div className="container vg-support-page">
      <div>
        <Link to="/dashboard/videogames" className="vg-back-link">
          <ArrowLeft size={18} />
          Back to Tracker
        </Link>
      </div>

      <VideogamePageHeader eyebrow="Personal preferences" icon={<Settings2 />} title="User Settings" description="Manage your Steam connection and collection display preferences." />

      <nav className="admin-jump-nav" aria-label="User settings sections">
        <a href="#steam">Steam sync</a>
        <a href="#display">Display</a>
      </nav>

      <div className="admin-settings-stack">
        <section id="steam" className="admin-anchor-section">
          <div className="admin-group-heading"><span>CONNECTIONS & IMPORTS</span><h2>Steam and wanted games</h2><p>Manage your wishlist and owned-library schedule, connection status, match reviews, and exports.</p></div>
          <DiscoveryAdmin embedded />
        </section>

        <section id="display" className="admin-anchor-section">
          <div className="admin-group-heading"><span>DISPLAY</span><h2>Collection display</h2><p>Control how many games appear on each collection page.</p></div>
          <PaginationSettingsAdmin />
        </section>
      </div>
    </div>
  );
}
