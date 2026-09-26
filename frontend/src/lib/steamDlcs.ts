export type DlcState = 'not_owned' | 'not_started' | 'playing' | 'finished' | 'stopped';

export interface Dlc {
  name: string;
  state: DlcState;
  steam_appid?: number | null;
  steam_parent_appid?: number | null;
  platform?: string | null;
  source?: string | null;
  playtime_hours?: number | null;
  standalone_game_id?: number | null;
  store_url?: string | null;
  image_url?: string | null;
}

const STATE_RANK: Record<DlcState, number> = {
  not_owned: 0, not_started: 1, stopped: 2, playing: 3, finished: 4,
};

function nameKey(name: string): string {
  return name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let index = 1; index <= left.length; index += 1) {
    let diagonal = previous[0];
    previous[0] = index;
    for (let other = 1; other <= right.length; other += 1) {
      const above = previous[other];
      previous[other] = Math.min(
        previous[other] + 1,
        previous[other - 1] + 1,
        diagonal + (left[index - 1] === right[other - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

function titleScore(leftName: string, rightName: string, parentName = ''): number {
  const left = nameKey(leftName);
  const right = nameKey(rightName);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (Math.min(left.length, right.length) < 10) return 0;
  const parent = nameKey(parentName);
  const pairs: [string, string][] = [[left, right]];
  if (parent) pairs.push([
    left.startsWith(`${parent} `) ? left.slice(parent.length + 1) : left,
    right.startsWith(`${parent} `) ? right.slice(parent.length + 1) : right,
  ]);
  const [shorter, longer] = [left, right].sort((a, b) => a.length - b.length);
  const shortTokens = shorter.split(' ');
  const longTokens = longer.split(' ');
  if (shortTokens.length >= 3 && longTokens.length > shortTokens.length) {
    const prefix = longTokens.slice(0, -shortTokens.length);
    const overlap = prefix.filter(token => parent.split(' ').includes(token)).length;
    if (overlap >= 2) pairs.push([shorter, longTokens.slice(-shortTokens.length).join(' ')]);
  }
  return Math.max(0, ...pairs.map(([a, b]) => {
    const numbers = (value: string) => value.split(' ').filter(token => /^\d+$/.test(token)).join(',');
    if (numbers(a) !== numbers(b)) return 0;
    for (const edition of ['special', 'standard', 'deluxe', 'ultimate', 'soundtrack', 'demo']) {
      if (a.split(' ').includes(edition) !== b.split(' ').includes(edition)) return 0;
    }
    return similarity(a, b);
  }));
}

function manualMatches(rows: Dlc[], catalog: Dlc[], parentName: string): Map<number, Dlc> {
  const choices = new Map<number, { row: Dlc; score: number }[]>();
  for (const row of rows.filter(candidate => !candidate.steam_appid)) {
    const scores = catalog.filter(item => item.steam_appid)
      .map(item => ({ appid: item.steam_appid!, score: titleScore(row.name, item.name, parentName) }))
      .sort((a, b) => b.score - a.score);
    if (!scores.length || scores[0].score < 0.94) continue;
    if (scores[1] && scores[1].score > scores[0].score - 0.03) continue;
    const candidates = choices.get(scores[0].appid) || [];
    candidates.push({ row, score: scores[0].score });
    choices.set(scores[0].appid, candidates);
  }
  const matches = new Map<number, Dlc>();
  for (const [appid, candidates] of choices) {
    candidates.sort((a, b) => b.score - a.score);
    if (!candidates[1] || candidates[1].score <= candidates[0].score - 0.03) {
      matches.set(appid, candidates[0].row);
    }
  }
  return matches;
}

export function mergeSteamDlcs(existing: Dlc[], catalog: Dlc[], parentName = ''): { dlcs: Dlc[]; added: number; updated: number } {
  const dlcs = existing.map(item => ({ ...item }));
  const matches = manualMatches(dlcs, catalog, parentName);
  let added = 0;
  let updated = 0;
  for (const item of catalog) {
    const linkedRows = dlcs.filter(row => row.steam_appid && row.steam_appid === item.steam_appid);
    const linked = linkedRows[0];
    for (const duplicate of linkedRows.slice(1)) {
      if (STATE_RANK[duplicate.state] > STATE_RANK[linked.state]) linked.state = duplicate.state;
      dlcs.splice(dlcs.indexOf(duplicate), 1);
      updated += 1;
    }
    const manual = matches.get(item.steam_appid || 0);
    if (linked && manual) {
      if (STATE_RANK[manual.state] > STATE_RANK[linked.state]) linked.state = manual.state;
      dlcs.splice(dlcs.indexOf(manual), 1);
      updated += 1;
    }
    const row = linked || manual;
    if (row) {
      const before = JSON.stringify(row);
      if (manual && !linked) updated += 1;
      row.steam_appid = item.steam_appid;
      row.steam_parent_appid = item.steam_parent_appid;
      if (row.source !== 'Steam') row.source = 'Steam catalog';
      row.store_url ||= item.store_url;
      row.image_url ||= item.image_url;
      if (!manual && JSON.stringify(row) !== before) updated += 1;
    } else {
      dlcs.push({ ...item, state: 'not_owned' });
      added += 1;
    }
  }
  return { dlcs, added, updated };
}

export function addManualDlc(existing: Dlc[], name: string, parentName = '', source = 'Manual'): { dlcs: Dlc[]; linked: boolean } {
  const trimmed = name.trim();
  if (!trimmed) return { dlcs: existing, linked: false };
  const steamRows = existing.filter(row => row.steam_appid);
  const best = steamRows.map(row => ({ row, score: titleScore(trimmed, row.name, parentName) }))
    .sort((a, b) => b.score - a.score);
  if (best[0]?.score >= 0.94 && (!best[1] || best[1].score <= best[0].score - 0.03)) {
    return { dlcs: existing, linked: true };
  }
  if (existing.some(row => nameKey(row.name) === nameKey(trimmed))) return { dlcs: existing, linked: false };
  return { dlcs: [...existing, { name: trimmed, state: 'not_owned', source }], linked: false };
}
