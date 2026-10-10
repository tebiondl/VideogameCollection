import { useId, useState } from 'react';
import { matchingCopyRegions } from '../lib/copyRegions';
import './CopyRegionSelect.css';

export function CopyRegionSelect({ value, onChange }: {
  value: string | null | undefined;
  onChange: (region: string | null) => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const matches = matchingCopyRegions(query);
  const options: { value: string | null; label: string }[] = [
    ...(!query.trim() ? [{ value: null, label: 'Not specified' }] : []),
    ...matches.map(region => ({ value: region.value, label: region.value })),
    ...(query.trim() && !matches.some(region => region.value.toLowerCase() === query.trim().toLowerCase())
      ? [{ value: query.trim(), label: `Use “${query.trim()}”` }] : []),
  ];
  const select = (region: string | null) => {
    onChange(region);
    setOpen(false);
    setQuery('');
    setActiveIndex(0);
  };
  return <div className="copy-region-select" onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
      setQuery('');
    }
  }}>
    <label htmlFor={id}>Region / edition</label>
    <input id={id} className="form-input" role="combobox" aria-expanded={open}
      aria-controls={`${id}-options`} aria-autocomplete="list"
      aria-activedescendant={open ? `${id}-option-${activeIndex}` : undefined}
      autoComplete="off" maxLength={120} value={open ? query : value || ''}
      placeholder={value || 'Search country, region or code…'}
      onFocus={() => { setOpen(true); setQuery(''); setActiveIndex(0); }}
      onClick={() => { if (!open) { setOpen(true); setQuery(''); setActiveIndex(0); } }}
      onChange={event => { setQuery(event.target.value); setOpen(true); setActiveIndex(0); }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); setQuery(''); }
        else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          if (!open) { setOpen(true); setQuery(''); setActiveIndex(0); }
          else {
            const next = (activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
            setActiveIndex(next);
            document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: 'nearest' });
          }
        } else if (event.key === 'Enter' && open) {
          event.preventDefault();
          if (options[activeIndex]) select(options[activeIndex].value);
        }
      }} />
    {open && <div id={`${id}-options`} role="listbox" aria-label="Copy regions" className="copy-region-options">
      {options.map((option, index) => <button key={option.value || 'unspecified'}
        id={`${id}-option-${index}`} type="button" role="option" tabIndex={-1}
        aria-selected={index === activeIndex} className={index === activeIndex ? 'active' : ''}
        onMouseDown={event => event.preventDefault()} onClick={() => select(option.value)}>
        {option.label}
      </button>)}
    </div>}
    <small className="text-muted">The country or region printed on the box or cartridge.</small>
  </div>;
}
