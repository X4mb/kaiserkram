import { MODULE_ID } from '../../core/constants.js';
import { dialogV2, notify } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';

/**
 * Stairs in two steps: the GM drags a box over a staircase on the level they are viewing, then
 * picks Up, Down or Both. That becomes a Region on those levels with Foundry's own Change Level
 * behavior, which offers tokens stepping in the move to the other level.
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

/** Every way a token moves (walk, fly, climb…), so any of them on the stairs offers the change. */
function movementActions(): string[] {
  const actions = (CONFIG as unknown as { Token?: { movement?: { actions?: Record<string, unknown> } } }).Token?.movement?.actions;
  // `displace` (being pushed) never triggers a level change.
  return Object.keys(actions ?? {}).filter((a) => a !== 'displace');
}

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
      behaviors: [{ type: 'changeLevel', name, system: { movementActions: movementActions() } }],
    },
  ]);
  notify().info(loc('kaiserkram.alchemist.stairs.placed', 'Stairs placed. Tokens stepping onto them are offered the other level.'));
}
