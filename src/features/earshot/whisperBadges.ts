import { whisperApplies } from './proximityAudioRouter.js';
import { getSpeakerTokenForUser } from './voiceToken.js';

/**
 * A small speech-bubble badge on a whispering user's token, visible to everyone who can see that
 * token, so nobody can lean over and whisper unnoticed.
 */

const COLOR = 0xb388ff;
const badges = new Map<string, { g: PIXI.Graphics; cellPx: number }>();
let whisperers = new Set<string>();

type Drawable = PIXI.Graphics & Record<string, unknown>;

/** PIXI v7 and v8 spell shape drawing differently. */
function circle(g: PIXI.Graphics, x: number, y: number, r: number, color: number): void {
  const gfx = g as Drawable;
  if (typeof gfx.circle === 'function' && typeof gfx.fill === 'function') {
    const v8 = gfx as unknown as {
      circle(x: number, y: number, r: number): void;
      fill(o: { color: number; alpha: number }): void;
    };
    v8.circle(x, y, r);
    v8.fill({ color, alpha: 1 });
    return;
  }
  const v7 = gfx as unknown as {
    beginFill(c: number, a?: number): void;
    drawCircle(x: number, y: number, r: number): void;
    endFill(): void;
  };
  v7.beginFill(color, 1);
  v7.drawCircle(x, y, r);
  v7.endFill();
}

/** A purple disc with three white dots, centred on the Graphics' origin. */
function drawBadge(g: PIXI.Graphics, cellPx: number): void {
  g.clear();
  const r = Math.max(8, cellPx * 0.13);
  circle(g, 0, 0, r, COLOR);
  const dot = r * 0.17;
  for (const dx of [-r * 0.42, 0, r * 0.42]) circle(g, dx, 0, dot, 0xffffff);
}

/** Recompute who is whispering (after a user's flags change, or someone leaves). */
export function refreshWhisperers(): void {
  const users = (game.users as unknown as { contents: User[] } | undefined)?.contents ?? [];
  whisperers = new Set(users.filter((u) => u.active && whisperApplies(u)).map((u) => u.id as string));
}

export function hasWhisperers(): boolean {
  return whisperers.size > 0 || badges.size > 0;
}

/** Place (or remove) each whisperer's badge; cheap enough to run every frame while anyone whispers. */
export function updateWhisperBadges(): void {
  const layer = canvas?.ready ? canvas.tokens : null;
  if (!layer) return;
  for (const [userId, badge] of badges) {
    if (whisperers.has(userId)) continue;
    badge.g.destroy();
    badges.delete(userId);
  }
  const cellPx = canvas?.dimensions?.size ?? 100;
  for (const userId of whisperers) {
    const user = game.users?.get(userId);
    const token = user ? getSpeakerTokenForUser(user) : null;
    let badge = badges.get(userId);
    // Only for viewers who can see the token: a hidden whisperer stays hidden.
    if (!token || !token.visible) {
      if (badge) badge.g.visible = false;
      continue;
    }
    if (!badge) {
      const g = new PIXI.Graphics();
      g.eventMode = 'none';
      if (!layer.sortableChildren) layer.sortableChildren = true;
      g.zIndex = 999999;
      layer.addChild(g);
      badge = { g, cellPx: 0 };
      badges.set(userId, badge);
    }
    if (badge.cellPx !== cellPx) {
      drawBadge(badge.g, cellPx);
      badge.cellPx = cellPx;
    }
    // Top-left corner of the token, slightly inset; follows movement animation.
    const pt = new PIXI.Point();
    token.getGlobalPosition(pt);
    layer.toLocal(pt, undefined, pt);
    const r = Math.max(8, cellPx * 0.13);
    badge.g.position.set(pt.x + r * 0.9, pt.y + r * 0.9);
    badge.g.visible = true;
  }
}

export function destroyWhisperBadges(): void {
  for (const badge of badges.values()) badge.g.destroy();
  badges.clear();
}
