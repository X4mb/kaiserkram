import { MODULE_ID } from '../../core/constants.js';
import { FLAGS, SHEET_CLASS } from './constants.js';
import type { WfrpActor, WfrpItem } from './wfrp.js';
import { priceToBP } from './money.js';
import { getNumber, SETTINGS } from './settings.js';

/** Per-trader settings, stored in flags.kaiserkram.trader.config. */
export type TraderConfig = {
  /** % of book price the trader charges. */
  markup: number;
  /** % of book price the trader pays when buying from players. */
  sellRate: number;
  /** Whether the trader buys from players at all. */
  buysFromPlayers: boolean;
  /** Whether players can browse and buy (also controls default ownership). */
  open: boolean;
};

/** One player character's standing with a trader, stored in flags.kaiserkram.trader.haggle.<actorId>. */
export type HaggleStanding = {
  /** Item id → discount % won by haggling, good for one unit of the next purchase of that item. */
  deals: Record<string, number>;
  /** Item ids already haggled over (blocks repeat attempts unless the setting allows them). */
  tried: string[];
};

export type HaggleState = Record<string, HaggleStanding>;

export function isTrader(actor: WfrpActor | null | undefined): boolean {
  if (!actor) return false;
  return Boolean(actor.getFlag(MODULE_ID, FLAGS.IS_TRADER)) || actor.flags?.core?.sheetClass === SHEET_CLASS;
}

export function traderConfig(actor: WfrpActor): TraderConfig {
  const stored = (actor.getFlag(MODULE_ID, FLAGS.CONFIG) ?? {}) as Partial<TraderConfig>;
  return {
    markup: Number.isFinite(stored.markup) ? Number(stored.markup) : getNumber(SETTINGS.DEFAULT_MARKUP),
    sellRate: Number.isFinite(stored.sellRate) ? Number(stored.sellRate) : getNumber(SETTINGS.DEFAULT_SELL_RATE),
    buysFromPlayers: stored.buysFromPlayers ?? true,
    open: stored.open ?? false,
  };
}

export function haggleState(trader: WfrpActor): HaggleState {
  return foundry.utils.deepClone((trader.getFlag(MODULE_ID, FLAGS.HAGGLE) ?? {}) as HaggleState);
}

export function standingOf(state: HaggleState, actorId: string): HaggleStanding {
  const s = state[actorId];
  return {
    deals: { ...(s?.deals ?? {}) },
    tried: [...(s?.tried ?? [])],
  };
}

/**
 * Store `state` as the whole haggle flag, in one update. A plain setFlag would merge, and keep
 * deals and customers we meant to drop, so those are deleted explicitly (`-=key`).
 */
export async function saveHaggleState(trader: WfrpActor, state: HaggleState): Promise<void> {
  const old = haggleState(trader);
  const patch: Record<string, unknown> = {};
  for (const id of Object.keys(old)) if (!(id in state)) patch[`-=${id}`] = null;
  for (const [id, standing] of Object.entries(state)) {
    const deals: Record<string, unknown> = { ...standing.deals };
    for (const itemId of Object.keys(old[id]?.deals ?? {})) if (!(itemId in standing.deals)) deals[`-=${itemId}`] = null;
    // Arrays are replaced whole by an update.
    patch[id] = { deals, tried: [...standing.tried] };
  }
  if (Object.keys(patch).length) await trader.update({ [`flags.${MODULE_ID}.${FLAGS.HAGGLE}`]: patch });
}

/** Forget deals and tries on an item the trader no longer has. */
export async function forgetItemInHaggles(trader: WfrpActor, itemId: string): Promise<void> {
  const state = haggleState(trader);
  let changed = false;
  for (const standing of Object.values(state)) {
    if (itemId in (standing.deals ?? {})) {
      delete standing.deals[itemId];
      changed = true;
    }
    if (standing.tried?.includes(itemId)) {
      standing.tried = standing.tried.filter((id) => id !== itemId);
      changed = true;
    }
  }
  if (changed) await saveHaggleState(trader, state);
}

/** Whether an item is a physical good that can change hands (money and abilities are not). */
export function isTradeable(item: WfrpItem): boolean {
  if (item.type === 'money') return false;
  return item.system?.price !== undefined && item.system?.quantity !== undefined;
}

export function isInfinite(item: WfrpItem): boolean {
  return Boolean(item.getFlag(MODULE_ID, FLAGS.INFINITE));
}

