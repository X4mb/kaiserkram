import { MODULE_ID } from '../../core/constants.js';
import { flags, isActiveGM, on } from '../../core/foundryApi.js';
import { FLAGS } from './constants.js';
import { centerOf, findDeployedMembers, isPartyMarker } from './recall.js';
import { getMarkerFollows } from './settings.js';
import { sceneTokens } from './views.js';

/**
 * While the party is deployed and its marker hidden, the marker stays in the middle of the
 * deployed tokens, so Recall gathers everyone where they actually are. The active GM moves it,
 * calmly, so it can still be clicked:
 * - only once the party has stood still for a few seconds (one move for a whole walk);
 * - only when the middle has drifted at least a grid square, and snapped to the grid;
 * - never while the GM has it selected or the mouse over it (it catches up afterwards).
 */

const SETTLE_MS = 3000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

type TokenLike = TokenDocument & {
  id: string;
  parent: Scene | null;
  getSnappedPosition?(data: { x: number; y: number }): { x: number; y: number };
};
type PlaceableLike = { document: TokenLike; controlled?: boolean; hover?: boolean };

/** Whether the GM is working with the marker on this client right now. */
function inHand(scene: Scene, markerId: string): boolean {
  const c = canvas as unknown as { scene?: Scene | null; tokens?: { get(id: string): PlaceableLike | undefined } } | null;
  if (c?.scene !== scene) return false;
  const placeable = c.tokens?.get(markerId);
  return Boolean(placeable?.controlled || placeable?.hover);
}

function follow(scene: Scene, markerId: string): void {
  const marker = sceneTokens(scene).tokens.get(markerId) as TokenLike | undefined;
  if (!marker?.hidden || !getMarkerFollows() || !isActiveGM()) return;
  if (inHand(scene, markerId)) return; // Letting go of it calls this again.
  const members = findDeployedMembers(marker, scene);
  if (!members.length) return;
  const gridSize = (scene.grid as unknown as { size: number }).size;
  const center = centerOf(members, scene);
  const halfW = (marker.width * gridSize) / 2;
  const halfH = (marker.height * gridSize) / 2;
  // Small shuffles don't count: only follow once the middle is a square or more away.
  if (Math.hypot(marker.x + halfW - center.x, marker.y + halfH - center.y) < gridSize) return;
  const target = { x: center.x - halfW, y: center.y - halfH };
  const { x, y } = marker.getSnappedPosition?.(target) ?? {
    x: Math.round(target.x / gridSize) * gridSize,
    y: Math.round(target.y / gridSize) * gridSize,
  };
  if (x === marker.x && y === marker.y) return;
  // Hidden from players anyway; no need to slide it across the map.
  marker.update({ x, y }, { animate: false } as never).catch((err: unknown) =>
    console.error('[kaiserkram] party: moving the hidden marker failed', err),
  );
}

/** Follow once things have been quiet for a while; each new movement restarts the wait. */
function schedule(scene: Scene, markerId: string): void {
  if (!isActiveGM() || !getMarkerFollows()) return;
  const key = `${scene.id}.${markerId}`;
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      follow(scene, markerId);
    }, SETTLE_MS),
  );
}

/** A deployed member moved or left: bring its marker along, once things settle. */
function onMemberChanged(token: TokenLike, change?: Record<string, unknown>): void {
  if (change && !('x' in change) && !('y' in change)) return;
  const markerId = flags(token).getFlag(MODULE_ID, FLAGS.ORIGIN_MARKER_ID) as string | undefined;
  if (markerId && token.parent) schedule(token.parent, markerId);
}

/** The GM let go of the marker (deselected it, or moved the mouse off): catch up if needed. */
function onMarkerReleased(placeable: PlaceableLike, active: boolean): void {
  const doc = placeable.document;
  if (active || !doc?.parent || !isPartyMarker(doc)) return;
  schedule(doc.parent, doc.id);
}

export function registerMarkerFollow(): void {
  on('updateToken', ((token: TokenLike, change: Record<string, unknown>) => onMemberChanged(token, change)) as (
    ...args: never[]
  ) => unknown);
  on('deleteToken', ((token: TokenLike) => onMemberChanged(token)) as (...args: never[]) => unknown);
  on('controlToken', onMarkerReleased as (...args: never[]) => unknown);
  on('hoverToken', onMarkerReleased as (...args: never[]) => unknown);
}
