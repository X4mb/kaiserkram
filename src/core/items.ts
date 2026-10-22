/**
 * Item helpers shared by features that move items between actors (the party's trades and stash,
 * the trader's shop). System-agnostic apart from WFRP4e's coins.
 */

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
