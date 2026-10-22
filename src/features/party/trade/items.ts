import { forgetDrag } from '../inventory.js';

/**
 * System-agnostic item quantities. WFRP4e keeps them in `system.quantity.value`, dnd5e in
 * `system.quantity`; items without either (spells, skills, talents...) aren't tradeable.
 */

export type ItemLike = {
  id: string;
  uuid?: string;
  name: string;
  type: string;
  img: string;
  system?: Record<string, any>;
  toObject(): Record<string, any>;
  update(d: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
};

export type ActorLike = {
  id: string;
  uuid: string;
  name: string;
  img: string;
  isOwner: boolean;
  hasPlayerOwner?: boolean;
  items: { contents: ItemLike[]; get(id: string): ItemLike | undefined };
  testUserPermission(user: unknown, level: string | number): boolean;
  createEmbeddedDocuments(type: 'Item', data: Record<string, unknown>[]): Promise<unknown>;
};

type QuantityShape = 'value' | 'number';

function shapeOf(system: Record<string, any> | undefined): QuantityShape | null {
  const q = system?.quantity;
  if (typeof q === 'number') return 'number';
  if (q && typeof q === 'object' && 'value' in q) return 'value';
  return null;
}

export function isTradeableItem(item: ItemLike): boolean {
  return shapeOf(item.system) !== null;
}

export function quantityOf(item: { system?: Record<string, any> }): number {
  const shape = shapeOf(item.system);
  if (shape === 'number') return Math.max(0, Number(item.system!.quantity) || 0);
  if (shape === 'value') return Math.max(0, Number(item.system!.quantity.value) || 0);
  return 0;
}

function quantityPath(item: { system?: Record<string, any> }): string {
  return shapeOf(item.system) === 'number' ? 'system.quantity' : 'system.quantity.value';
}

/** Coins are items of type `money` (WFRP4e). */
export function isMoney(item: { type: string }): boolean {
  return item.type === 'money';
}

/** Sort coins from the most valuable down. */
export function byCoinValue(a: { system?: Record<string, any> }, b: { system?: Record<string, any> }): number {
  return Number(b.system?.coinValue?.value ?? 0) - Number(a.system?.coinValue?.value ?? 0);
}

/** Per-owner state that means nothing once an item changes hands. */
const OWNER_STATE = ['quantity', 'location', 'equipped', 'worn'];

/**
 * Item data to give someone else: no id, and not inside one of the old owner's containers or
 * equipped by them.
 */
export function copyForNewOwner(item: { toObject(): Record<string, any> }): Record<string, any> {
  const data = item.toObject();
  delete data._id;
  if (data.system?.location && typeof data.system.location === 'object') data.system.location.value = '';
  for (const key of ['equipped', 'worn']) {
    const v = data.system?.[key];
    if (v && typeof v === 'object' && 'value' in v) v.value = false;
    else if (typeof v === 'boolean') data.system[key] = false;
  }
  return data;
}

/**
 * Whether two items are the same goods, so one can stack onto the other: same name and type,
 * and the same data apart from how many there are and who carries them. A sword with different
 * qualities stays a separate sword.
 */
export function sameGoods(a: ItemLike, b: ItemLike): boolean {
  if (a.name !== b.name || a.type !== b.type || a.type === 'container') return false;
  // Coins are coins: some stacks are made with only a value and a count.
  if (isMoney(a)) return Number(a.system?.coinValue?.value) === Number(b.system?.coinValue?.value);
  const strip = (system: Record<string, any> | undefined) => {
    const s = { ...(system ?? {}) };
    for (const key of OWNER_STATE) delete s[key];
    return s;
  };
  const equal = (foundry.utils as unknown as { objectsEqual?(x: unknown, y: unknown): boolean }).objectsEqual;
  const x = strip(a.system);
  const y = strip(b.system);
  return equal ? equal(x, y) : JSON.stringify(x) === JSON.stringify(y);
}

/** Move `qty` of `item` onto `target`: stacked onto the same goods there, or as a new item. */
export async function transferItem(item: ItemLike, qty: number, target: ActorLike): Promise<void> {
  // This removes the item from its source itself; the party-move tracker must not as well.
  forgetDrag();
  const had = quantityOf(item);
  const stack = target.items.contents.find((i) => isTradeableItem(i) && sameGoods(i, item));
  if (stack) {
    await stack.update({ [quantityPath(stack)]: quantityOf(stack) + qty });
  } else {
    const data = copyForNewOwner(item);
    if (shapeOf(data.system) === 'number') data.system.quantity = qty;
    else data.system.quantity.value = qty;
    await target.createEmbeddedDocuments('Item', [data]);
  }
  if (qty < had) await item.update({ [quantityPath(item)]: had - qty });
  else await item.delete();
}
