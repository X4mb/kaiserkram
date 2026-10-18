/**
 * System-agnostic item quantities. WFRP4e keeps them in `system.quantity.value`, dnd5e in
 * `system.quantity`; items without either (spells, skills, talents...) aren't tradeable.
 */

export type ItemLike = {
  id: string;
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

/** Move `qty` of `item` onto `target`: stacked onto a same-named item there, or as a new one. */
export async function transferItem(item: ItemLike, qty: number, target: ActorLike): Promise<void> {
  const had = quantityOf(item);
  const stack = target.items.contents.find(
    (i) => i.name === item.name && i.type === item.type && i.type !== 'container' && isTradeableItem(i),
  );
  if (stack) {
    await stack.update({ [quantityPath(stack)]: quantityOf(stack) + qty });
  } else {
    const data = item.toObject();
    delete data._id;
    if (shapeOf(data.system) === 'number') data.system.quantity = qty;
    else data.system.quantity.value = qty;
    // A container (WFRP4e) or equipped state means nothing on the new owner.
    if (data.system?.location && typeof data.system.location === 'object') data.system.location.value = '';
    for (const key of ['equipped', 'worn']) {
      const v = data.system?.[key];
      if (v && typeof v === 'object' && 'value' in v) v.value = false;
      else if (typeof v === 'boolean') data.system[key] = false;
    }
    await target.createEmbeddedDocuments('Item', [data]);
  }
  if (qty < had) await item.update({ [quantityPath(item)]: had - qty });
  else await item.delete();
}
