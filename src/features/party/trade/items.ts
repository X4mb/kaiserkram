import { rollback, sameGoods, type Undo } from '../../../core/items.js';
import { forgetDrag } from '../inventory.js';

export { isMoney, rollback, type Undo } from '../../../core/items.js';

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
    const created = (await target.createEmbeddedDocuments('Item', [data])) as ItemLike[] | undefined;
    const copy = Array.isArray(created) ? created[0] : undefined;
    if (!copy) continue;
    undo.push(() => copy.delete());
    if (item.type === 'container') await moveContents(source, item.id, target, copy.id, undo);
    const original = item.toObject();
    await item.delete();
    undo.push(() => source.createEmbeddedDocuments('Item', [original], { keepId: true }));
  }
}

/**
 * Move `qty` of `item` onto `target`: stacked onto the same goods there, or as a new item.
 * If taking it off the source fails, the copy on the target is taken back, so nothing is doubled.
 * Pass `undo` to collect the steps that would put the whole move back (for several moves that
 * must all happen or none).
 */
export async function transferItem(item: ItemLike, qty: number, target: ActorLike, undo: Undo = []): Promise<void> {
  // This removes the item from its source itself; the party-move tracker must not as well.
  forgetDrag();
  const had = quantityOf(item);
  const steps: Undo = [];
  const stack = target.items.contents.find((i) => isTradeableItem(i) && sameGoods(i, item));
  let copy: ItemLike | undefined;
  if (stack) {
    const before = quantityOf(stack);
    await stack.update({ [quantityPathOf(stack)]: before + qty });
    steps.push(() => stack.update({ [quantityPathOf(stack)]: before }));
  } else {
    const data = copyForNewOwner(item);
    if (shapeOf(data.system) === 'number') data.system.quantity = qty;
    else data.system.quantity.value = qty;
    const created = (await target.createEmbeddedDocuments('Item', [data])) as ItemLike[] | undefined;
    copy = Array.isArray(created) ? created[0] : undefined;
    const made = copy;
    if (made) steps.push(() => made.delete());
  }
  try {
    if (qty < had) {
      await item.update({ [quantityPathOf(item)]: had - qty });
      steps.push(() => item.update({ [quantityPathOf(item)]: had }));
    } else {
      const source = item.parent;
      // A whole container goes with what is in it.
      if (source && copy && item.type === 'container') await moveContents(source, item.id, target, copy.id, steps);
      const original = item.toObject();
      await item.delete();
      if (source) steps.push(() => source.createEmbeddedDocuments('Item', [original], { keepId: true }));
    }
  } catch (err) {
    await rollback(steps);
    throw err;
  }
  undo.push(...steps);
}
