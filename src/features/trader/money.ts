import { loc } from '../../core/i18n.js';
import { COIN } from './constants.js';
import { g, type WfrpActor, type WfrpItem } from './wfrp.js';

/** A purse is a list of coin stacks; `id` is null for a denomination the actor doesn't have an item for yet. */
export type CoinStack = { id: string | null; value: number; qty: number };

const STANDARD = [COIN.GC, COIN.SS, COIN.BP];

/** Total of a WFRP4e price object ({gc, ss, bp}) in brass pennies. */
export function priceToBP(price: { gc?: unknown; ss?: unknown; bp?: unknown } | null | undefined): number {
  if (!price) return 0;
  return (Number(price.gc) || 0) * COIN.GC + (Number(price.ss) || 0) * COIN.SS + (Number(price.bp) || 0);
}

export function bpToPrice(bp: number): { gc: number; ss: number; bp: number } {
  const total = Math.max(0, Math.round(bp));
  return {
    gc: Math.floor(total / COIN.GC),
    ss: Math.floor((total % COIN.GC) / COIN.SS),
    bp: total % COIN.SS,
  };
}

/** "2 GC 3 SS 4 BP", omitting zero denominations; "0 BP" for nothing. */
export function formatBP(bp: number): string {
  const p = bpToPrice(bp);
  const parts: string[] = [];
  if (p.gc) parts.push(`${p.gc} ${loc('kaiserkram.trader.coin.gc', 'GC')}`);
  if (p.ss) parts.push(`${p.ss} ${loc('kaiserkram.trader.coin.ss', 'SS')}`);
  if (p.bp || !parts.length) parts.push(`${p.bp} ${loc('kaiserkram.trader.coin.bp', 'BP')}`);
  return parts.join(' ');
}

/**
 * Parse a typed price such as "1 gc 5 ss", "3s 6b" or "1/5/0" (GC/SS/BP) into brass pennies.
 * A bare number counts as brass pennies. Blank input returns null.
 */
export function parsePrice(text: string): number | null {
  const s = text.trim().toLowerCase();
  if (!s) return null;
  const slash = s.match(/^(\d+)\s*\/\s*(\d+)\s*(?:\/\s*(\d+))?$/);
  if (slash) return priceToBP({ gc: slash[1], ss: slash[2], bp: slash[3] ?? 0 });
  if (/^\d+$/.test(s)) return Number(s);
  const units: Record<string, number> = { g: COIN.GC, s: COIN.SS, b: COIN.BP };
  const re = /(\d+(?:\.\d+)?)\s*([a-z\u00c0-\u024f]+)/g;
  let total = 0;
  let matched = false;
  for (const m of s.matchAll(re)) {
    const unit = units[m[2][0]];
    if (!unit) return null;
    total += Number(m[1]) * unit;
    matched = true;
  }
  return matched ? Math.round(total) : null;
}

export function moneyItems(actor: WfrpActor): WfrpItem[] {
  return actor.items.contents.filter((i) => i.type === 'money' && Number(i.system?.coinValue?.value) > 0);
}

export function purseOf(actor: WfrpActor): CoinStack[] {
  return moneyItems(actor).map((i) => ({
    id: i.id,
    value: Number(i.system.coinValue.value),
    qty: Math.max(0, Number(i.system.quantity?.value) || 0),
  }));
}

export function purseTotal(purse: CoinStack[]): number {
  return purse.reduce((sum, c) => sum + c.value * c.qty, 0);
}

function clonePurse(purse: CoinStack[]): CoinStack[] {
  return purse.map((c) => ({ ...c }));
}

function stackFor(purse: CoinStack[], value: number): CoinStack {
  let stack = purse.find((c) => c.value === value);
  if (!stack) {
    stack = { id: null, value, qty: 0 };
    purse.push(stack);
  }
  return stack;
}

/** Add `amount` to the purse as the fewest standard coins (GC, then SS, then BP). */
export function planCredit(purse: CoinStack[], amount: number): CoinStack[] {
  const next = clonePurse(purse);
  let rest = Math.max(0, Math.round(amount));
  for (const value of STANDARD) {
    const n = Math.floor(rest / value);
    if (n > 0) {
      stackFor(next, value).qty += n;
      rest -= n * value;
    }
  }
  return next;
}

/**
 * Take `amount` out of the purse, spending small coins first so a player's gold stays put
 * where possible. When the small coins don't cover it, one larger coin is broken and the
 * change comes back as standard coins. Returns null if the purse can't cover the amount.
 */
export function planPayment(purse: CoinStack[], amount: number): CoinStack[] | null {
  const cost = Math.max(0, Math.round(amount));
  if (purseTotal(purse) < cost) return null;

  const next = clonePurse(purse);
  const ascending = [...next].sort((a, b) => a.value - b.value);
  let rest = cost;
  for (const stack of ascending) {
    const use = Math.min(stack.qty, Math.floor(rest / stack.value));
    stack.qty -= use;
    rest -= use * stack.value;
  }
  if (rest > 0) {
    // Every remaining coin is now worth more than `rest`; break the smallest one.
    const breakable = ascending.find((s) => s.qty > 0);
    if (!breakable) return null;
    breakable.qty -= 1;
    return planCredit(next, breakable.value - rest);
  }
  return next;
}

/** Write a planned purse back to the actor, creating coin items for denominations it lacked. */
export async function applyPurse(actor: WfrpActor, before: CoinStack[], after: CoinStack[]): Promise<void> {
  const updates: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];
  for (const stack of after) {
    if (stack.id) {
      const prev = before.find((b) => b.id === stack.id);
      if (!prev || prev.qty !== stack.qty) updates.push({ _id: stack.id, 'system.quantity.value': stack.qty });
    } else if (stack.qty > 0) {
      creates.push(await coinItemData(stack.value, stack.qty));
    }
  }
  if (updates.length) await actor.updateEmbeddedDocuments('Item', updates);
  if (creates.length) await actor.createEmbeddedDocuments('Item', creates);
}

const COIN_NAME_KEYS: Record<number, [string, string]> = {
  [COIN.GC]: ['NAME.GC', 'Gold Crown'],
  [COIN.SS]: ['NAME.SS', 'Silver Shilling'],
  [COIN.BP]: ['NAME.BP', 'Brass Penny'],
};

/** Coin item data, copied from the system's Basic Items compendium when it's available. */
async function coinItemData(value: number, qty: number): Promise<Record<string, unknown>> {
  try {
    const pack = g().packs.get('wfrp4e.basic');
    const coins = pack ? await pack.getDocuments({ type: 'money' }) : [];
    const match = coins.find((c) => Number(c.system?.coinValue?.value) === value);
    if (match) {
      const data = match.toObject();
      delete data._id;
      data.system.quantity = { value: qty };
      return data;
    }
  } catch (err) {
    console.warn('[kaiserkram] trader: Could not read coin items from wfrp4e.basic', err);
  }
  const [key, fallback] = COIN_NAME_KEYS[value] ?? ['', `${value} BP coin`];
  return {
    name: key ? loc(key, fallback) : fallback,
    type: 'money',
    system: { coinValue: { value }, quantity: { value: qty } },
  };
}
