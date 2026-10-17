import { loc } from '../../core/i18n.js';
import type { WfrpItem } from './wfrp.js';
import type { Settlement } from './trader.js';

/** One row of WFRP4e's `game.wfrp4e.config.availabilityTable`: a d100 target and a stock formula. */
type AvailabilityRow = { test: number; stock: string };

type WfrpConfig = {
  availabilityTable?: Record<string, Record<string, AvailabilityRow>>;
  availability?: Record<string, string>;
};

export type AvailabilityResult = {
  available: boolean;
  /** Units in stock; ignored when `infinite`. */
  qty: number;
  infinite: boolean;
  /** The d100 roll, or null when the item was available without a roll. */
  roll: number | null;
  target: number;
  rarity: string;
};

function wfrpConfig(): WfrpConfig {
  return (game as unknown as { wfrp4e?: { config?: WfrpConfig } }).wfrp4e?.config ?? {};
}

const SETTLEMENT_KEYS: Record<Exclude<Settlement, ''>, string> = {
  village: 'MARKET.Village',
  town: 'MARKET.Town',
  city: 'MARKET.City',
};

export function settlementLabel(settlement: Settlement): string {
  if (!settlement) return loc('kaiserkram.trader.settlement.none', 'None (no Availability tests)');
  const key = SETTLEMENT_KEYS[settlement];
  return loc(key, settlement.charAt(0).toUpperCase() + settlement.slice(1));
}

async function rollTotal(formula: string): Promise<number> {
  const roll = new (foundry.dice as unknown as { Roll: new (f: string) => { evaluate(): Promise<{ total: number }> } })
    .Roll(formula);
  return (await roll.evaluate()).total;
}

/**
 * Roll WFRP4e's Availability test for `item` in a settlement of the given size, using the system's
 * own table (village/town/city × common/scarce/rare/exotic). Items with no rarity count as common;
 * "special" items count as exotic and are never in stock.
 */
export async function rollAvailability(item: WfrpItem, settlement: Exclude<Settlement, ''>): Promise<AvailabilityResult> {
  const config = wfrpConfig();
  const rarityId = String(item.system?.availability?.value ?? '').toLowerCase();
  const normalized = rarityId === 'special' ? 'exotic' : ['common', 'scarce', 'rare', 'exotic'].includes(rarityId) ? rarityId : 'common';
  const rarityKey = config.availability?.[normalized] ?? `WFRP4E.Availability.${normalized[0].toUpperCase()}${normalized.slice(1)}`;
  const rarity = loc(rarityKey, normalized);
  const row = config.availabilityTable?.[SETTLEMENT_KEYS[settlement]]?.[rarityKey];
  if (!row) return { available: true, qty: 1, infinite: false, roll: null, target: 100, rarity };

  const target = Number(row.test) || 0;
  const roll = target >= 100 ? null : await rollTotal('1d100');
  const available = target > 0 && (roll === null || roll <= target);
  if (!available) return { available, qty: 0, infinite: false, roll, target, rarity };

  const stock = String(row.stock ?? '1').trim();
  if (stock === '∞') return { available, qty: 0, infinite: true, roll, target, rarity };
  const qty = /d/i.test(stock) ? await rollTotal(stock) : Number(stock) || 1;
  return { available, qty: Math.max(1, qty), infinite: false, roll, target, rarity };
}
