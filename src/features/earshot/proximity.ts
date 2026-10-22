/** Fixed distance curve: comfort segment then smooth falloff to silence at max range. */
const KNEE_FRAC = 0.5;
const A_KNEE = Math.pow(10, -12 / 20);
const OUTER_POWER = 3;

/**
 * Within this many grid units, distance falloff is treated as full (1). Stops mesh jitter
 * from making “standing next to someone” audibly pump when listener position used to come from PIXI.
 */
const NEAR_GRID_FULL = 0.55;

/**
 * Maps distance in grid units to linear gain (0–1). Single built-in curve (no setting).
 */
export function computeProximityGain(distanceGrid: number, maxRange: number): number {
  if (maxRange <= 0) return 1;
  if (distanceGrid <= 0) return 1;
  if (distanceGrid <= NEAR_GRID_FULL) return 1;
  if (distanceGrid >= maxRange) return 0;

  const kneeDist = maxRange * Math.min(0.85, Math.max(0.15, KNEE_FRAC));
  if (distanceGrid <= kneeDist) {
    const u = kneeDist > 0 ? distanceGrid / kneeDist : 1;
    return 1 + (A_KNEE - 1) * u;
  }
  const span = maxRange - kneeDist;
  const u = span > 0 ? (distanceGrid - kneeDist) / span : 1;
  return A_KNEE * Math.pow(1 - u, OUTER_POWER);
}

/**
 * The token a user with no assigned character speaks and hears from: the first one they own on
 * the scene (by id, so every client picks the same one).
 */
export function firstOwnedTokenDoc(user: User): TokenDocument | null {
  if (!canvas?.scene) return null;
  const owned = Array.from(canvas.scene.tokens).filter((d) => d.testUserPermission(user, 'OWNER'));
  owned.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
  return owned[0] ?? null;
}

/** Center for proximity when a canvas Token may be missing (e.g. not visible to this client). */
export function getCenterPointFromTokenDocument(doc: TokenDocument): { x: number; y: number; elevation: number } {
  const c = doc.getCenterPoint();
  const el = (c as { elevation?: number }).elevation ?? doc.elevation ?? 0;
  return { x: c.x, y: c.y, elevation: el };
}

/**
 * Listener position for proximity: the token you **own** and **control** (e.g. switching between two
 * owned PCs). Otherwise your assigned character’s primary token on this scene, or sole-owned / primary
 * fallbacks. If you control a token you do **not** own (e.g. GM puppet, observer), we still anchor to
 * your character’s token so proximity isn’t computed from someone else’s position.
 */
export function getListenerTokenForProximity(): Token | null {
  if (!canvas?.tokens || !canvas?.scene) return null;
  const u = game.user;
  if (!u) return null;

  const controlled = canvas.tokens.controlled[0];
  /** Two+ owned tokens: follow selection (same as moving your “ears” with the token). */
  if (controlled?.document?.testUserPermission(u, 'OWNER')) {
    return controlled;
  }

  const actor = u.character;

  if (actor) {
    const docs = Array.from(canvas.scene.tokens).filter((d) => d.actor?.id === actor.id);
    if (docs.length > 0) {
      const owned = docs.filter((d) => d.testUserPermission(u, 'OWNER'));
      const pool = owned.length > 0 ? owned : docs;
      pool.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
      const primaryDoc = pool[0];
      const primaryId = primaryDoc?.id;
      const primaryTok = primaryId ? canvas.tokens.get(primaryId) : null;
      if (primaryTok) {
        if (controlled) {
          const ctrlDoc = controlled.document;
          const ctrlIsThisCharacter = docs.some((d) => d.id === ctrlDoc.id);
          if (ctrlIsThisCharacter) return controlled;
        }
        return primaryTok;
      }
    }
  }

  if (controlled) return controlled;
  // Same rule as for speaking, so a player is heard and hears from the same token.
  const doc = firstOwnedTokenDoc(u);
  return doc?.id ? (canvas.tokens.get(doc.id) ?? null) : null;
}

/**
 * Euclidean distance between two points in **grid units** (cells).
 * Coarsens canvas pixels so sub-pixel / float noise does not wobble the value every frame.
 */
export function gridDistanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dim = canvas?.dimensions;
  if (!dim) return 0;
  const ax = Math.round(a.x * 4) / 4;
  const ay = Math.round(a.y * 4) / 4;
  const bx = Math.round(b.x * 4) / 4;
  const by = Math.round(b.y * 4) / 4;
  const dx = bx - ax;
  const dy = by - ay;
  const px = Math.hypot(dx, dy);
  if (px <= 0) return 0;

  const size = dim.size;
  if (typeof size === 'number' && size > 0) {
    /** 0.2 grid resolution — reduces 0.1↔0.2 flips at bucket edges while moving slowly. */
    const grid = px / size;
    return Math.round(grid * 5) / 5;
  }

  return 0;
}

/** Stable center from token document (no mesh jitter). Use for proximity distance + wall rays. */
export function getProximityCenterFromToken(token: Token): { x: number; y: number; elevation: number } {
  return getCenterPointFromTokenDocument(token.document);
}
