export const ACCENTS = [
  { id: 'teal', label: 'Turquoise', color: '#14b8a6' },
  { id: 'violet', label: 'Violet', color: '#5e6ad2' },
  { id: 'amber', label: 'Amber', color: '#f5a524' },
  { id: 'coral', label: 'Coral', color: '#ff6b57' },
  { id: 'rose', label: 'Rose', color: '#f0509a' },
  { id: 'lime', label: 'Lime', color: '#b4e33d' },
] as const;
export type AccentId = typeof ACCENTS[number]['id'];
export const DEFAULT_ACCENT: AccentId = 'teal';
const ACCENT_KEY = 'appearance-accent';

export function savedAccent(): AccentId {
  try {
    const value = localStorage.getItem(ACCENT_KEY);
    return ACCENTS.some(accent => accent.id === value) ? value as AccentId : DEFAULT_ACCENT;
  } catch { return DEFAULT_ACCENT; }
}

/** The stylesheet keys every accent colour off this attribute. */
export function applyAccent(accent: AccentId) {
  if (accent === DEFAULT_ACCENT) delete document.documentElement.dataset.accent;
  else document.documentElement.dataset.accent = accent;
}

export function saveAccent(accent: AccentId) {
  applyAccent(accent);
  try { localStorage.setItem(ACCENT_KEY, accent); } catch { /* private storage */ }
}
