import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { fetchWithAuth } from '../lib/api';
import { compatibleCopyFormat, compatibleCopyFormats, compatibleCopySources, isCopySourceCompatible, isSteamSource, preferredCopySource, sameCopyValue } from '../lib/copyCompatibility';
import { EMPTY_COPY_OPTIONS, errorMessage } from '../lib/discovery';
import type { AcquireDraft, CopyOptions } from '../lib/discovery';
import { DlcEditor } from './DlcEditor';
import { TagMultiSelect } from './TagMultiSelect';
import './DiscoveryDialog.css';

export function AcquireGameEditor({ initial, nonSteamOnly = false, onClose, onSave }: { initial: AcquireDraft; nonSteamOnly?: boolean; onClose: () => void; onSave: (draft: AcquireDraft) => Promise<void> }) {
  const [draft, setDraft] = useState(() => nonSteamOnly ? { ...initial, source: initial.source.toLowerCase() === 'steam' ? '' : initial.source, steam_appid: null, store_url: initial.store_url?.toLowerCase().includes('steampowered.com/app/') ? null : initial.store_url } : initial);
  const [tags, setTags] = useState<{ id: number; name: string }[]>([]);
  const [copyOptions, setCopyOptions] = useState<CopyOptions>(EMPTY_COPY_OPTIONS);
  const [collectionGames, setCollectionGames] = useState<{ id: number; name: string; is_dlc: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    Promise.all([
      fetchWithAuth('/videogames/tags').then(response => response.ok ? response.json() : []),
      fetchWithAuth('/discovery/copy-options').then(response => response.ok ? response.json() : EMPTY_COPY_OPTIONS),
      fetchWithAuth('/videogames/').then(response => response.ok ? response.json() : []),
    ]).then(([nextTags, options, ownedGames]) => {
      setTags(nextTags);
      setCopyOptions(options);
      setCollectionGames(ownedGames.filter((game: { is_dlc: boolean }) => !game.is_dlc));
      setDraft(current => {
        const configuredSource = (options.sources as string[]).some(value => sameCopyValue(value, current.source));
        const sourceAllowed = configuredSource && isCopySourceCompatible(current.platform, current.source, options.platform_sources) && (!nonSteamOnly || !isSteamSource(current.source));
        const source = sourceAllowed ? current.source : preferredCopySource(current.platform, options.sources as string[], nonSteamOnly, options.platform_sources);
        const format = compatibleCopyFormat(current.platform, source, current.format, options.types, options.source_types);
        const keepSteamData = isSteamSource(source);
        return {
          ...current,
          source,
          format,
          steam_appid: keepSteamData ? current.steam_appid : null,
          store_url: !keepSteamData && current.store_url?.toLowerCase().includes('steampowered.com/app/') ? null : current.store_url,
        };
      });
    }).catch(() => {});
  }, [nonSteamOnly]);
  const field = <K extends keyof AcquireDraft>(key: K, value: AcquireDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const changePlatform = (platform: string) => setDraft(current => {
    const configuredSource = copyOptions.sources.some(value => sameCopyValue(value, current.source));
    const sourceAllowed = configuredSource && isCopySourceCompatible(platform, current.source, copyOptions.platform_sources) && (!nonSteamOnly || !isSteamSource(current.source));
    const source = sourceAllowed ? current.source : preferredCopySource(platform, copyOptions.sources, nonSteamOnly, copyOptions.platform_sources);
    const format = compatibleCopyFormat(platform, source, current.format, copyOptions.types, copyOptions.source_types);
    const keepSteamData = isSteamSource(source);
    return {
      ...current,
      platform,
      source,
      format,
      steam_appid: keepSteamData ? current.steam_appid : null,
      store_url: !keepSteamData && current.store_url?.toLowerCase().includes('steampowered.com/app/') ? null : current.store_url,
    };
  });
  const changeSource = (source: string) => setDraft(current => {
    const keepSteamData = isSteamSource(source);
    return {
      ...current,
      source,
      format: compatibleCopyFormat(current.platform, source, current.format, copyOptions.types, copyOptions.source_types),
      steam_appid: keepSteamData ? current.steam_appid : null,
      store_url: !keepSteamData && current.store_url?.toLowerCase().includes('steampowered.com/app/') ? null : current.store_url,
    };
  });
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const configuredSource = copyOptions.sources.some(value => sameCopyValue(value, draft.source));
    const allowedSource = configuredSource && isCopySourceCompatible(draft.platform, draft.source, copyOptions.platform_sources) && (!nonSteamOnly || !isSteamSource(draft.source));
    const source = allowedSource ? draft.source : preferredCopySource(draft.platform, copyOptions.sources, nonSteamOnly, copyOptions.platform_sources);
    const keepSteamData = isSteamSource(source) && !nonSteamOnly;
    const submitted = {
      ...draft,
      source,
      format: compatibleCopyFormat(draft.platform, source, draft.format, copyOptions.types, copyOptions.source_types),
      steam_appid: keepSteamData ? draft.steam_appid : null,
      store_url: !keepSteamData && draft.store_url?.toLowerCase().includes('steampowered.com/app/') ? null : draft.store_url,
    };
    try { await onSave(submitted); onClose(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(false); }
  }
  const sourceOptions = compatibleCopySources(draft.platform, copyOptions.sources, copyOptions.platform_sources).filter(value => !nonSteamOnly || !isSteamSource(value));
  const sourceValue = sourceOptions.find(value => sameCopyValue(value, draft.source)) || '';
  const formatOptions = compatibleCopyFormats(draft.platform, sourceValue, copyOptions.types, copyOptions.source_types);
  const formatValue = compatibleCopyFormat(draft.platform, sourceValue, draft.format, copyOptions.types, copyOptions.source_types);
  return <dialog ref={dialog} className="discovery-dialog discovery acquire-dialog" onCancel={event => { event.preventDefault(); if (!busy) onClose(); }} aria-labelledby="acquire-title">
    <div className="disc-section-heading"><div><p className="disc-eyebrow">REVIEW YOUR COPY</p><h2 id="acquire-title">{nonSteamOnly ? 'Add a non-Steam copy' : 'Move to collection'}</h2></div><button className="disc-icon-button" onClick={onClose} disabled={busy} aria-label="Close"><X /></button></div>
    <p className="disc-muted">{nonSteamOnly ? 'Steam collection sync manages the Steam copy. Add the other platform or edition you bought here.' : 'Confirm the copy you bought and adjust the game or player information before adding it.'}</p>
    {error && <p className="disc-alert error" role="alert">{error}</p>}
    <form className="disc-form" onSubmit={submit}>
      <section className="disc-form-section"><h3>Owned copy</h3><div className="disc-form-grid">
        <label>Platform<select autoFocus required value={draft.platform} onChange={event => changePlatform(event.target.value)}>{[...new Set([draft.platform, ...copyOptions.platforms].filter(Boolean))].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Type<select value={formatValue} onChange={event => field('format', event.target.value)}>{formatOptions.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Source<select required value={sourceValue} onChange={event => changeSource(event.target.value)}><option value="" disabled>Choose source</option>{sourceOptions.map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Price paid<input type="number" min={0} step="0.01" value={draft.price ?? ''} onChange={event => field('price', event.target.value ? Number(event.target.value) : null)} /></label>
        <label>Currency<select value={draft.currency} onChange={event => field('currency', event.target.value)}>{['EUR', 'USD', 'GBP', 'JPY'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label className="wide">Store / source URL<input type="url" value={draft.store_url || ''} onChange={event => field('store_url', event.target.value || null)} /></label>
      </div></section>
      <section className="disc-form-section"><h3>Game information</h3><div className="disc-form-grid">
        <label className="wide">Name<input required maxLength={300} value={draft.name} onChange={event => field('name', event.target.value)} /></label>
        <label>Release date<input type="date" value={draft.release_date || ''} onChange={event => field('release_date', event.target.value || null)} /></label>
        <label>Publication year<input type="number" min={1970} max={2200} value={draft.publication_year ?? ''} onChange={event => field('publication_year', event.target.value ? Number(event.target.value) : null)} /></label>
        <label className="disc-check"><input type="checkbox" checked={draft.is_dlc} onChange={event => setDraft(current => ({ ...current, is_dlc: event.target.checked, parent_game_id: event.target.checked ? current.parent_game_id : null }))} /> This is a DLC / expansion</label>
        {draft.is_dlc ? <label className="wide">Add expansion under<select required value={draft.parent_game_id ?? ''} onChange={event => {
          const parent = collectionGames.find(game => game.id === Number(event.target.value));
          setDraft(current => ({ ...current, parent_game_id: parent?.id ?? null, parent_game_name: parent?.name ?? null }));
        }}><option value="">Choose a game from your collection…</option>{collectionGames.map(game => <option key={game.id} value={game.id}>{game.name}</option>)}</select></label> : null}
        <label className="wide">Description<textarea rows={3} value={draft.description || ''} onChange={event => field('description', event.target.value || null)} /></label>
        <label className="wide">Cover image URL<input type="url" value={draft.image_url || ''} onChange={event => field('image_url', event.target.value || null)} /></label>
      </div></section>
      <section className="disc-form-section"><h3>Player information</h3><div className="disc-form-grid">
        <label>Status<select value={draft.status} onChange={event => field('status', event.target.value)}>{['Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'].map(value => <option key={value}>{value}</option>)}</select></label>
        <label>Playtime (hours)<input type="number" min={0} step="0.1" value={draft.playtime_hours ?? ''} onChange={event => field('playtime_hours', event.target.value ? Number(event.target.value) : null)} /></label>
        <label>Rating (1–10)<input type="number" min={1} max={10} value={draft.mark ?? ''} onChange={event => field('mark', event.target.value ? Number(event.target.value) : null)} /></label>
        <label>Anticipation (1–10)<input type="number" min={1} max={10} value={draft.hype ?? ''} onChange={event => field('hype', event.target.value ? Number(event.target.value) : null)} /></label>
        <label>Completion %<input type="number" min={0} max={100} value={draft.completion_percentage ?? ''} onChange={event => field('completion_percentage', event.target.value ? Number(event.target.value) : null)} /></label>
        <label>Completion date<input value={draft.completion_date || ''} onChange={event => field('completion_date', event.target.value || null)} placeholder="YYYY, YYYY-MM or YYYY-MM-DD" /></label>
        <div className="wide disc-field">Your tags<TagMultiSelect availableTags={tags} selectedTagsString={draft.tags || ''} onChange={value => field('tags', value || null)} /></div>
        <label className="wide">Comments / review<textarea rows={3} value={draft.comments || ''} onChange={event => field('comments', event.target.value || null)} /></label>
      </div><div><h3>Included DLCs</h3><DlcEditor value={draft.dlcs || ''} onChange={value => field('dlcs', value)} gameName={draft.name} getPortalContainer={() => dialog.current || document.body} /></div></section>
      <div className="disc-actions"><button type="button" className="btn btn-secondary" onClick={onClose} disabled={busy}>Cancel</button><button className="btn btn-primary" disabled={busy}>{busy ? 'Moving…' : nonSteamOnly ? 'Add copy to collection' : 'Add to collection'}</button></div>
    </form>
  </dialog>;
}
