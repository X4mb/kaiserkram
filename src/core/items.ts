import { MODULE_ID } from './constants.js';

/**
 * Item helpers shared by features that move items between actors (the party's trades and stash,
 * the trader's shop, the drag tracker). System-agnostic apart from WFRP4e's coins and containers.
 */

/**
 * Create option on items the module makes itself while moving them (trades, gifts, the stash,
 * the shop, container contents), so the party's drag tracker doesn't take them off a source again.
 */
export const OWN_CREATE = 'kaiserkramPartyItem';

type GoodsLike = { name: string; type: string; system?: Record<string, any>; _source?: { system?: Record<string, any> } };

/** Coins are items of type `money` (WFRP4e). */
export function isMoney(item: { type: string }): boolean {
  return item.type === 'money';
}

/** Per-owner state that means nothing once an item changes hands. */
const OWNER_STATE = ['quantity', 'location', 'equipped', 'worn'];

/**
 * Whether two items are the same goods, so one can stack onto the other: same name and type,
 * and the same data apart from how many there are and who carries them. A sword with different
 * qualities stays a separate sword.
 */
export function sameGoods(a: GoodsLike, b: GoodsLike): boolean {
  if (a.name !== b.name || a.type !== b.type || a.type === 'container') return false;
  // Coins are coins: some stacks are made with only a value and a count.
  if (isMoney(a)) return Number(a.system?.coinValue?.value) === Number(b.system?.coinValue?.value);
  const strip = (system: Record<string, any> | undefined) => {
    const s = { ...(system ?? {}) };
    for (const key of OWNER_STATE) delete s[key];
    return s;
  };
  const equal = (foundry.utils as unknown as { objectsEqual?(x: unknown, y: unknown): boolean }).objectsEqual;
  // Stored data, not prepared: systems derive values from the quantity (WFRP4e's total encumbrance).
  const x = strip(a._source?.system ?? a.system);
  const y = strip(b._source?.system ?? b.system);
  return equal ? equal(x, y) : JSON.stringify(x) === JSON.stringify(y);
}

/** Steps that put changes back, newest last. */
export type Undo = (() => Promise<unknown>)[];

/**
 * Put back what the given steps did, newest first. Keeps going past a failed step, so as much as
 * possible is restored.
 */
export async function rollback(undo: Undo): Promise<void> {
  for (const step of undo.splice(0).reverse()) {
    try {
      await step();
    } catch (err) {
      console.error('[kaiserkram] putting things back after a failed transfer failed', err);
    }
  }
}

/** Run `work`; if it throws, put back every step it recorded, then rethrow. */
export async function allOrNothing<T>(work: (undo: Undo) => Promise<T>): Promise<T> {
  const undo: Undo = [];
  try {
    return await work(undo);
  } catch (err) {
    await rollback(undo);
    throw err;
  }
}

/**
 * The parts of an item and an actor these helpers use. Quantities are system-agnostic: WFRP4e
 * keeps them in `system.quantity.value`, dnd5e in `system.quantity`; items without either
 * (spells, skills, talents…) aren't counted goods.
 */
