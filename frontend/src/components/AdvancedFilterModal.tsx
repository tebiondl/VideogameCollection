import React from 'react';
import { X, Plus, Trash2, Save, FolderOpen } from 'lucide-react';
import './AdvancedFilterModal.css';

export type TagOperator = 'includes' | 'excludes';

export interface TagRule {
  type: 'rule';
  id: string;
  operator: TagOperator;
  tag: string;
}

export interface TagGroup {
  type: 'group';
  id: string;
  matchLogic: 'AND' | 'OR';
  conditions: (TagRule | TagGroup)[];
}

export interface FilterState {
  tagQuery: TagGroup;
  statusFilter: string[];
  completionRange: { min: number | ''; max: number | ''; includeEmpty: boolean };
  ratingRange: { min: number | ''; max: number | '' };
}

export const DEFAULT_FILTER_STATE: FilterState = {
  tagQuery: { type: 'group', id: 'root', matchLogic: 'AND', conditions: [] },
  statusFilter: [],
  completionRange: { min: '', max: '', includeEmpty: true },
  ratingRange: { min: '', max: '' }
};

interface Props {
  filterState: FilterState;
  onChange: (newState: FilterState) => void;
  onApply: () => void;
  onClose: () => void;
  availableTags: any[];
  savedFilters: any[];
  onSaveFilter: (name: string, filterData: FilterState) => void;
  onLoadFilter: (filter: any) => void;
  onDeleteFilter: (id: number) => void;
}

const generateId = () => Math.random().toString(36).substr(2, 9);

