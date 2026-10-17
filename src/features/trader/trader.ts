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
  /** Markup % on everything this trader sells to them, from failed haggles. */
  penalty: number;
  /** Item id → discount % won by haggling, used up on the next purchase of that item. */
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
    penalty: Number(s?.penalty) || 0,
    deals: { ...(s?.deals ?? {}) },
    tried: [...(s?.tried ?? [])],
  };
}

/** Replaces the whole haggle flag (setFlag would merge, and keep deals we meant to drop). */
export async function saveHaggleState(trader: WfrpActor, state: HaggleState): Promise<void> {
  await trader.unsetFlag(MODULE_ID, FLAGS.HAGGLE);
  if (Object.keys(state).length) await trader.setFlag(MODULE_ID, FLAGS.HAGGLE, state);
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
  penalty: number;
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

/** Per-unit price for `buyerId`, after their haggled deal on this item and any grudge the trader holds. */
export function buyQuote(trader: WfrpActor, item: WfrpItem, buyerId: string | null, state?: HaggleState): BuyQuote {
  const list = listPriceBP(trader, item);
  if (!buyerId) return { list, unit: list, deal: 0, penalty: 0 };
  const standing = standingOf(state ?? haggleState(trader), buyerId);
  const deal = Math.max(0, Number(standing.deals[item.id]) || 0);
  const penalty = Math.max(0, standing.penalty);
  const unit = roundPrice(list * (1 - deal / 100) * (1 + penalty / 100), list);
  return { list, unit, deal, penalty };
}

/** Per-unit price the trader pays `sellerId` for `item`; a grudge lowers that offer, too. */
export function sellQuote(trader: WfrpActor, item: WfrpItem, sellerId: string | null): number {
  const book = bookPriceBP(item);
  const penalty = sellerId ? standingOf(haggleState(trader), sellerId).penalty : 0;
  const rate = traderConfig(trader).sellRate / 100;
  return Math.max(0, Math.floor((book * rate) / (1 + penalty / 100)));
}
