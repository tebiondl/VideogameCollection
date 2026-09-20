import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Loader2, RotateCcw, Trash2 } from 'lucide-react';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import { discoveryApi, errorMessage } from '../lib/discovery';
import './SteamTrash.css';

interface TrashedCopy {
  id: number;
  steam_appid: number;
  name: string;
  image_url: string | null;
  collection_game_name: string | null;
  playtime_hours: number | null;
  owned_on_steam: boolean;
  deleted_at: string;
  kind: 'copy' | 'dlc';
}

export function SteamTrash() {
  const [items, setItems] = useState<TrashedCopy[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    discoveryApi<TrashedCopy[]>('/steam/trash').then(setItems).catch(reason => setError(errorMessage(reason))).finally(() => setLoading(false));
  }, []);

  async function restore(item: TrashedCopy) {
    setRestoring(item.id); setError('');
    try {
      await discoveryApi(`/steam/trash/${item.id}/restore`, { method: 'POST' });
      setItems(current => current.filter(row => row.id !== item.id));
    } catch (reason) {
      setError(errorMessage(reason));
    } finally { setRestoring(null); }
  }

  return <div className="container vg-support-page steam-trash-page">
    <Link to="/dashboard/videogames/collection" className="vg-back-link"><ArrowLeft size={18} /> Back to collection</Link>
    <VideogamePageHeader eyebrow="Collection safety" icon={<Trash2 />} title="Steam copy trash" description="Copies here stay excluded from automatic Steam sync until you restore them." />
    {error && <p className="disc-alert error" role="alert">{error}</p>}
    {loading ? <div className="trash-empty"><Loader2 className="spinner" /></div> : items.length === 0 ? <div className="glass-card trash-empty"><Trash2 size={34} /><h2>Trash is empty</h2><p className="text-muted">Deleted linked Steam copies will appear here.</p></div> : <div className="steam-trash-grid">
      {items.map(item => <article className="glass-card steam-trash-card" key={item.id}>
        {item.image_url ? <img src={item.image_url} alt="" /> : <div className="steam-trash-cover"><Trash2 /></div>}
        <div><h2>{item.name}</h2><p>{item.kind === 'dlc' ? 'DLC' : 'Copy'} previously in {item.collection_game_name || 'your collection'}</p><small>Steam app {item.steam_appid}{item.playtime_hours != null ? ` · ${item.playtime_hours} hrs` : ''} · Deleted {new Date(`${item.deleted_at}Z`).toLocaleDateString()}</small>{!item.owned_on_steam && <p className="trash-warning">Not present in the latest Steam library snapshot.</p>}</div>
        <button className="btn btn-primary" disabled={restoring !== null || !item.owned_on_steam} onClick={() => restore(item)}>{restoring === item.id ? <Loader2 className="spinner" size={17} /> : <RotateCcw size={17} />} Restore</button>
      </article>)}
    </div>}
  </div>;
}
