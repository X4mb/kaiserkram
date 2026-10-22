import type { Feature } from '../../core/feature.js';
import { notify, on } from '../../core/foundryApi.js';
import { fmt } from '../../core/i18n.js';

/**
 * WFRP4e lets anything go into a container and only shows it as over capacity ("3/2"). This
 * checks before an item goes into one: if its encumbrance doesn't fit, a player's move is
 * stopped with a message; the GM may still overfill, with a warning.
 */

type ItemLike = {
  id: string;
  name: string;
  type: string;
  system?: Record<string, any>;
  parent?: (ActorLike & { documentName?: string }) | null;
};
type ActorLike = { items: { contents: ItemLike[]; get(id: string): ItemLike | undefined } };

/** Below this, a rounding difference rather than a real overflow (coins are 0.005 each). */
const EPSILON = 1e-6;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function encOf(system: Record<string, any> | undefined, qty = num(system?.quantity?.value)): number {
  return num(system?.encumbrance?.value) * Math.max(0, qty);
}

/** Encumbrance already in `container`, leaving out `exceptId` (the item being moved or changed). */
function loadOf(actor: ActorLike, containerId: string, exceptId?: string): number {
  return actor.items.contents
    .filter((i) => i.id !== exceptId && i.system?.location?.value === containerId)
    .reduce((sum, i) => sum + encOf(i.system), 0);
}

/**
 * Items going into containers in the same batch (several dropped or moved at once): Foundry
 * hands every item of one batch the same options object, so it keys what the batch has added
 * so far, per container. Without it each item would be checked as if it went in alone.
 */
const batches = new WeakMap<object, Map<string, number>>();

function batchOf(options: unknown): Map<string, number> {
  if (!options || typeof options !== 'object') return new Map();
  let batch = batches.get(options);
  if (!batch) batches.set(options, (batch = new Map()));
  return batch;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Whether `incoming` encumbrance (the item as it would be) fits in the container with id
 * `containerId` on `actor`. Tells the user when it doesn't; returns false only to stop a player.
 */
function allow(actor: ActorLike, containerId: string, item: ItemLike, incoming: number, batch: Map<string, number>): boolean {
  const container = actor.items.get(containerId);
  if (!container || container.type !== 'container' || container.id === item.id) return true;
  const capacity = num(container.system?.carries?.value);
  if (capacity <= 0) return true;
  const load = loadOf(actor, containerId, item.id) + (batch.get(containerId) ?? 0);
  const fits = load + incoming <= capacity + EPSILON;
  if (fits || game.user?.isGM) batch.set(containerId, (batch.get(containerId) ?? 0) + incoming);
  if (fits) return true;

  const vars = {
    container: container.name,
    item: item.name,
    load: round(load),
    capacity: round(capacity),
    need: round(incoming),
    total: round(load + incoming),
  };
  if (game.user?.isGM) {
    notify().warn(fmt('kaiserkram.containers.overfilled', '{container} is now over capacity ({total}/{capacity}).', vars));
    return true;
  }
  notify().warn(
    fmt('kaiserkram.containers.full', "{item} doesn't fit in {container}: {load}/{capacity} used, and it needs {need}.", vars),
  );
  return false;
}

function onPreUpdateItem(item: ItemLike, changes: Record<string, unknown>, options: unknown, userId: string): boolean | void {
  if (userId !== game.user?.id) return;
  const actor = item.parent;
  if (actor?.documentName !== 'Actor') return;
  const flat = foundry.utils.flattenObject(changes) as Record<string, unknown>;
  const has = (k: string) => Object.prototype.hasOwnProperty.call(flat, k);
  const location = (has('system.location.value') ? flat['system.location.value'] : item.system?.location?.value) as
    | string
    | undefined;
  if (!location) return;
  const qty = has('system.quantity.value') ? num(flat['system.quantity.value']) : num(item.system?.quantity?.value);
  const enc = has('system.encumbrance.value') ? num(flat['system.encumbrance.value']) : num(item.system?.encumbrance?.value);
  const incoming = enc * Math.max(0, qty);
  // Only a move into the container, or the item growing inside it, can overfill it.
  const moved = location !== item.system?.location?.value;
  if (!moved && incoming <= encOf(item.system) + EPSILON) return;
  if (!allow(actor, location, item, incoming, batchOf(options))) return false;
}

function onPreCreateItem(item: ItemLike, _data: unknown, options: unknown, userId: string): boolean | void {
  if (userId !== game.user?.id) return;
  const actor = item.parent;
  const location = item.system?.location?.value as string | undefined;
  if (actor?.documentName !== 'Actor' || !location) return;
  if (!allow(actor, location, item, encOf(item.system), batchOf(options))) return false;
}

export const containers: Feature = {
  id: 'containers',
  group: 'wfrp4e',
  systems: ['wfrp4e'],

  init() {
    on('preUpdateItem', onPreUpdateItem as (...args: never[]) => unknown);
    on('preCreateItem', onPreCreateItem as (...args: never[]) => unknown);
  },
};
