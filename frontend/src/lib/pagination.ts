export type PageSize = number | 'infinite';

export function parseStoredPageSize(value: string | null, fallback = 20): PageSize {
  if (value === 'infinite') return 'infinite';
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
