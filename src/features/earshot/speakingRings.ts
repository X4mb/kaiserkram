import { proximityRouter } from './proximityAudioRouter.js';
import { getSpeakingRings } from './settings.js';
import { getSpeakerTokenForUser } from './voiceToken.js';

/**
 * A soft ring around a token while its player talks. The level comes from what this client
 * actually hears (after distance and walls), so you only see someone speak when you can hear
 * them; a far-off whisper stays invisible. Your own ring follows Foundry's own speaking detection.
 */

const COLOR = 0x66ff99;
/** RMS above which a peer counts as speaking; below, the ring fades out after HOLD_MS. */
const THRESHOLD = 0.012;
const HOLD_MS = 350;

type Ring = { g: PIXI.Graphics; size: string; alpha: number };
const rings = new Map<string, Ring>();
const lastLoud = new Map<string, number>();

type Drawable = PIXI.Graphics & Record<string, unknown>;

function strokeCircle(g: PIXI.Graphics, r: number, width: number): void {
  const gfx = g as Drawable;
  if (typeof gfx.circle === 'function' && typeof gfx.stroke === 'function') {
    const v8 = gfx as unknown as {
      circle(x: number, y: number, r: number): void;
      stroke(o: { width: number; color: number; alpha: number }): void;
    };
    v8.circle(0, 0, r);
    v8.stroke({ width, color: COLOR, alpha: 1 });
    return;
  }
  const v7 = gfx as unknown as {
    lineStyle(width: number, color: number, alpha: number): void;
    drawCircle(x: number, y: number, r: number): void;
  };
  v7.lineStyle(width, COLOR, 1);
  v7.drawCircle(0, 0, r);
}

/** Whether this client's own user is talking, per Foundry's A/V (voice activation or push-to-talk). */
function selfSpeaking(): boolean {
  const av = (game as unknown as {
    webrtc?: { settings?: { activity?: Record<string, { speaking?: boolean }> }; _speakingData?: { speaking?: boolean } };
  }).webrtc;
  const id = game.user?.id ?? '';
  return Boolean(av?._speakingData?.speaking ?? av?.settings?.activity?.[id]?.speaking);
}

function speakingNow(userId: string, now: number): boolean {
  const loud = userId === game.user?.id ? selfSpeaking() : proximityRouter.levelOf(userId) > THRESHOLD;
  if (loud) lastLoud.set(userId, now);
  return now - (lastLoud.get(userId) ?? -Infinity) < HOLD_MS;
}

export function destroySpeakingRings(): void {
  for (const ring of rings.values()) ring.g.destroy();
  rings.clear();
  lastLoud.clear();
}

/** Per frame: place, fade in or fade out each speaker's ring. */
export function updateSpeakingRings(): void {
  const layer = canvas?.ready ? canvas.tokens : null;
  if (!layer || !getSpeakingRings()) {
    if (rings.size) destroySpeakingRings();
    return;
  }
  const now = performance.now();
  const cellPx = canvas?.dimensions?.size ?? 100;
  const ids = new Set([...proximityRouter.peerIds(), ...(game.user ? [game.user.id as string] : [])]);
  for (const [userId, ring] of rings) {
    if (ids.has(userId)) continue;
    ring.g.destroy();
    rings.delete(userId);
  }
  for (const userId of ids) {
    const speaking = speakingNow(userId, now);
    let ring = rings.get(userId);
    if (!speaking && !ring) continue;
    const user = game.users?.get(userId);
    const token = user ? getSpeakerTokenForUser(user) : null;
    if (!token || !token.visible) {
      if (ring) ring.g.visible = false;
      continue;
    }
    if (!ring) {
      const g = new PIXI.Graphics();
      g.eventMode = 'none';
      if (!layer.sortableChildren) layer.sortableChildren = true;
      g.zIndex = 999998;
      g.alpha = 0;
      layer.addChild(g);
      ring = { g, size: '', alpha: 0 };
      rings.set(userId, ring);
    }
    const w = token.document.width * cellPx;
    const h = token.document.height * cellPx;
    const size = `${w}x${h}`;
    if (ring.size !== size) {
      ring.g.clear();
      strokeCircle(ring.g, Math.max(w, h) / 2 + cellPx * 0.06, Math.max(3, cellPx * 0.05));
      ring.size = size;
    }
    // Ease towards on/off so short pauses between words don't flicker.
    ring.alpha += ((speaking ? 0.85 : 0) - ring.alpha) * 0.25;
    ring.g.alpha = ring.alpha;
    ring.g.visible = ring.alpha > 0.02;
    const pt = new PIXI.Point();
    token.getGlobalPosition(pt);
    layer.toLocal(pt, undefined, pt);
    ring.g.position.set(pt.x + w / 2, pt.y + h / 2);
  }
}
