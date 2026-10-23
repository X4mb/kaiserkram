import { MODULE_ID } from '../../core/constants.js';
import { activeGMId, flags, notify, on } from '../../core/foundryApi.js';
import { fmt } from '../../core/i18n.js';
import { FLAGS } from './constants.js';
import { copyForNewOwner, isTradeableItem, moveContents, quantityOf, quantityPathOf } from './trade/items.js';
import { sendRequest } from './trade/client.js';

/**
 * The actor behind a party marker doubles as the party's shared inventory. Items dragged between
 * it and a character move instead of being copied, in both directions.
 */

type ItemLike = {
  id: string;
  uuid: string;
  name: string;
  type: string;
  documentName?: string;
  parent?: ActorLike | null;
  system?: { quantity?: { value?: number }; location?: { value?: string } };
  toObject(): Record<string, any>;
  update(d: Record<string, unknown>): Promise<unknown>;
  delete(): Promise<unknown>;
};

type ActorLike = {
  id: string;
  name: string;
  documentName?: string;
  isOwner: boolean;
  hasPlayerOwner?: boolean;
  items: { contents: ItemLike[] };
  createEmbeddedDocuments(type: 'Item', data: Record<string, unknown>[]): Promise<unknown>;
};

type DropData = { type?: string; uuid?: string; x?: number; y?: number };

export function isPartyActor(actor: unknown): boolean {
  return Boolean(actor && flags(actor).getFlag(MODULE_ID, FLAGS.MARKER_ACTOR_FOR));
}

function itemFromDrop(data: DropData | undefined): ItemLike | null {
  if (data?.type !== 'Item' || !data.uuid) return null;
  try {
    const fromUuidSync = (foundry.utils as unknown as { fromUuidSync(u: string): unknown }).fromUuidSync;
    const item = fromUuidSync(data.uuid) as ItemLike | null;
    return item?.documentName === 'Item' && item.parent?.documentName === 'Actor' ? item : null;
  } catch {
    return null;
  }
}

/**
 * Whether an item moving from `source` to `target` should leave `source`: one side is the party,
 * the other a player's character or another party. Copies to NPCs (a trader's stock, say) stay copies.
 */
function involvesParty(source: ActorLike | null | undefined, target: ActorLike | null | undefined): boolean {
  if (!source || !target || source.id === target.id) return false;
  const sourceParty = isPartyActor(source);
  const targetParty = isPartyActor(target);
  if (!sourceParty && !targetParty) return false;
  const other = sourceParty ? target : source;
  if (!isPartyActor(other) && !other.hasPlayerOwner) return false;
  return source.isOwner && target.isOwner;
}

/**
 * The item this user last started dragging. Sheets put their drag data on the event before it
 * bubbles to the document, so it can be read here whichever sheet started the drag.
 */
let dragged: { uuid: string; at: number } | null = null;
const DRAG_WINDOW_MS = 10_000;
/**
 * Once the drag has ended, its drop has this long left to create the item. A drag that was let go
 * of somewhere else then stops counting soon, instead of after the full window. (Not cleared at
 * once: dragend can fire before an asynchronous drop handler has created the item.)
 */
const AFTER_DRAG_MS = 3000;

/**
 * Code that moves an item itself (the stash window, a trade, a gift) calls this first, so the
 * createItem below doesn't take the item off its source a second time.
 */
export function forgetDrag(): void {
  dragged = null;
}

function onDragEnd(): void {
  if (dragged) dragged.at = Math.min(dragged.at, Date.now() - DRAG_WINDOW_MS + AFTER_DRAG_MS);
}

function onDragStart(event: DragEvent): void {
  try {
    const data = JSON.parse(event.dataTransfer?.getData('text/plain') ?? '') as DropData;
    dragged = data.type === 'Item' && data.uuid ? { uuid: data.uuid, at: Date.now() } : null;
  } catch {
    dragged = null;
  }
}

/**
 * Whatever added the copy (the system's sheet, the canvas drop below, another module), take the
 * dragged item away from where it came from: all of it, or just the part that moved.
 */
function onCreateItem(created: ItemLike, _options: unknown, userId: string): void {
  if (userId !== game.user?.id || !dragged || Date.now() - dragged.at > DRAG_WINDOW_MS) return;
  const source = itemFromDrop({ type: 'Item', uuid: dragged.uuid });
  const target = created.parent;
  if (!source || !involvesParty(source.parent, target)) return;
  if (source.name !== created.name || source.type !== created.type) return;
  dragged = null;

  const had = quantityOf(source);
  const moved = quantityOf(created);
  const part = moved > 0 && moved < had ? moved : null;
  const counted = isTradeableItem(source as never) && moved > 0;
  // With a GM online, the GM takes it off the source, one move at a time: if two players drag
  // the same stack at once, the second gets their copy taken back instead of a duplicate.
  if (activeGMId()) {
    // Always the amount copied, so the GM can tell when less than that is left.
    sendRequest({ op: 'settle', source: source.uuid, copy: created.uuid, qty: counted ? moved : null });
    return;
  }
  const removal =
    part !== null
      ? source.update({ [quantityPathOf(source)]: had - part })
      : (source.type === 'container' && source.parent && target
          ? moveContents(source.parent as never, source.id, target as never, created.id, [])
          : Promise.resolve()
        ).then(() => source.delete());
  removal
    .then(() =>
      notify().info(
        fmt('kaiserkram.party.notifications.itemMoved', 'Moved {item} from {from} to {to}.', {
          item: created.name,
          from: source.parent?.name ?? '?',
          to: target?.name ?? '?',
        }),
      ),
    )
    .catch((err: unknown) => console.error('[kaiserkram] party: taking the moved item off its source failed', err));
}

type TokenLike = { document: { actor?: ActorLike | null }; bounds?: { contains(x: number, y: number): boolean } };

/** Core does nothing with an item dropped on the canvas; on a party marker, put it in the party inventory. */
function onDropCanvas(_canvas: unknown, data: DropData): boolean | void {
  const item = itemFromDrop(data);
  if (!item || data.x === undefined || data.y === undefined) return;
  const x = data.x;
  const y = data.y;
  const placeables = (canvas as unknown as { tokens?: { placeables: TokenLike[] } } | null)?.tokens?.placeables ?? [];
  const target = placeables.filter((t) => isPartyActor(t.document.actor) && t.bounds?.contains(x, y)).at(-1)?.document.actor;
  if (!target || !involvesParty(item.parent, target)) return;
  void target.createEmbeddedDocuments('Item', [copyForNewOwner(item)]);
  return false;
}

export function registerPartyInventory(): void {
  document.addEventListener('dragstart', onDragStart);
  document.addEventListener('dragend', onDragEnd);
  on('createItem', onCreateItem as (...args: never[]) => unknown);
  on('dropCanvasData', onDropCanvas as (...args: never[]) => unknown);
}
