import { MODULE_ID } from '../../core/constants.js';
import { flags, notify, on } from '../../core/foundryApi.js';
import { fmt } from '../../core/i18n.js';
import { FLAGS } from './constants.js';

/**
 * The actor behind a party marker doubles as the party's shared inventory. Items dragged between
 * it and a character move instead of being copied, in both directions.
 */

type ItemLike = {
  id: string;
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

  const had = Number(source.system?.quantity?.value);
  const moved = Number(created.system?.quantity?.value);
  const removal =
    Number.isFinite(had) && Number.isFinite(moved) && moved > 0 && moved < had
      ? source.update({ 'system.quantity.value': had - moved })
      : source.delete();
  void removal.then(() =>
    notify().info(
      fmt('kaiserkram.party.notifications.itemMoved', 'Moved {item} from {from} to {to}.', {
        item: created.name,
        from: source.parent?.name ?? '?',
        to: target?.name ?? '?',
      }),
    ),
  );
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
  const copy = item.toObject();
  delete copy._id;
  // A container on the old owner means nothing on the new one.
  if (copy.system?.location && typeof copy.system.location === 'object') copy.system.location.value = '';
  void target.createEmbeddedDocuments('Item', [copy]);
  return false;
}

export function registerPartyInventory(): void {
  document.addEventListener('dragstart', onDragStart);
  on('createItem', onCreateItem as (...args: never[]) => unknown);
  on('dropCanvasData', onDropCanvas as (...args: never[]) => unknown);
}
