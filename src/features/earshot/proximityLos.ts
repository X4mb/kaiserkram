import { getCenterPointFromTokenDocument, getProximityCenterFromToken } from './proximity.js';
import { getThroughWallGain } from './settings.js';

/**
 * Sound restriction values from Foundry (same numerics as `CONST.EDGE_SENSE_TYPES`; avoids reading
 * deprecated `CONST.WALL_SENSE_TYPES`, which logs a compatibility warning on every access).
 */
const EDGE_SOUND = {
  NONE: 0,
  LIMITED: 10,
  NORMAL: 20,
  PROXIMITY: 30,
  DISTANCE: 40,
} as const;

function restrictionToMultiplier(restriction: number, wallVolumeBase: number): number {
  const base = Math.min(1, Math.max(0, wallVolumeBase));

  switch (restriction) {
    case EDGE_SOUND.NONE:
      return 1;
    case EDGE_SOUND.LIMITED:
      return 0.45 + 0.55 * base;
    case EDGE_SOUND.NORMAL:
      return base;
    case EDGE_SOUND.PROXIMITY:
    case EDGE_SOUND.DISTANCE:
      return Math.min(1, 0.88 * base + 0.04);
    default:
      return base;
  }
}

function multiplyVertices(
  vertices: Array<{ restriction?: number }>,
  wallVolumeBase: number,
): number {
  if (vertices.length === 0) return 1;
  let mult = 1;
  for (const v of vertices) {
    const r = v.restriction ?? EDGE_SOUND.NORMAL;
    mult *= restrictionToMultiplier(r, wallVolumeBase);
  }
  return Math.min(1, Math.max(0, mult));
}

type SoundBackend = {
  testCollision?(
    origin: Canvas.PossiblyElevatedPoint,
    destination: Canvas.PossiblyElevatedPoint,
    options: { type: 'sound'; mode: 'all'; radius: number; useThreshold: boolean },
  ): { restriction?: number }[] | boolean | null;
};

/**
 * Single center ray only. Multiple offset rays + averaging still oscillated with wall edge tests;
 * env gain is quantized + sticky in the router; one ray is enough for stable “through wall” feel.
 */
export function getVoiceLosMultiplier(listenerToken: Token, speakerDoc: TokenDocument): number {
  if (listenerToken.id === speakerDoc.id) return 1;

  const wallVolumeBase = getThroughWallGain();
  if (wallVolumeBase >= 0.999) return 1;

  const dim = canvas?.dimensions;
  const SoundPoly = CONFIG.Canvas?.polygonBackends?.sound as SoundBackend | undefined;

  if (!dim || !SoundPoly?.testCollision) return 1;

  const l = getProximityCenterFromToken(listenerToken);
  const g = getCenterPointFromTokenDocument(speakerDoc);
  const snap = (n: number) => Math.round(n * 10) / 10;

  const lx = snap(l.x);
  const ly = snap(l.y);
  const sx = snap(g.x);
  const sy = snap(g.y);
  const elL = l.elevation;
  const elS = g.elevation;

  const origin: Canvas.PossiblyElevatedPoint = { x: lx, y: ly, elevation: elL };
  const destination: Canvas.PossiblyElevatedPoint = { x: sx, y: sy, elevation: elS };

  const test = SoundPoly.testCollision;
  if (!test) return 1;
  try {
    const vertices = test.call(SoundPoly, origin, destination, {
      type: 'sound',
      mode: 'all',
      radius: dim.maxR,
      useThreshold: true,
    });
    if (!Array.isArray(vertices) || vertices.length === 0) return 1;
    const out = multiplyVertices(vertices, wallVolumeBase);
    return Math.round(Math.min(1, Math.max(0, out)) * 20) / 20;
  } catch {
    return Math.round(Math.min(1, Math.max(0, wallVolumeBase)) * 20) / 20;
  }
}
