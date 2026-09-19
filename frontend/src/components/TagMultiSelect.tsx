import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';

interface Tag {
  id: number;
  name: string;
}

interface TagMultiSelectProps {
  availableTags: Tag[];
  selectedTagsString: string; 
  onChange: (newTagsString: string) => void;
}

export function TagMultiSelect({ availableTags, selectedTagsString, onChange }: TagMultiSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [menuStyle, setMenuStyle] = useState<React.CSSProperties>({});
  const [portalContainer, setPortalContainer] = useState<Element | null>(null);
  
  // Convert comma string to array for easy rendering
  const selectedTags = selectedTagsString 
    ? selectedTagsString.split(',').map(t => t.trim()).filter(Boolean) 
    : [];

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node) && !menuRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  useLayoutEffect(() => {
    if (!isOpen) return;
    const place = () => {
      const rect = dropdownRef.current?.getBoundingClientRect();
      if (!rect) return;
      const availableBelow = window.innerHeight - rect.bottom - 12;
      const height = Math.min(260, Math.max(140, availableBelow >= 180 ? availableBelow : rect.top - 12));
      const openAbove = availableBelow < 180 && rect.top > availableBelow;
      const width = Math.min(Math.max(rect.width, 260), window.innerWidth - 24);
      const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
      setMenuStyle({ position: 'fixed', left, top: openAbove ? Math.max(12, rect.top - height - 4) : rect.bottom + 4, width, maxHeight: height, zIndex: 12000 });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [isOpen]);

  const toggleTag = (tagName: string) => {
    let newTags;
    if (selectedTags.includes(tagName)) {
      newTags = selectedTags.filter(t => t !== tagName);
    } else {
      newTags = [...selectedTags, tagName];
    }
    onChange(newTags.join(', '));
    setFilter('');
    // Focus back on input after click
    inputRef.current?.focus();
  };

  const openMenu = () => {
    setPortalContainer(dropdownRef.current?.closest('dialog') || document.body);
    setIsOpen(true);
  };

  const filteredTags = availableTags.filter(tag => 
    tag.name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="tag-multiselect" style={{ position: 'relative' }} ref={dropdownRef}>
      <div 
        className="form-input" 
        onClick={() => {
          openMenu();
          inputRef.current?.focus();
        }} 
        style={{ minHeight: '42px', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', cursor: 'text', alignItems: 'center' }}
      >
        {selectedTags.map(tag => (
          <span key={tag} className="badge" style={{ backgroundColor: 'var(--accent-primary)', color: '#fff', fontSize: '0.75rem', display: 'flex', alignItems: 'center', gap: '4px' }}>
            {tag}
            <span 
              onClick={(e) => {
                e.stopPropagation();
                toggleTag(tag);
              }}
              style={{ cursor: 'pointer', opacity: 0.8, fontSize: '0.9rem', lineHeight: 1 }}
              title="Remove tag"
            >
              ×
            </span>
          </span>
        ))}
        <input
          ref={inputRef}
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            openMenu();
          }}
          onFocus={openMenu}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none', flex: 1, minWidth: '80px', padding: 0 }}
          placeholder={selectedTags.length === 0 ? "Search tags..." : ""}
        />
      </div>
      
      {isOpen && portalContainer && createPortal(
        <div 
          ref={menuRef}
          className="glass-card" 
          style={{ 
            ...menuStyle, overflowY: 'auto', padding: '0.5rem',
            border: '1px solid var(--border-color)'
          }}
        >
          {filteredTags.length === 0 ? (
             <div style={{ padding: '0.5rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>No tags found</div>
          ) : (
            filteredTags.map(tag => (
              <label key={tag.id} style={{ display: 'flex', padding: '0.5rem', cursor: 'pointer', gap: '0.75rem', alignItems: 'center', transition: 'background 0.2s', borderRadius: '4px' }} className="tag-option">
                <input 
                  type="checkbox" 
                  checked={selectedTags.includes(tag.name)}
                  onChange={() => toggleTag(tag.name)}
                  style={{ accentColor: 'var(--accent-primary)', width: '16px', height: '16px' }}
                />
                <span style={{ color: 'var(--text-primary)' }}>{tag.name}</span>
              </label>
           ))
          )}
        </div>, portalContainer
      )}
    </div>
  );
}
