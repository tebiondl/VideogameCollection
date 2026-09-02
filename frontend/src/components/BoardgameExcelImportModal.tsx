import { useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, Check, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import './BoardgameExcelImportModal.css';

interface ImportStats {
  wishlist_games: number;
  owned_games: number;
  match_only_games: number;
  matches: number;
  unknown_dates: number;
  incomplete_matches: number;
  games_already_present: number;
  matches_already_present: number;
}

interface ImportPreview {
  filename: string;
  warnings: string[];
  stats: ImportStats;
  samples: { wishlist: string[]; owned: string[]; match_games: string[] };
}

interface ImportResult {
  games_created: number;
  games_updated: number;
  games_skipped: number;
  matches_created: number;
  matches_skipped: number;
}

export function BoardgameExcelImportModal({ onClose, onImported }: { onClose: () => void; onImported: () => Promise<void> | void }) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState('');
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  const readError = async (response: Response, fallback: string) => {
    const data = await response.json().catch(() => null);
    return data?.detail || fallback;
  };

  const previewFile = async (selected: File) => {
    setFile(selected); setPreview(null); setResult(null); setError(''); setIsPreviewing(true);
    const form = new FormData(); form.append('file', selected);
    try {
      const response = await fetchWithAuth('/boardgames/bulk-import/preview', { method: 'POST', body: form });
      if (!response.ok) throw new Error(await readError(response, 'Could not read this workbook.'));
      setPreview(await response.json());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not read this workbook.');
    } finally { setIsPreviewing(false); }
  };

  const commitImport = async () => {
    if (!file || !preview) return;
    setIsImporting(true); setError('');
    const form = new FormData(); form.append('file', file);
    try {
      const response = await fetchWithAuth('/boardgames/bulk-import/commit', { method: 'POST', body: form });
      if (!response.ok) throw new Error(await readError(response, 'The workbook could not be imported.'));
      setResult(await response.json());
      await onImported();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The workbook could not be imported.');
    } finally { setIsImporting(false); }
  };

  return createPortal(
    <div className="bg-modal-backdrop" onMouseDown={() => !isImporting && onClose()}>
      <section className="bg-modal bg-import-modal" role="dialog" aria-modal="true" aria-labelledby="excel-import-title" onMouseDown={event => event.stopPropagation()}>
        <header><div className="import"><FileSpreadsheet /></div><div><span>Smart Add</span><h2 id="excel-import-title">Import board-game Excel</h2></div><button onClick={onClose} disabled={isImporting} aria-label="Close"><X /></button></header>
        <div className="bg-modal-scroll">
          {!result && <>
            <label className={`bg-import-dropzone ${file ? 'selected' : ''}`}>
              {isPreviewing ? <Loader2 className="spinner" /> : file ? <FileSpreadsheet /> : <Upload />}
              <strong>{isPreviewing ? 'Reading workbook…' : file ? file.name : 'Choose an Excel workbook'}</strong>
              <span>Wishlist, collection, expansions and matches are recognized automatically.</span>
              <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={isPreviewing || isImporting} onChange={event => { const selected = event.target.files?.[0]; if (selected) void previewFile(selected); }} />
            </label>
            {error && <div className="bg-import-error"><AlertTriangle />{error}</div>}
            {preview && <>
              <div className="bg-import-stats">
                <div><strong>{preview.stats.wishlist_games}</strong><span>Wishlist entries</span></div>
                <div><strong>{preview.stats.owned_games}</strong><span>Owned games</span></div>
                <div><strong>{preview.stats.matches}</strong><span>Matches</span></div>
                <div><strong>{preview.stats.unknown_dates}</strong><span>Unknown dates</span></div>
              </div>
              <div className="bg-import-summary"><Check /><div><strong>Ready to import</strong><span>{preview.stats.match_only_games} owned games will be inferred from match history. Re-uploading the same workbook is safe: {preview.stats.games_already_present} games and {preview.stats.matches_already_present} matches already exist.</span></div></div>
              <div className="bg-import-samples">
                <div><strong>Wishlist sample</strong><span>{preview.samples.wishlist.join(' · ') || 'None'}</span></div>
                <div><strong>Collection sample</strong><span>{preview.samples.owned.join(' · ') || 'None'}</span></div>
                <div><strong>Match sample</strong><span>{preview.samples.match_games.join(' · ') || 'None'}</span></div>
              </div>
              {preview.warnings.length > 0 && <details className="bg-import-warnings"><summary><AlertTriangle /> {preview.warnings.length} import notes</summary><ul>{preview.warnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul></details>}
            </>}
          </>}
          {result && <div className="bg-import-success"><div><Check /></div><h3>Import complete</h3><p>Your workbook has been added to the board-game vault.</p><div><span><strong>{result.games_created}</strong> games created</span><span><strong>{result.games_updated}</strong> games updated</span><span><strong>{result.matches_created}</strong> matches created</span><span><strong>{result.matches_skipped}</strong> duplicate matches skipped</span></div></div>}
        </div>
        <footer>{result ? <button className="btn btn-primary" onClick={onClose}>Done</button> : <><button className="btn btn-secondary" onClick={onClose} disabled={isImporting}>Cancel</button><button className="btn btn-primary" onClick={commitImport} disabled={!preview || isImporting}>{isImporting ? <Loader2 className="spinner" /> : <Upload />} Import everything</button></>}</footer>
      </section>
    </div>,
    document.body,
  );
}
