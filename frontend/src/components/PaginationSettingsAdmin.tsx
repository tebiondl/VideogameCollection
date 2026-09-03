import { useEffect, useState } from 'react';
import { Check, Infinity as InfinityIcon, ListOrdered, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';

const DEFAULT_VALUES = ['5', '10', '20', '50'];

export function PaginationSettingsAdmin() {
  const [values, setValues] = useState(DEFAULT_VALUES);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        const response = await fetchWithAuth('/settings/pagination');
        if (response.ok) {
          const data: { page_sizes: number[] } = await response.json();
          setValues(data.page_sizes.map(String));
        }
      } catch (error) {
        console.error('Failed to load pagination settings', error);
      } finally {
        setIsLoading(false);
      }
    };
    void load();
  }, []);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const pageSizes = values.map(Number);
    if (pageSizes.some(value => !Number.isInteger(value) || value < 1 || value > 500) || new Set(pageSizes).size !== 4) {
      alert('Enter four different whole numbers between 1 and 500.');
      return;
    }
    setIsSaving(true); setSaved(false);
    try {
      const response = await fetchWithAuth('/settings/pagination', { method: 'PUT', body: JSON.stringify({ page_sizes: pageSizes }) });
      if (!response.ok) { const data = await response.json().catch(() => null); throw new Error(data?.detail || 'Could not save pagination settings.'); }
      const data: { page_sizes: number[] } = await response.json();
      setValues(data.page_sizes.map(String)); setSaved(true);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Could not save pagination settings.');
    } finally {
      setIsSaving(false);
    }
  };

  return <section className="glass-card admin-pagination-card">
    <div className="admin-pagination-heading"><div><h2><ListOrdered size={22} /> Collection pagination</h2><p className="text-secondary">Choose the four page limits offered in both the videogame and board-game libraries.</p></div><span><InfinityIcon size={16} /> Infinite is always available</span></div>
    {isLoading ? <div className="admin-list-loading"><Loader2 className="spinner" size={24} /></div> : <form onSubmit={save}>
      <div className="admin-page-size-grid">{values.map((value, index) => <label key={index}>Option {index + 1}<input className="form-input" type="number" min="1" max="500" step="1" value={value} onChange={event => setValues(current => current.map((entry, entryIndex) => entryIndex === index ? event.target.value : entry))} /></label>)}</div>
      <div className="admin-pagination-actions"><small>Values are sorted from smallest to largest when saved.</small><button className="btn btn-primary" type="submit" disabled={isSaving || values.some(value => !value)}>{isSaving ? <Loader2 size={18} className="spinner" /> : saved ? <Check size={18} /> : null}{saved ? 'Saved' : 'Save page limits'}</button></div>
    </form>}
  </section>;
}