export function AdvancedFilterModal({ filterState, onChange, onApply, onClose, availableTags, savedFilters, onSaveFilter, onLoadFilter, onDeleteFilter }: Props) {
  const STATUS_OPTIONS = ['Not Started', 'Playing', 'Finished', 'Stopped', 'Infinite'];
  const [filterName, setFilterName] = React.useState('');
  const [showSavedList, setShowSavedList] = React.useState(false);

  const updateTagQuery = (newQuery: TagGroup) => {
    onChange({ ...filterState, tagQuery: newQuery });
  };

  const handleStatusToggle = (status: string) => {
    let newStatuses = [...filterState.statusFilter];
    if (newStatuses.includes(status)) {
      newStatuses = newStatuses.filter(s => s !== status);
    } else {
      newStatuses.push(status);
    }
    onChange({ ...filterState, statusFilter: newStatuses });
  };

  const renderTagGroup = (group: TagGroup, parentPath: (number | string)[] = []) => {
    const isRoot = group.id === 'root';

    const addRule = () => {
      const newGroup = { ...group };
      newGroup.conditions.push({ type: 'rule', id: generateId(), operator: 'includes', tag: '' });
      callUpdateTree(parentPath, newGroup);
    };

    const addSubGroup = () => {
      const newGroup = { ...group };
      newGroup.conditions.push({ type: 'group', id: generateId(), matchLogic: 'AND', conditions: [] });
      callUpdateTree(parentPath, newGroup);
    };

    const callUpdateTree = (path: (number|string)[], updatedNode: TagGroup | null) => {
        // Function to rebuild tree
        const rebuild = (currentNode: TagGroup | TagRule, currentPath: (number|string)[]): any => {
            if (currentPath.length === 0) return updatedNode;
             if (currentNode.type === 'rule') return currentNode;
             
             const targetIdx = currentPath[0];
             const restPath = currentPath.slice(1);
             const nextConditions = [...(currentNode as TagGroup).conditions];
             
             if (updatedNode === null && restPath.length === 0) {
                 nextConditions.splice(targetIdx as number, 1);
             } else {
                 nextConditions[targetIdx as number] = rebuild(nextConditions[targetIdx as number], restPath);
             }
             return { ...currentNode, conditions: nextConditions };
        };
        const newRoot = rebuild(filterState.tagQuery, path) as TagGroup;
        updateTagQuery(newRoot);
    };

    return (
      <div className={`tag-group ${isRoot ? 'root-group' : 'sub-group'}`} key={group.id}>
        <div className="group-header">
           <span>Match</span>
           <select 
             className="logic-select" 
             value={group.matchLogic} 
             onChange={e => callUpdateTree(parentPath, { ...group, matchLogic: e.target.value as any })}
           >
             <option value="AND">ALL</option>
             <option value="OR">ANY</option>
           </select>
           <span>of the following rules:</span>
           {!isRoot && (
              <button className="icon-btn delete" onClick={() => callUpdateTree(parentPath, null)} style={{ marginLeft: 'auto' }}>
                 <Trash2 size={16} />
              </button>
           )}
        </div>

        <div className="group-conditions">
           {group.conditions.map((cond, idx) => {
              const currentPath = [...parentPath, idx];
              if (cond.type === 'group') {
                 return renderTagGroup(cond, currentPath);
              }
              
              const rule = cond as TagRule;
              return (
                 <div className="tag-rule" key={rule.id}>
                    <select 
                       className="rule-op-select"
                       value={rule.operator}
                       onChange={e => callUpdateTree(currentPath, { ...rule, operator: e.target.value as any } as any)}
                    >
                       <option value="includes">INCLUDES</option>
                       <option value="excludes">EXCLUDES</option>
                    </select>
                    
                    <select
                       className="rule-tag-select"
                       value={rule.tag}
                       onChange={e => callUpdateTree(currentPath, { ...rule, tag: e.target.value } as any)}
                    >
                       <option value="" disabled>Select Tag...</option>
                       {availableTags.map(t => (
                          <option key={t.name} value={t.name}>{t.name}</option>
                       ))}
                    </select>

                    <button className="icon-btn delete-rule" onClick={() => callUpdateTree(currentPath, null)}>
                       <X size={16} />
                    </button>
                 </div>
              );
           })}
        </div>

        <div className="group-actions">
           <button className="btn btn-ghost sm" onClick={addRule}><Plus size={14}/> Add Rule</button>
           <button className="btn btn-ghost sm" onClick={addSubGroup}><Plus size={14}/> Add Sub-Group</button>
        </div>
      </div>
    );
  };

  return (
    <div className="modal-overlay">
      <div className="glass-card modal-content filter-modal">
        <div className="modal-header">
           <h2>Advanced Filtering</h2>
           <button className="modal-close" onClick={onClose}><X size={20}/></button>
        </div>

        <div className="filter-sections-layout">
           <div className="filter-main">
               <div className="filter-section">
                 <h3>Visual Tag Query Builder</h3>
                 {renderTagGroup(filterState.tagQuery)}
               </div>

               <div className="filter-row">
                 <div className="filter-section" style={{ flex: 1 }}>
                   <h3>Status (Exclusive)</h3>
                   <div className="status-pills">
                     {STATUS_OPTIONS.map(status => (
                        <button 
                           key={status}
                           className={`status-pill ${filterState.statusFilter.includes(status) ? 'active' : ''}`}
                           onClick={() => handleStatusToggle(status)}
                        >
                           {status}
                        </button>
                     ))}
                   </div>
                 </div>
               </div>

               <div className="filter-row">
                 <div className="filter-section" style={{ flex: 1 }}>
                   <h3>Completion Percentage</h3>
                   <div className="range-inputs">
                      <input type="number" placeholder="Min %" min="0" max="100" className="form-input" 
                         value={filterState.completionRange.min} onChange={e => onChange({...filterState, completionRange: {...filterState.completionRange, min: e.target.value ? Number(e.target.value) : ''}})} />
                      <span>to</span>
                      <input type="number" placeholder="Max %" min="0" max="100" className="form-input" 
                         value={filterState.completionRange.max} onChange={e => onChange({...filterState, completionRange: {...filterState.completionRange, max: e.target.value ? Number(e.target.value) : ''}})} />
                   </div>
                   <label className="checkbox-label" style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                      <input type="checkbox" checked={filterState.completionRange.includeEmpty} onChange={e => onChange({...filterState, completionRange: {...filterState.completionRange, includeEmpty: e.target.checked}})} 
                             style={{ accentColor: 'var(--accent-primary)', width: '16px', height: '16px' }} />
                      Show games with no percentage (or not Stopped/Finished)
                   </label>
                 </div>

                 <div className="filter-section" style={{ flex: 1 }}>
                   <h3>Rating (Mark)</h3>
                   <div className="range-inputs">
                      <input type="number" placeholder="Min (1)" min="1" max="10" className="form-input" 
                         value={filterState.ratingRange.min} onChange={e => onChange({...filterState, ratingRange: {...filterState.ratingRange, min: e.target.value ? Number(e.target.value) : ''}})} />
                      <span>to</span>
                      <input type="number" placeholder="Max (10)" min="1" max="10" className="form-input" 
                         value={filterState.ratingRange.max} onChange={e => onChange({...filterState, ratingRange: {...filterState.ratingRange, max: e.target.value ? Number(e.target.value) : ''}})} />
                   </div>
                 </div>
               </div>
           </div>
        </div>

        <div className="filter-bottom-bar" style={{ marginTop: '2rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border-color)' }}>
             <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                 <h3>Saved Filters</h3>
                 <div className="save-form" style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <input type="text" className="form-input text-sm" placeholder="Filter Name..." value={filterName} onChange={e => setFilterName(e.target.value)} style={{ width: '200px' }} />
                    <button className="btn btn-ghost text-sm" disabled={!filterName.trim()} onClick={() => { onSaveFilter(filterName, filterState); setFilterName(''); }}>
                       <Save size={14} style={{ marginRight: '0.25rem' }}/> Save Current View
                    </button>
                    <button className="btn btn-secondary text-sm" onClick={() => setShowSavedList(!showSavedList)} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <FolderOpen size={16} /> {showSavedList ? 'Hide Saved Filters' : 'Load Saved Filter'}
                    </button>
                 </div>
             </div>

             {showSavedList && (
                 <div className="saved-filters-list horizontal">
                    {savedFilters.length === 0 && <p className="text-muted text-sm">No saved filters yet.</p>}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem' }}>
                        {savedFilters.map(sf => (
                           <div key={sf.id} className="saved-filter-item">
                              <span className="sf-name" onClick={() => onLoadFilter(sf)}>{sf.name}</span>
                              <button className="icon-btn delete" onClick={() => onDeleteFilter(sf.id)}><X size={14}/></button>
                           </div>
                        ))}
                    </div>
                 </div>
             )}
        </div>

        <div className="modal-actions" style={{ marginTop: '2rem', display: 'flex', justifyContent: 'space-between' }}>
           <button className="btn btn-ghost" style={{ color: 'var(--text-muted)' }} onClick={() => onChange(DEFAULT_FILTER_STATE)}>
             Reset Filters
           </button>
           <button className="btn btn-primary" onClick={onApply}>
             Apply Filters
           </button>
        </div>
      </div>
    </div>
  );
}
