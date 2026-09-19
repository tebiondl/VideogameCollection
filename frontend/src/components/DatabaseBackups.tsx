import { useEffect, useState } from 'react';
import { DatabaseBackup, Download, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';

interface DatabaseBackupInfo {
  name: string;
  size_bytes: number;
  created_at: string;
  sha256: string;
}

interface DatabaseBackupStatus {
  supported: boolean;
  retention: number;
  interval_hours: number;
  total_size_bytes: number;
  backups: DatabaseBackupInfo[];
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function DatabaseBackups() {
  const [status, setStatus] = useState<DatabaseBackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function fetchBackups() {
    try {
      const response = await fetchWithAuth('/backups');
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || 'Could not load database backups.');
      setStatus(await response.json());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not load database backups.');
    }
  }

  useEffect(() => { fetchBackups(); }, []);

  async function createBackup() {
    setBusy(true); setMessage('');
    try {
      const response = await fetchWithAuth('/backups', { method: 'POST' });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || 'Could not create the backup.');
      await fetchBackups();
      setMessage('Verified database backup created.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not create the backup.');
    } finally { setBusy(false); }
  }

  async function downloadBackup(backup: DatabaseBackupInfo) {
    setBusy(true); setMessage('');
    try {
      const response = await fetchWithAuth(`/backups/${encodeURIComponent(backup.name)}`);
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || 'Could not download the backup.');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a'); link.href = url; link.download = backup.name; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not download the backup.');
    } finally { setBusy(false); }
  }

  async function deleteBackup(backup: DatabaseBackupInfo) {
    if (!window.confirm(`Delete backup ${backup.name}?`)) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetchWithAuth(`/backups/${encodeURIComponent(backup.name)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error((await response.json().catch(() => null))?.detail || 'Could not delete the backup.');
      await fetchBackups();
      setMessage('Backup deleted.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not delete the backup.');
    } finally { setBusy(false); }
  }

  async function restoreBackup(backup: DatabaseBackupInfo) {
    const createdAt = new Date(backup.created_at).toLocaleString();
    if (!window.confirm(`Restore the complete database from ${createdAt}?\n\nAll current videogame and board-game data will be replaced. A safety backup of the current database will be created automatically first.`)) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetchWithAuth(`/backups/${encodeURIComponent(backup.name)}/restore`, { method: 'POST' });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.detail || 'Could not restore the backup.');
      setMessage('Database restored successfully. A safety backup was created first. Reloading…');
      window.setTimeout(() => window.location.reload(), 1200);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not restore the backup.');
      setBusy(false);
    }
  }

  return <>
    <div className="admin-section-heading"><div><h2><DatabaseBackup /> Complete app backups</h2><p className="text-secondary">Verified, compressed snapshots containing both videogame and board-game data, including collections, wanted games, matches, users and settings.</p></div>{status && <span>{formatBytes(status.total_size_bytes)} stored</span>}</div>
    {status && <p className="admin-backup-policy">Automatic every {status.interval_hours} hours · keeping the latest {status.retention} backups · older snapshots are removed automatically.</p>}
    <div className="admin-backup-actions"><button className="btn btn-primary" onClick={createBackup} disabled={busy}>{busy ? <Loader2 size={18} className="spinner" /> : <DatabaseBackup size={18} />} Create backup now</button><p>Download an occasional copy to another drive or cloud storage to protect against disk failure.</p></div>
    {message && <p className="admin-backup-message" role="status">{message}</p>}
    <div className="admin-backup-list">{status?.backups.length ? status.backups.map(backup => <div key={backup.name}><span><strong>{new Date(backup.created_at).toLocaleString()}</strong><small>{formatBytes(backup.size_bytes)} · verified snapshot</small></span><div><button className="admin-restore-button" onClick={() => restoreBackup(backup)} disabled={busy} title="Restore this backup"><RotateCcw size={16} /> Restore</button><button className="admin-icon-button" onClick={() => downloadBackup(backup)} disabled={busy} title="Download backup"><Download size={18} /></button><button className="admin-icon-button danger" onClick={() => deleteBackup(backup)} disabled={busy} title="Delete backup"><Trash2 size={18} /></button></div></div>) : <p className="text-secondary">No backups yet. The server creates one automatically when the schedule is due.</p>}</div>
  </>;
}