export type ItemLike = {
  id: string;
  uuid?: string;
  name: string;
  type: string;
  img: string;
  system?: Record<string, any>;
  parent?: ActorLike | null;
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
  createEmbeddedDocuments(type: 'Item', data: Record<string, unknown>[], options?: Record<string, unknown>): Promise<unknown>;
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

export function quantityPathOf(item: { system?: Record<string, any> }): string {
  return shapeOf(item.system) === 'number' ? 'system.quantity' : 'system.quantity.value';
}

/** Sort coins from the most valuable down. */
export function byCoinValue(a: { system?: Record<string, any> }, b: { system?: Record<string, any> }): number {
  return Number(b.system?.coinValue?.value ?? 0) - Number(a.system?.coinValue?.value ?? 0);
}

/**
 * Item data to give someone else: no id, not inside one of the old owner's containers, not
 * equipped or worn by them, and without a shop's stock settings (fixed price, unlimited…).
 */
export function copyForNewOwner(item: { toObject(): Record<string, any> }): Record<string, any> {
  const data = item.toObject();
  delete data._id;
  delete data.flags?.[MODULE_ID]?.trader;
  if (data.system?.location && typeof data.system.location === 'object') data.system.location.value = '';
  for (const key of ['equipped', 'worn']) {
    const v = data.system?.[key];
    if (v && typeof v === 'object' && 'value' in v) v.value = false;
    else if (typeof v === 'boolean') data.system[key] = false;
  }
  return data;
}

/** Where an item is kept: the id of the container it is in (WFRP4e), or '' when loose. */
function locationOf(item: ItemLike): string {
  return String(item.system?.location?.value ?? '');
}

/**
 * Move everything inside the container `fromId` on `source` into the container `toId` on
 * `target`, containers within it included, recording undo steps.
 */
export async function moveContents(source: ActorLike, fromId: string, target: ActorLike, toId: string, undo: Undo): Promise<void> {
  const inside = source.items.contents.filter((i) => locationOf(i) === fromId);
  for (const item of inside) {
    const data = copyForNewOwner(item);
    if (data.system?.location && typeof data.system.location === 'object') data.system.location.value = toId;
    const created = (await target.createEmbeddedDocuments('Item', [data], { [OWN_CREATE]: true })) as ItemLike[] | undefined;
    const copy = Array.isArray(created) ? created[0] : undefined;
    if (!copy) continue;
    undo.push(() => copy.delete());
    if (item.type === 'container') await moveContents(source, item.id, target, copy.id, undo);
    const original = item.toObject();
    await item.delete();
    undo.push(() => source.createEmbeddedDocuments('Item', [original], { keepId: true, [OWN_CREATE]: true }));
  }
}

/** Which items in the target may take more of the same goods (default: any counted item). */
type StackRule = (item: ItemLike) => boolean;

/**
 * Put `qty` of `item` on `target`: onto the same goods there if `canStack` allows, else as a new
 * item (a fresh copy for its new owner). The new copy, if one was made; undo steps go to `undo`.
 */
export async function receiveItem(item: ItemLike, qty: number, target: ActorLike, undo: Undo, canStack: StackRule = isTradeableItem): Promise<ItemLike | undefined> {
  const stack = target.items.contents.find((i) => canStack(i) && sameGoods(i, item));
  if (stack) {
    const before = quantityOf(stack);
    await stack.update({ [quantityPathOf(stack)]: before + qty });
    undo.push(() => stack.update({ [quantityPathOf(stack)]: before }));
    return undefined;
  }
  const data = copyForNewOwner(item);
  if (shapeOf(data.system) === 'number') data.system.quantity = qty;
  else if (data.system?.quantity && typeof data.system.quantity === 'object') data.system.quantity.value = qty;
  const created = (await target.createEmbeddedDocuments('Item', [data], { [OWN_CREATE]: true })) as ItemLike[] | undefined;
  const copy = Array.isArray(created) ? created[0] : undefined;
  if (copy) undo.push(() => copy.delete());
  return copy;
}

/**
 * Take `qty` of `item` off its owner: fewer of them, or the item gone when none are left (a whole
 * container moves its contents to `moveTo` first, when given). Undo steps go to `undo`.
 */
export async function takeFrom(item: ItemLike, qty: number, undo: Undo, moveTo?: { actor: ActorLike; container: ItemLike }): Promise<void> {
  const had = quantityOf(item);
  if (qty < had) {
    await item.update({ [quantityPathOf(item)]: had - qty });
    undo.push(() => item.update({ [quantityPathOf(item)]: had }));
    return;
  }
  const source = item.parent;
  if (source && moveTo && item.type === 'container') await moveContents(source, item.id, moveTo.actor, moveTo.container.id, undo);
  const original = item.toObject();
  await item.delete();
  if (source) undo.push(() => source.createEmbeddedDocuments('Item', [original], { keepId: true, [OWN_CREATE]: true }));
}

/**
 * Move `qty` of `item` onto `target`: stacked onto the same goods there, or as a new item; a whole
 * container takes its contents along. If taking it off the source fails, the copy on the target
 * is taken back, so nothing is doubled. Pass `undo` to collect the steps that would put the whole
 * move back (for several moves that must all happen or none).
 */
export async function transferItem(item: ItemLike, qty: number, target: ActorLike, undo: Undo = [], canStack: StackRule = isTradeableItem): Promise<void> {
  const steps: Undo = [];
  try {
    const copy = await receiveItem(item, qty, target, steps, canStack);
    await takeFrom(item, qty, steps, copy ? { actor: target, container: copy } : undefined);
  } catch (err) {
    await rollback(steps);
    throw err;
  }
  undo.push(...steps);
}
