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
  const dropdownRef = useRef<HTMLDivElement>(null);
  
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
  };

  return (
    <div className="tag-multiselect" style={{ position: 'relative' }} ref={dropdownRef}>
      <div 
        className="form-input" 
        onClick={() => setIsOpen(!isOpen)} 
        style={{ minHeight: '42px', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', cursor: 'pointer', alignItems: 'center' }}
      >
        {selectedTags.length === 0 ? (
          <span style={{ color: 'var(--text-muted)' }}>Select tags...</span>
        ) : (
          selectedTags.map(tag => (
            <span key={tag} className="badge" style={{ backgroundColor: 'var(--accent-primary)', color: '#fff', fontSize: '0.75rem' }}>
              {tag}
            </span>
          ))
        )}
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
          {availableTags.length === 0 ? (
             <div style={{ padding: '0.5rem', color: 'var(--text-muted)', fontSize: '0.9rem' }}>No tags available</div>
          ) : (
            availableTags.map(tag => (
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
