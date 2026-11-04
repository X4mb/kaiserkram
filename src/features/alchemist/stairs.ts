import { MODULE_ID } from '../../core/constants.js';
import { dialogV2, flags, notify, on } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';

/**
 * Stairs in two steps: the GM drags a box over a staircase on the level they are viewing, then
 * picks Up, Down or Both. That becomes a Region on those levels, marked as stairs. A token
 * stepping onto it goes straight to the other level, feet on its floor: no question about how it
 * moves (Foundry's own Change Level behavior asks that every time). Only stairs that lead both
 * ways ask, from the middle floor, whether up or down.
 */

type LevelLike = { id: string; name: string; elevation: { bottom: number | null; top: number | null } };
type SceneLike = {
  levels: { contents: LevelLike[] };
  createEmbeddedDocuments(type: 'Region', data: Record<string, unknown>[]): Promise<unknown>;
};
type CanvasLike = {
  ready: boolean;
  scene: SceneLike | null;
  level: LevelLike | null;
  app: { view: HTMLCanvasElement };
  canvasCoordinatesFromClient(p: { x: number; y: number }): { x: number; y: number };
};

function board(): CanvasLike | null {
  const c = canvas as unknown as CanvasLike | null;
  return c?.ready && c.scene ? c : null;
}

/** The levels next to the viewed one: below and above, by elevation. */
function neighbours(scene: SceneLike, current: LevelLike): { below?: LevelLike; above?: LevelLike } {
  const sorted = [...scene.levels.contents].sort((a, b) => (a.elevation.bottom ?? -Infinity) - (b.elevation.bottom ?? -Infinity));
  const i = sorted.findIndex((l) => l.id === current.id);
  return { below: i > 0 ? sorted[i - 1] : undefined, above: i >= 0 && i < sorted.length - 1 ? sorted[i + 1] : undefined };
}

type Box = { x: number; y: number; width: number; height: number };

/** Let the GM drag a box over the canvas; resolves with it in scene coordinates, or null (Esc). */
function dragBox(c: CanvasLike): Promise<Box | null> {
  return new Promise((resolve) => {
    const view = c.app.view.getBoundingClientRect();
    const layer = document.createElement('div');
    layer.className = `${MODULE_ID}-stairs-drag`;
    Object.assign(layer.style, {
      position: 'fixed',
      left: `${view.left}px`,
      top: `${view.top}px`,
      width: `${view.width}px`,
      height: `${view.height}px`,
      cursor: 'crosshair',
      zIndex: '50',
    });
    const box = document.createElement('div');
    Object.assign(box.style, { position: 'fixed', border: '2px dashed #f5c542', background: 'rgba(245,197,66,0.15)', pointerEvents: 'none' });
    let start: { x: number; y: number } | null = null;
    const finish = (result: Box | null) => {
      layer.remove();
      box.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      finish(null);
    };
    layer.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      finish(null);
    });
    layer.addEventListener('pointerdown', (ev) => {
      if (ev.button !== 0) return;
      start = { x: ev.clientX, y: ev.clientY };
      layer.setPointerCapture(ev.pointerId);
      document.body.append(box);
    });
    layer.addEventListener('pointermove', (ev) => {
      if (!start) return;
      Object.assign(box.style, {
        left: `${Math.min(start.x, ev.clientX)}px`,
        top: `${Math.min(start.y, ev.clientY)}px`,
        width: `${Math.abs(ev.clientX - start.x)}px`,
        height: `${Math.abs(ev.clientY - start.y)}px`,
      });
    });
    layer.addEventListener('pointerup', (ev) => {
      if (!start) return;
      const a = c.canvasCoordinatesFromClient(start);
      const b = c.canvasCoordinatesFromClient({ x: ev.clientX, y: ev.clientY });
      const result = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
      // A click without a drag is not a staircase.
      finish(result.width < 10 || result.height < 10 ? null : result);
    });
    window.addEventListener('keydown', onKey, true);
    document.body.append(layer);
  });
}

