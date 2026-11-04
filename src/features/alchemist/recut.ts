import { MODULE_ID } from '../../core/constants.js';
import { flags, isActiveGM, notify, on } from '../../core/foundryApi.js';
import { fmt } from '../../core/i18n.js';
import type { Cutout } from './build.js';
import { folderOf } from './files.js';
import { cutName, uploadCut } from './importer.js';

/**
 * An outline region (a floor's visible area, or the roof's) was reshaped: cut its picture again
 * from the original, to the region as it is now, and put the new picture on its level or tile.
 * The GM adds a rectangle over a balcony, and the balcony appears.
 */

type RegionLike = {
  id: string;
  name: string;
  polygons: { points: number[] }[];
  parent: SceneLike | null;
};
type SceneLike = {
  width: number;
  height: number;
  levels: { get(id: string): { background: { src: string | null }; update(d: Record<string, unknown>): Promise<unknown> } | undefined };
  tiles: { get(id: string): { texture: { src: string | null }; update(d: Record<string, unknown>): Promise<unknown> } | undefined };
};

const WAIT_MS = 800;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

async function recut(region: RegionLike): Promise<void> {
  const cutout = flags(region).getFlag(MODULE_ID, 'cutout') as Cutout | undefined;
  const scene = region.parent;
  if (!cutout || !scene) return;
  const target = cutout.target === 'roof' ? scene.tiles.get(cutout.id) : scene.levels.get(cutout.id);
  if (!target) return;
  const current = cutout.target === 'roof' ? (target as { texture: { src: string | null } }).texture.src : (target as { background: { src: string | null } }).background.src;
  const outline = region.polygons.map((p) => Array.from(p.points));
  if (!outline.length) return;
  const path = await uploadCut(folderOf(current ?? cutout.source), cutout.source, cutName(cutout.source), scene, outline);
  await target.update(cutout.target === 'roof' ? { 'texture.src': path } : { 'background.src': path });
  notify().info(fmt('kaiserkram.alchemist.recut', '{name}: picture cut again to the new outline.', { name: region.name }));
}

function onRegionUpdate(region: RegionLike, change: Record<string, unknown>): void {
  if (!('shapes' in change) || !isActiveGM() || !flags(region).getFlag(MODULE_ID, 'cutout')) return;
  // Dragging a corner sends several updates; cut once it has settled.
  clearTimeout(timers.get(region.id));
  timers.set(
    region.id,
    setTimeout(() => {
      timers.delete(region.id);
      recut(region).catch((err) => console.error('[kaiserkram] alchemist: cutting the picture again failed', err));
    }, WAIT_MS),
  );
}

export function registerRecut(): void {
  on('updateRegion', onRegionUpdate as (...args: never[]) => unknown);
}
