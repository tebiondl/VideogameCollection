import { useEffect, useMemo, useState } from 'react';
import type { ChangeEvent, ClipboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ClipboardPaste, Loader2, Receipt, Upload } from 'lucide-react';
import { VideogamePageHeader } from '../components/VideogamePageHeader';
import { fetchWithAuth } from '../lib/api';
import { matchPurchasesToCopies, parseSteamPurchaseHistory } from '../lib/steamPurchases';
import type { PriceProposal, PurchaseGame, PurchaseHistory, UnmatchedPurchase } from '../lib/steamPurchases';
import './SteamPurchases.css';

const HISTORY_URL = 'https://store.steampowered.com/account/history/';

interface Row extends PriceProposal { selected: boolean; value: string }

const money = (amount: number, currency: string) => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount); }
  catch { return `${amount.toFixed(2)} ${currency}`; }
};

async function fetchGames(): Promise<PurchaseGame[]> {
  const response = await fetchWithAuth('/videogames/');
  if (!response.ok) throw new Error('Could not load your collection.');
  return response.json();
}

export function SteamPurchases() {
  const [games, setGames] = useState<PurchaseGame[] | null>(null);
  const [history, setHistory] = useState<PurchaseHistory | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [unmatched, setUnmatched] = useState<UnmatchedPurchase[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  useEffect(() => { fetchGames().then(setGames).catch(reason => setError(reason instanceof Error ? reason.message : 'Could not load your collection.')); }, []);

  function read(html: string, collection = games) {
    setSaved(''); setError('');
    if (!collection) { setError('Your collection is still loading. Try again in a moment.'); return; }
    const parsed = parseSteamPurchaseHistory(html);
    if (parsed.purchases.length === 0) {
      setHistory(null); setRows([]); setUnmatched([]);
      setError('No purchases were found. Copy the whole purchase history page (Ctrl+A, Ctrl+C), or save it as “Webpage, Complete” and choose that file.');
      return;
    }
    const matched = matchPurchasesToCopies(parsed.purchases, collection);
    setHistory(parsed);
    setUnmatched(matched.unmatched);
    // Copies that already have a price start unticked so nothing is overwritten by accident.
    setRows(matched.proposals.map(proposal => ({ ...proposal, selected: proposal.currentPrice == null, value: proposal.price.toFixed(2) })));
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    event.preventDefault();
    // The rich clipboard keeps the table structure; plain text loses the columns.
    read(event.clipboardData.getData('text/html') || event.clipboardData.getData('text/plain'));
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) read(await file.text());
  }

  const update = (index: number, patch: Partial<Row>) => setRows(current => current.map((row, rowIndex) => rowIndex === index ? { ...row, ...patch } : row));
  const chosen = useMemo(() => rows.filter(row => row.selected), [rows]);
  const invalid = chosen.some(row => row.value.trim() === '' || !(Number(row.value) >= 0));
  const total = chosen.reduce((sum, row) => sum + (Number(row.value) || 0), 0);
  const unmatchedTotal = unmatched.reduce((sum, row) => sum + row.price, 0);
  const currency = rows[0]?.currency || 'EUR';

  async function save() {
    setSaving(true); setError(''); setSaved('');
    try {
      const response = await fetchWithAuth('/videogames/copy-prices', {
        method: 'POST',
        body: JSON.stringify({ prices: chosen.map(row => ({ game_id: row.gameId, copy_id: row.copyId, price: Number(row.value), currency: row.currency })) }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(typeof data.detail === 'string' ? data.detail : `Could not save the prices (${response.status}).`);
      }
      const count = chosen.length;
      setGames(await fetchGames());
      setRows(current => current.map(row => row.selected ? { ...row, selected: false, currentPrice: Number(row.value), currentCurrency: row.currency } : row));
      setSaved(`Saved the price of ${count} ${count === 1 ? 'copy' : 'copies'}.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save the prices.');
    } finally { setSaving(false); }
  }

  return <div className="container vg-support-page steam-purchases-page">
    <Link to="/dashboard/videogames/settings#steam" className="vg-back-link"><ArrowLeft size={18} /> Back to Steam settings</Link>
    <VideogamePageHeader eyebrow="Steam" icon={<Receipt />} title="Purchase prices" description="Fill in what you paid for your Steam copies from your Steam purchase history. Nothing is saved until you confirm." />

    <section className="glass-card purchases-step">
      <ol>
        <li>Open your <a href={HISTORY_URL} target="_blank" rel="noreferrer">Steam purchase history</a> and press “Load more transactions” until the whole list is showing.</li>
        <li>Select everything (Ctrl+A), copy it (Ctrl+C) and paste it in the box below. The page stays in your browser; only the prices you confirm are saved.</li>
      </ol>
      <textarea className="form-input purchases-paste" aria-label="Paste the Steam purchase history here" placeholder="Click here and paste (Ctrl+V)" value="" onChange={() => undefined} onPaste={onPaste} disabled={!games} />
      <label className="btn btn-secondary purchases-file"><Upload size={16} /> Or choose a saved page<input type="file" accept=".html,.htm,.mhtml,text/html" onChange={onFile} hidden /></label>
    </section>

    {error && <p className="purchases-alert error" role="alert">{error}</p>}
    {saved && <p className="purchases-alert success" role="status">{saved}</p>}
    {!games && !error && <div className="purchases-loading"><Loader2 className="spinner" /></div>}

    {history && <section className="glass-card purchases-results">
      <p className="purchases-summary">
        <ClipboardPaste size={16} /> {history.purchases.length} purchases read · {rows.length} matched to a Steam copy · {unmatched.length} without a match
        {history.refunded > 0 && ` · ${history.refunded} refunds left out`}{history.skipped > 0 && ` · ${history.skipped} other rows ignored (gifts, market, in-game)`}
      </p>
      {rows.length === 0 ? <p className="text-muted">None of the purchased items has the same name as a Steam copy in your collection.</p> : <>
        <div className="purchases-table-wrap"><table className="purchases-table">
          <thead><tr>
            <th><input type="checkbox" aria-label="Select all" checked={chosen.length === rows.length} onChange={event => setRows(current => current.map(row => ({ ...row, selected: event.target.checked })))} /></th>
            <th>Game</th><th>Bought</th><th>Paid</th><th>Saved now</th><th>Notes</th>
          </tr></thead>
          <tbody>{rows.map((row, index) => <tr key={`${row.gameId}:${row.copyId}`} className={row.selected ? '' : 'off'}>
            <td><input type="checkbox" aria-label={`Use the price for ${row.gameName}`} checked={row.selected} onChange={event => update(index, { selected: event.target.checked })} /></td>
            <td><strong>{row.gameName}</strong>{row.copyName !== row.gameName && <small>{row.copyName}</small>}</td>
            <td>{row.date}</td>
            <td><span className="purchases-price"><input className="form-input" type="number" min="0" step="0.01" aria-label={`Price paid for ${row.gameName}`} value={row.value} onChange={event => update(index, { value: event.target.value })} /> {row.currency}</span></td>
            <td>{row.currentPrice == null ? <span className="text-muted">—</span> : money(row.currentPrice, row.currentCurrency)}</td>
            <td className="purchases-notes">
              {row.sharedWith > 1 && <span className="warn">Estimate: the total was shared equally between {row.sharedWith} items</span>}
              {row.purchases > 1 && <span>{row.purchases} purchases added together</span>}
            </td>
          </tr>)}</tbody>
        </table></div>
        <div className="purchases-actions">
          <span>{chosen.length} selected · {money(total, currency)}</span>
          <button className="btn btn-primary" disabled={saving || chosen.length === 0 || invalid} onClick={save}>{saving ? <Loader2 className="spinner" size={17} /> : <Receipt size={17} />} Save {chosen.length} {chosen.length === 1 ? 'price' : 'prices'}</button>
        </div>
      </>}
      {unmatched.length > 0 && <details className="purchases-unmatched">
        <summary>{unmatched.length} purchased items without a match · {money(unmatchedTotal, unmatched[0].currency)}</summary>
        <p className="text-muted">Packs, DLC, wallet top-ups and games whose Steam copy has a different name or is not in your collection. Set these prices by hand on the copy.</p>
        <ul>{unmatched.map((item, index) => <li key={index}><span>{item.name}</span><small>{item.date}</small><span>{money(item.price, item.currency)}{item.sharedWith > 1 ? ' (estimate)' : ''}</span></li>)}</ul>
      </details>}
    </section>}
  </div>;
}
