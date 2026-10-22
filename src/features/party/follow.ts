import { MODULE_ID } from '../../core/constants.js';
import { flags, isActiveGM, on } from '../../core/foundryApi.js';
import { FLAGS } from './constants.js';
import { centerOf, findDeployedMembers } from './recall.js';
import { getMarkerFollows } from './settings.js';
import { sceneTokens } from './views.js';

/**
 * While the party is deployed and its marker hidden, the marker stays in the middle of the
 * deployed tokens, so Recall gathers everyone where they actually are. The active GM moves it,
 * shortly after the party stops moving (one update for a whole group move, not one per step).
 */

const WAIT_MS = 500;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

type TokenLike = TokenDocument & { id: string; parent: Scene | null };

function follow(scene: Scene, markerId: string): void {
  const marker = sceneTokens(scene).tokens.get(markerId) as TokenLike | undefined;
  if (!marker?.hidden || !getMarkerFollows()) return;
  const members = findDeployedMembers(marker, scene);
  if (!members.length) return;
  const gridSize = (scene.grid as unknown as { size: number }).size;
  const center = centerOf(members, scene);
  const x = Math.round(center.x - (marker.width * gridSize) / 2);
  const y = Math.round(center.y - (marker.height * gridSize) / 2);
  if (Math.abs(marker.x - x) < 1 && Math.abs(marker.y - y) < 1) return;
  // Hidden from players anyway; no need to slide it across the map.
  marker.update({ x, y }, { animate: false } as never).catch((err: unknown) =>
    console.error('[kaiserkram] party: moving the hidden marker failed', err),
  );
}

/** A deployed member moved, arrived or left: bring its marker along, once things settle. */
function onMemberChanged(token: TokenLike, change?: Record<string, unknown>): void {
  if (change && !('x' in change) && !('y' in change)) return;
  const markerId = flags(token).getFlag(MODULE_ID, FLAGS.ORIGIN_MARKER_ID) as string | undefined;
  const scene = token.parent;
  if (!markerId || !scene || !isActiveGM() || !getMarkerFollows()) return;
  const key = `${scene.id}.${markerId}`;
  clearTimeout(timers.get(key));
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      follow(scene, markerId);
    }, WAIT_MS),
  );
}

export function registerMarkerFollow(): void {
  on('updateToken', ((token: TokenLike, change: Record<string, unknown>) => onMemberChanged(token, change)) as (
    ...args: never[]
  ) => unknown);
  on('deleteToken', ((token: TokenLike) => onMemberChanged(token)) as (...args: never[]) => unknown);
}
