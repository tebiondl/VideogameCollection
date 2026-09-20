export const COPY_FORMATS = ['Any', 'Physical', 'Digital'] as const;

type PlatformFamily = 'switch' | 'playstation' | 'xbox' | 'pc' | 'steam_deck' | 'unknown';
type SourceKind = 'steam' | 'nintendo_store' | 'playstation_store' | 'xbox_store' | 'retail' | 'subscription' | 'gift' | 'other' | 'custom';

const normalize = (value: string | null | undefined) => value?.trim().toLocaleLowerCase() || '';

export const sameCopyValue = (left: string | null | undefined, right: string | null | undefined) => normalize(left) === normalize(right);
export const isSteamSource = (source: string | null | undefined) => sourceKind(source) === 'steam';

function platformFamily(platform: string | null | undefined): PlatformFamily {
  const value = normalize(platform);
  if (value.includes('steam deck')) return 'steam_deck';
  if (/\bswitch\b/.test(value)) return 'switch';
  if (value.includes('playstation') || /^ps\s*[1-6]\b/.test(value)) return 'playstation';
  if (value.includes('xbox')) return 'xbox';
  if (value === 'pc' || value.includes('windows') || value.includes('computer')) return 'pc';
  return 'unknown';
}

function sourceKind(source: string | null | undefined): SourceKind {
  const value = normalize(source);
  if (value === 'steam') return 'steam';
  if (value.includes('nintendo eshop') || value === 'eshop') return 'nintendo_store';
  if (value.includes('playstation store') || value === 'ps store') return 'playstation_store';
  if (value.includes('xbox store') || value.includes('microsoft store')) return 'xbox_store';
  if (value === 'retail') return 'retail';
  if (value === 'subscription' || value.includes('game pass') || value.includes('ps plus') || value.includes('playstation plus')) return 'subscription';
  if (value === 'gift') return 'gift';
  if (value === 'other') return 'other';
  return 'custom';
}

const allowedSources: Record<Exclude<PlatformFamily, 'unknown'>, Set<SourceKind>> = {
  switch: new Set(['retail', 'nintendo_store', 'other']),
  playstation: new Set(['retail', 'playstation_store', 'subscription', 'gift', 'other']),
  xbox: new Set(['retail', 'xbox_store', 'subscription', 'gift', 'other']),
  pc: new Set(['steam', 'xbox_store', 'retail', 'subscription', 'gift', 'other', 'custom']),
  steam_deck: new Set(['steam', 'subscription', 'gift', 'other', 'custom']),
};

function unique(values: string[]) {
  const seen = new Set<string>();
  return values.filter(value => {
    const key = normalize(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function compatibleCopySources(platform: string | null | undefined, sources: string[]) {
  const family = platformFamily(platform);
  const values = unique(sources);
  if (family === 'unknown') return values;
  return values.filter(source => allowedSources[family].has(sourceKind(source)));
}

export function isCopySourceCompatible(platform: string | null | undefined, source: string | null | undefined) {
  if (!source) return true;
  return compatibleCopySources(platform, [source]).length === 1;
}

export function compatibleCopyFormats(platform: string | null | undefined, source: string | null | undefined): string[] {
  if (platformFamily(platform) === 'steam_deck') return ['Digital'];
  const kind = sourceKind(source);
  if (kind === 'steam' || kind === 'nintendo_store' || kind === 'playstation_store' || kind === 'xbox_store' || kind === 'subscription') return ['Digital'];
  if (kind === 'retail') return ['Physical'];
  return [...COPY_FORMATS];
}

export function compatibleCopyFormat(platform: string | null | undefined, source: string | null | undefined, current: string | null | undefined) {
  const formats = compatibleCopyFormats(platform, source);
  return formats.find(format => sameCopyValue(format, current)) || formats[0];
}

export function preferredCopySource(platform: string | null | undefined, sources: string[], excludeSteam = false) {
  const compatible = compatibleCopySources(platform, sources).filter(source => !excludeSteam || !isSteamSource(source));
  return compatible.find(source => sourceKind(source) === 'retail')
    || compatible.find(source => sourceKind(source) === 'other')
    || compatible[0]
    || '';
}
