import { ChevronFirst, ChevronLast, ChevronLeft, ChevronRight } from 'lucide-react';
import type { PageSize } from '../lib/pagination';
import './PaginationControls.css';

interface PaginationControlsProps {
  page: number;
  pageSize: PageSize;
  pageSizeOptions: number[];
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (pageSize: PageSize) => void;
}

export function PaginationControls({ page, pageSize, pageSizeOptions, totalItems, onPageChange, onPageSizeChange }: PaginationControlsProps) {
  if (totalItems === 0) return null;
  const totalPages = pageSize === 'infinite' ? 1 : Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = pageSize === 'infinite' ? 1 : (safePage - 1) * pageSize + 1;
  const end = pageSize === 'infinite' ? totalItems : Math.min(safePage * pageSize, totalItems);

  return <nav className="pagination-controls" aria-label="Collection pages">
    <div className="pagination-summary">Showing <strong>{start}–{end}</strong> of <strong>{totalItems}</strong></div>
    <label className="pagination-size">Per page<select value={pageSize} onChange={event => onPageSizeChange(event.target.value === 'infinite' ? 'infinite' : Number(event.target.value))}>{pageSizeOptions.map(size => <option key={size} value={size}>{size}</option>)}<option value="infinite">Infinite</option></select></label>
    {pageSize !== 'infinite' && totalPages > 1 && <div className="pagination-pages">
      <button type="button" onClick={() => onPageChange(1)} disabled={safePage === 1} aria-label="First page"><ChevronFirst size={17} /></button>
      <button type="button" onClick={() => onPageChange(safePage - 1)} disabled={safePage === 1} aria-label="Previous page"><ChevronLeft size={17} /></button>
      <span>Page <strong>{safePage}</strong> of {totalPages}</span>
      <button type="button" onClick={() => onPageChange(safePage + 1)} disabled={safePage === totalPages} aria-label="Next page"><ChevronRight size={17} /></button>
      <button type="button" onClick={() => onPageChange(totalPages)} disabled={safePage === totalPages} aria-label="Last page"><ChevronLast size={17} /></button>
    </div>}
  </nav>;
}
