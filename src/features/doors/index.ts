import { MODULE_ID } from '../../core/constants.js';
import type { Feature } from '../../core/feature.js';
import { notify, on, settings } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';

/**
 * Doors in reach: a player opens or closes a door only when one of their tokens stands close
 * enough to it (on the door's level). The GM is never held back. Checked on the player's own
 * client before the change is sent, so a refused door doesn't move at all.
 */

const REACH = 'doorsReach';

type Point = { x: number; y: number };
type WallLike = { c: number[]; door: number; levels?: Set<string> | string[]; parent: SceneLike | null };
type TokenLike = {
  x: number;
  y: number;
  width: number;
  height: number;
  level?: string;
  testUserPermission(user: unknown, level: string): boolean;
};
type SceneLike = { grid: { size: number }; tokens: { contents: TokenLike[] } };

/** Distance from `p` to the segment a–b, in pixels. */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / length)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function reach(): number {
  const v = Number(settings().get(MODULE_ID, REACH));
  return Number.isFinite(v) && v > 0 ? v : 1.5;
}

/** The tokens that count for this player: the ones they control if any are theirs, else all they own. */
function myTokens(scene: SceneLike): TokenLike[] {
  const user = game.user;
  const owned = scene.tokens.contents.filter((t) => t.testUserPermission(user, 'OWNER'));
  const controlled = new Set(
    ((canvas as unknown as { tokens?: { controlled: { document: unknown }[] } } | null)?.tokens?.controlled ?? []).map((t) => t.document),
  );
  const chosen = owned.filter((t) => controlled.has(t));
  return chosen.length ? chosen : owned;
}

function onPreUpdateWall(wall: WallLike, change: Record<string, unknown>, _options: unknown, userId: string): boolean | void {
  if (userId !== game.user?.id || game.user?.isGM || !('ds' in change) || !wall.door) return;
  const scene = wall.parent;
  if (!scene) return;
  const size = scene.grid.size;
  const [ax, ay, bx, by] = wall.c;
  const levels = wall.levels ? new Set(wall.levels) : new Set<string>();
  const near = myTokens(scene).some((t) => {
    // A door belongs to its levels; one on another floor is out of reach whatever the distance.
    if (levels.size && t.level && !levels.has(t.level)) return false;
    const centre = { x: t.x + (t.width * size) / 2, y: t.y + (t.height * size) / 2 };
    // From a one-square token's centre (standing right next to the door is half a square); a
    // bigger creature's extra size counts as reach.
    const extra = ((Math.max(t.width, t.height) - 1) * size) / 2;
    return distanceToSegment(centre, { x: ax, y: ay }, { x: bx, y: by }) - extra <= reach() * size;
  });
  if (near) return;
  notify().warn(fmt('kaiserkram.doors.tooFar', 'Too far from the door: get within {reach} squares of it.', { reach: reach() }));
  return false;
}

export const doors: Feature = {
  id: 'doors',
  group: 'general',

  init() {
    settings().register(MODULE_ID, REACH, {
      name: 'kaiserkram.doors.SETTINGS.reach.name',
      hint: 'kaiserkram.doors.SETTINGS.reach.hint',
      scope: 'world',
      config: true,
      type: Number,
      range: { min: 0.5, max: 10, step: 0.5 },
      default: 1.5,
    });
    on('preUpdateWall', onPreUpdateWall as (...args: never[]) => unknown);
  },
};