/** GM: drag over a staircase on the viewed level, pick where it leads, place the region. */
export async function placeStairs(): Promise<void> {
  if (!game.user?.isGM) return;
  const c = board();
  const current = c?.level ?? null;
  if (!c?.scene || !current || c.scene.levels.contents.length < 2) {
    notify().warn(loc('kaiserkram.alchemist.stairs.needLevels', 'Stairs need a scene with at least two levels.'));
    return;
  }
  const { below, above } = neighbours(c.scene, current);
  notify().info(loc('kaiserkram.alchemist.stairs.drag', 'Drag a box over the staircase. Esc cancels.'));
  const area = await dragBox(c);
  if (!area) return;

  const buttons = [
    above && { action: 'up', label: `${loc('kaiserkram.alchemist.stairs.up', 'Up')}: ${above.name}`, icon: 'fa-solid fa-arrow-up' },
    below && { action: 'down', label: `${loc('kaiserkram.alchemist.stairs.down', 'Down')}: ${below.name}`, icon: 'fa-solid fa-arrow-down' },
    above && below && { action: 'both', label: loc('kaiserkram.alchemist.stairs.both', 'Both'), icon: 'fa-solid fa-arrows-up-down' },
    { action: 'cancel', label: loc('kaiserkram.alchemist.cancel', 'Cancel') },
  ].filter(Boolean);
  const way = (await dialogV2().wait({
    window: { title: loc('kaiserkram.alchemist.stairs.title', 'Stairs'), icon: 'fa-solid fa-stairs' },
    content: `<p>${loc('kaiserkram.alchemist.stairs.where', 'Where do these stairs lead from {level}?').replace('{level}', current.name)}</p>`,
    rejectClose: false,
    buttons,
  })) as string | null;
  const targets = way === 'up' ? [above] : way === 'down' ? [below] : way === 'both' ? [above, below] : [];
  const to = targets.filter((l): l is LevelLike => Boolean(l));
  if (!to.length) return;

  const name =
    way === 'up'
      ? loc('kaiserkram.alchemist.stairs.nameUp', 'Stairs up')
      : way === 'down'
        ? loc('kaiserkram.alchemist.stairs.nameDown', 'Stairs down')
        : loc('kaiserkram.alchemist.stairs.nameBoth', 'Stairs');
  await c.scene.createEmbeddedDocuments('Region', [
    {
      name,
      color: '#f5c542',
      shapes: [{ type: 'rectangle', x: Math.round(area.x), y: Math.round(area.y), width: Math.round(area.width), height: Math.round(area.height) }],
      levels: [current.id, ...to.map((l) => l.id)],
      flags: {
        [MODULE_ID]: {
          [STAIRS_FLAG]: {
            x: Math.round(area.x),
            y: Math.round(area.y),
            width: Math.round(area.width),
            height: Math.round(area.height),
            from: current.id,
            up: way === 'up' || way === 'both' ? above?.id : undefined,
            down: way === 'down' || way === 'both' ? below?.id : undefined,
          } satisfies Stairs,
        },
      },
    },
  ]);
  notify().info(loc('kaiserkram.alchemist.stairs.placed', 'Stairs placed. Tokens stepping onto them go to the other level.'));
}

/** Where a staircase is and what it links: the level it was drawn on, and the one above and/or below. */
type Stairs = { x: number; y: number; width: number; height: number; from: string; up?: string; down?: string };
const STAIRS_FLAG = 'stairs';

type TokenDoc = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  elevation: number;
  level?: string;
  parent: {
    grid: { size: number };
    regions: { contents: unknown[] };
    levels: { get(id: string): LevelLike | undefined };
  } | null;
  update(data: Record<string, unknown>): Promise<unknown>;
};

function centre(doc: TokenDoc): { x: number; y: number } {
  const size = doc.parent?.grid.size ?? 100;
  return { x: doc.x + (doc.width * size) / 2, y: doc.y + (doc.height * size) / 2 };
}

