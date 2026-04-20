import { useState, useRef, useEffect } from 'react';

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
  const inputRef = useRef<HTMLInputElement>(null);
  
  // Convert comma string to array for easy rendering
  const selectedTags = selectedTagsString 
    ? selectedTagsString.split(',').map(t => t.trim()).filter(Boolean) 
    : [];

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggleTag = (tagName: string) => {
    let newTags;
    if (selectedTags.includes(tagName)) {
      newTags = selectedTags.filter(t => t !== tagName);
    } else {
      newTags = [...selectedTags, tagName];
    }
    onChange(newTags.join(', '));
    // Focus back on input after click
    inputRef.current?.focus();
  };

  const filteredTags = availableTags.filter(tag => 
    tag.name.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="tag-multiselect" style={{ position: 'relative' }} ref={dropdownRef}>
      <div 
        className="form-input" 
        onClick={() => {
          setIsOpen(true);
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
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', outline: 'none', flex: 1, minWidth: '80px', padding: 0 }}
          placeholder={selectedTags.length === 0 ? "Search tags..." : ""}
        />
      </div>
      
      {isOpen && (
        <div 
          className="glass-card" 
          style={{ 
            position: 'absolute', top: '100%', left: 0, right: 0, 
            zIndex: 100, maxHeight: '200px', overflowY: 'auto', 
            marginTop: '4px', padding: '0.5rem',
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
        </div>
      )}
    </div>
  );
}
