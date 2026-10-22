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

function quantityPath(item: { system?: Record<string, any> }): string {
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
  if (stack) {
    const before = quantityOf(stack);
    await stack.update({ [quantityPath(stack)]: before + qty });
    steps.push(() => stack.update({ [quantityPath(stack)]: before }));
  } else {
    const data = copyForNewOwner(item);
    if (shapeOf(data.system) === 'number') data.system.quantity = qty;
    else data.system.quantity.value = qty;
    const created = (await target.createEmbeddedDocuments('Item', [data])) as ItemLike[] | undefined;
    const copy = Array.isArray(created) ? created[0] : undefined;
    if (copy) steps.push(() => copy.delete());
  }
  try {
    if (qty < had) {
      await item.update({ [quantityPath(item)]: had - qty });
      steps.push(() => item.update({ [quantityPath(item)]: had }));
    } else {
      const source = item.parent;
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