export function isForSale(item: WfrpItem): boolean {
  return isTradeable(item) && !item.getFlag(MODULE_ID, FLAGS.NOT_FOR_SALE);
}

export function stockQuantity(item: WfrpItem): number {
  return Math.max(0, Number(item.system?.quantity?.value) || 0);
}

/** Items the trader offers; sold-out items stay listed for the GM but not for players. */
export function stockOf(trader: WfrpActor, { includeSoldOut = false } = {}): WfrpItem[] {
  return trader.items.contents.filter(
    (i) => isForSale(i) && (includeSoldOut || isInfinite(i) || stockQuantity(i) > 0),
  );
}

export function bookPriceBP(item: WfrpItem): number {
  return priceToBP(item.system?.price);
}

/** GM-set fixed price in BP, or null when the trader's markup applies. */
export function priceOverrideBP(item: WfrpItem): number | null {
  const v = item.getFlag(MODULE_ID, FLAGS.PRICE_OVERRIDE);
  return v === null || v === undefined || v === '' ? null : Math.max(0, Number(v) || 0);
}

export type BuyQuote = {
  /** Trader's asking price before any haggling. */
  list: number;
  /** What this buyer pays per unit. */
  unit: number;
  deal: number;
};

function roundPrice(bp: number, base: number): number {
  // Never round something that costs money down to free.
  const rounded = Math.round(bp);
  return base > 0 ? Math.max(1, rounded) : Math.max(0, rounded);
}

export function listPriceBP(trader: WfrpActor, item: WfrpItem): number {
  const override = priceOverrideBP(item);
  if (override !== null) return override;
  const book = bookPriceBP(item);
  return roundPrice((book * traderConfig(trader).markup) / 100, book);
}

/** Price for `buyerId`: `unit` is the first unit's, after any deal they haggled for this item. */
export function buyQuote(trader: WfrpActor, item: WfrpItem, buyerId: string | null, state?: HaggleState): BuyQuote {
  const list = listPriceBP(trader, item);
  if (!buyerId) return { list, unit: list, deal: 0 };
  const standing = standingOf(state ?? haggleState(trader), buyerId);
  const deal = Math.max(0, Number(standing.deals[item.id]) || 0);
  return { list, unit: roundPrice(list * (1 - deal / 100), list), deal };
}

/** What `qty` cost: a haggled deal is good for one of them, the rest are at the asking price. */
export function totalFor(quote: BuyQuote, qty: number): number {
  return qty <= 0 ? 0 : quote.unit + quote.list * (qty - 1);
}

/** Book prices of the items that player items were made from, looked up once each. */
const sourcePrices = new Map<string, Promise<number | null>>();

/** The book price of what `item` was copied from (a compendium or world item), if known. */
function sourceBookBP(item: WfrpItem): Promise<number | null> {
  const uuid = item._stats?.compendiumSource ?? item.flags?.core?.sourceId;
  if (typeof uuid !== 'string' || !uuid) return Promise.resolve(null);
  let price = sourcePrices.get(uuid);
  if (!price) {
    const lookup = (globalThis as unknown as { fromUuid(u: string): Promise<WfrpItem | null> }).fromUuid;
    price = lookup(uuid)
      .then((source) => (source?.system?.price !== undefined ? bookPriceBP(source) : null))
      .catch(() => null);
    sourcePrices.set(uuid, price);
  }
  return price;
}

/**
 * Per-unit price the trader pays for `item`. A player can edit the price on their own copy, so
 * the trader goes by the lowest of that, the price of what it was copied from, and the price of
 * the same goods in its own stock.
 */
export async function sellQuote(trader: WfrpActor, item: WfrpItem): Promise<number> {
  const prices = [bookPriceBP(item)];
  const source = await sourceBookBP(item);
  if (source !== null) prices.push(source);
  const stocked = trader.items.contents.find((i) => isTradeable(i) && sameGoodsIgnoringPrice(i, item));
  if (stocked) prices.push(bookPriceBP(stocked));
  const rate = traderConfig(trader).sellRate / 100;
  return Math.max(0, Math.floor(Math.min(...prices) * rate));
}

/** The same goods as far as a buyer can tell: name and type (the price is what's in question). */
function sameGoodsIgnoringPrice(a: WfrpItem, b: WfrpItem): boolean {
  return a.name === b.name && a.type === b.type;
}