function inside(stairs: Stairs, p: { x: number; y: number }): boolean {
  return p.x >= stairs.x && p.x <= stairs.x + stairs.width && p.y >= stairs.y && p.y <= stairs.y + stairs.height;
}

/** Put `doc` on `levelId`, standing on its floor. */
async function moveToLevel(doc: TokenDoc, levelId: string): Promise<void> {
  const level = doc.parent?.levels.get(levelId);
  if (!level) return;
  await doc.update({ level: levelId, elevation: level.elevation.bottom ?? doc.elevation });
}

/** From the middle of stairs that go both ways: up or down? */
async function askWay(up: LevelLike, down: LevelLike): Promise<string | null> {
  const way = (await dialogV2().wait({
    window: { title: loc('kaiserkram.alchemist.stairs.title', 'Stairs'), icon: 'fa-solid fa-stairs' },
    content: '',
    rejectClose: false,
    buttons: [
      { action: up.id, label: `${loc('kaiserkram.alchemist.stairs.up', 'Up')}: ${up.name}`, icon: 'fa-solid fa-arrow-up', default: true },
      { action: down.id, label: `${loc('kaiserkram.alchemist.stairs.down', 'Down')}: ${down.name}`, icon: 'fa-solid fa-arrow-down' },
    ],
  })) as string | null;
  return way === up.id || way === down.id ? way : null;
}

/** Token centres before this client's own moves, to tell stepping onto stairs from moving on them. */
const before = new Map<string, { x: number; y: number }>();

function onPreUpdate(doc: TokenDoc, change: Record<string, unknown>, _options: unknown, userId: string): void {
  if (userId === game.user?.id && ('x' in change || 'y' in change)) before.set(doc.id, centre(doc));
}

function onUpdate(doc: TokenDoc, change: Record<string, unknown>, _options: unknown, userId: string): void {
  // Only the client that moved the token acts on it, so it happens once.
  if (userId !== game.user?.id) return;
  // Changed level some other way (Foundry's own behavior, the token config): stand on its floor.
  if ('level' in change && !('elevation' in change)) {
    const level = doc.level ? doc.parent?.levels.get(doc.level) : undefined;
    const bottom = level?.elevation.bottom;
    const top = level?.elevation.top;
    if (typeof bottom === 'number' && (doc.elevation < bottom || (typeof top === 'number' && doc.elevation >= top))) {
      void doc.update({ elevation: bottom });
    }
  }
  if (!('x' in change) && !('y' in change)) return;
  const was = before.get(doc.id);
  before.delete(doc.id);
  const now = centre(doc);
  for (const region of doc.parent?.regions.contents ?? []) {
    const stairs = flags(region).getFlag(MODULE_ID, STAIRS_FLAG) as Stairs | undefined;
    if (!stairs || !doc.level || ![stairs.from, stairs.up, stairs.down].includes(doc.level)) continue;
    // Stepping onto them, not moving about on them (or arriving on them from the other level).
    if (!inside(stairs, now) || (was && inside(stairs, was))) continue;
    void takeStairs(doc, stairs);
    return;
  }
}

async function takeStairs(doc: TokenDoc, stairs: Stairs): Promise<void> {
  let target: string | null | undefined;
  if (doc.level !== stairs.from) target = stairs.from;
  else if (stairs.up && stairs.down) {
    const up = doc.parent?.levels.get(stairs.up);
    const down = doc.parent?.levels.get(stairs.down);
    target = up && down ? await askWay(up, down) : (up ?? down)?.id;
  } else target = stairs.up ?? stairs.down;
  if (target) await moveToLevel(doc, target);
}

export function registerStairs(): void {
  on('preUpdateToken', onPreUpdate as (...args: never[]) => unknown);
  on('updateToken', onUpdate as (...args: never[]) => unknown);
}
