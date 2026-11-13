// Reads the Steam "Purchase history" page (store.steampowered.com/account/history)
// and proposes a price for each Steam copy in the collection. Steam has no API for
// purchases, so the user supplies the page as copied HTML or a saved file.
// Self-contained on purpose: the tests load this file on its own.

export interface SteamTransaction {
  date: string;
  items: string[];
  type: string;
  total: number;
  currency: string;
}

export interface PurchaseHistory {
  purchases: SteamTransaction[];
  /** Rows that are not game purchases: gifts, market, in-game, wallet conversions… */
  skipped: number;
  refunded: number;
}

export interface PurchaseCopy {
  id?: string;
  name?: string | null;
  source?: string | null;
  steam_appid?: number | null;
  price?: number | null;
  currency?: string;
}

export interface PurchaseGame {
  id: number;
  name: string;
  copies?: string | null;
}

export interface PriceProposal {
  gameId: number;
  gameName: string;
  copyId: string;
  copyName: string;
  price: number;
  currency: string;
  date: string;
  /** How many items shared the transaction total (1 = exact price). */
  sharedWith: number;
  /** Several purchases matched this copy and were added together. */
  purchases: number;
  currentPrice: number | null;
  currentCurrency: string;
}

export interface UnmatchedPurchase {
  name: string;
  date: string;
  price: number;
  currency: string;
  sharedWith: number;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€', pound: '£', yen: '¥', trade: '™', reg: '®', copy: '©' };

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === '#') {
      const point = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

/** The visible lines of an HTML cell, one per block element. */
function cellLines(html: string): string[] {
  const text = html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(div|p|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text).split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

const CURRENCIES: [RegExp, string][] = [
  [/€|EUR/i, 'EUR'], [/£|GBP/i, 'GBP'], [/¥|JPY|円/i, 'JPY'], [/zł|PLN/i, 'PLN'], [/CHF/i, 'CHF'],
  [/R\$|BRL/i, 'BRL'], [/CDN\$|C\$|CAD/i, 'CAD'], [/A\$|AUD/i, 'AUD'], [/\$|USD/i, 'USD'],
];

/** Parses "12,99€", "$1,234.56", "5,--€" or "¥ 1,200". */
export function parseMoney(text: string): { amount: number; currency: string } | null {
  const value = text.replace(/\s+/g, ' ').trim();
  const match = value.match(/\d[\d.,\s]*(?:[.,]-{1,2})?/);
  if (!match) return null;
  const currency = CURRENCIES.find(([pattern]) => pattern.test(value))?.[1] ?? 'EUR';
  let digits = match[0].replace(/\s/g, '').replace(/[.,]-{1,2}$/, '');
  // A final separator followed by one or two digits is the decimal mark; any other is a thousands mark.
  const decimal = digits.match(/[.,](\d{1,2})$/);
  let fraction = '';
  if (decimal) {
    fraction = decimal[1];
    digits = digits.slice(0, -decimal[0].length);
  }
  const amount = Number(`${digits.replace(/[.,]/g, '') || '0'}.${fraction || '0'}`);
  return Number.isFinite(amount) ? { amount, currency } : null;
}

type RowKind = 'purchase' | 'refund' | 'other';

function rowKind(type: string): RowKind {
  const value = type.toLowerCase();
  if (/refund|reembolso|devoluci/.test(value)) return 'refund';
  if (/gift|regalo|market|mercado|in-game|juego|conversion|conversi/.test(value)) return 'other';
  return /^(purchase|compra)\b/.test(value) ? 'purchase' : 'other';
}

/** Title identity that ignores case, accents, punctuation and trademark marks. */
export function purchaseKey(title: string): string {
  return title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\((tm|r|c)\)|[™®©]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Extracts game purchases from the purchase-history table. Columns are read by
 * position (date, items, type, total) so the copied HTML works with or without
 * Steam's class names. Rows are expected newest first, as Steam lists them.
 */
export function parseSteamPurchaseHistory(html: string): PurchaseHistory {
  const result: PurchaseHistory = { purchases: [], skipped: 0, refunded: 0 };
  const refunds: SteamTransaction[] = [];
  const order: { kind: RowKind; transaction: SteamTransaction }[] = [];
  for (const row of html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...row.matchAll(/<td\b([^>]*)>([\s\S]*?)<\/td>/gi)];
    if (cells.length < 4) continue;
    const date = cellLines(cells[0][2])[0] ?? '';
    // Payment notes inside the items cell ("wth_payment") are not products.
    const items = cellLines(cells[1][2].replace(/<div[^>]*wth_payment[^>]*>[\s\S]*?<\/div>/gi, ''));
    const type = cellLines(cells[2][2])[0] ?? '';
    const money = parseMoney(cellLines(cells[3][2])[0] ?? '');
    if (!date || !items.length || !type) continue;
    const kind = rowKind(type);
    if (kind === 'other' || !money) { result.skipped += 1; continue; }
    const transaction = { date, items, type, total: money.amount, currency: money.currency };
    // Steam strikes through the total of a purchase that was refunded in full.
    if (kind === 'purchase' && /refunded/i.test(cells[3][1] + cells[3][2])) { result.refunded += 1; continue; }
    order.push({ kind, transaction });
    if (kind === 'refund') refunds.push(transaction);
  }
  const purchases = order.map((entry, index) => ({ ...entry, index })).filter(entry => entry.kind === 'purchase');
  for (const refund of refunds) {
    const refundIndex = order.findIndex(entry => entry.transaction === refund);
    const keys = refund.items.map(purchaseKey);
    // The refunded purchase is the closest older row that contains every refunded item.
    const target = purchases.find(entry => entry.index > refundIndex
      && keys.every(key => entry.transaction.items.some(item => purchaseKey(item) === key)));
    result.refunded += 1;
    if (!target) continue;
    const purchase = target.transaction;
    purchase.items = purchase.items.filter(item => !keys.includes(purchaseKey(item)));
    purchase.total = round2(Math.max(0, purchase.total - refund.total));
  }
  result.purchases = purchases.map(entry => entry.transaction).filter(purchase => purchase.items.length > 0);
  return result;
}

function readCopies(value: string | null | undefined): PurchaseCopy[] {
  if (!value) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/**
 * Pairs purchased items with Steam copies by title. A transaction with several
 * items only has one total, so it is shared equally and flagged for review.
 */
export function matchPurchasesToCopies(
  purchases: SteamTransaction[], games: PurchaseGame[],
): { proposals: PriceProposal[]; unmatched: UnmatchedPurchase[] } {
  const targets = new Map<string, { game: PurchaseGame; copy: PurchaseCopy }>();
  for (const game of games) {
    const steamCopies = readCopies(game.copies).filter(copy => copy.id && (copy.steam_appid || copy.source?.toLowerCase() === 'steam'));
    for (const copy of steamCopies) {
      const key = purchaseKey(copy.name || game.name);
      if (key && !targets.has(key)) targets.set(key, { game, copy });
    }
    // The card title is a fallback for a game with a single Steam copy named differently.
    const gameKey = purchaseKey(game.name);
    if (steamCopies.length === 1 && gameKey && !targets.has(gameKey)) targets.set(gameKey, { game, copy: steamCopies[0] });
  }
  const proposals = new Map<string, PriceProposal>();
  const unmatched: UnmatchedPurchase[] = [];
  for (const purchase of purchases) {
    const share = round2(purchase.total / purchase.items.length);
    for (const item of purchase.items) {
      const target = targets.get(purchaseKey(item));
      if (!target) {
        unmatched.push({ name: item, date: purchase.date, price: share, currency: purchase.currency, sharedWith: purchase.items.length });
        continue;
      }
      const id = `${target.game.id}:${target.copy.id}`;
      const existing = proposals.get(id);
      if (existing) {
        existing.price = round2(existing.price + share);
        existing.purchases += 1;
        existing.sharedWith = Math.max(existing.sharedWith, purchase.items.length);
        continue;
      }
      proposals.set(id, {
        gameId: target.game.id, gameName: target.game.name, copyId: target.copy.id!,
        copyName: target.copy.name || target.game.name, price: share, currency: purchase.currency,
        date: purchase.date, sharedWith: purchase.items.length, purchases: 1,
        currentPrice: target.copy.price ?? null, currentCurrency: target.copy.currency || 'EUR',
      });
    }
  }
  return {
    proposals: [...proposals.values()].sort((a, b) => a.gameName.localeCompare(b.gameName)),
    unmatched,
  };
}
