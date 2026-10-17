import { MODULE_ID } from '../../core/constants.js';
import { expandObject, flags } from '../../core/foundryApi.js';
import { FLAGS } from './constants.js';
import { actorTokenSource, foldersOf, tokenCreator } from './views.js';
import { DEPLOY_LAYOUTS, getDeployLayout, getSpacing } from './settings.js';

export function collectActorsInFolder(folder: Folder, recursive: boolean): Actor[] {
  const actors = [...(folder.contents as Actor[])];
  if (recursive) {
    for (const sub of foldersOf(folder).getSubfolders(true)) {
      actors.push(...(sub.contents as Actor[]));
    }
  }
  // The actors behind party markers are never deployed themselves.
  return actors.filter((a) => !flags(a).getFlag(MODULE_ID, FLAGS.MARKER_ACTOR_FOR));
}

type Offset = { col: number; row: number };

/** Lay `count` items out in a square-ish grid centered on the origin, in grid-cell units. */
function computeGridOffsets(count: number): Offset[] {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  const offsets: Offset[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    offsets.push({ col: col - (columns - 1) / 2, row: row - (rows - 1) / 2 });
  }
  return offsets;
}

/** Lay `count` items out in a single horizontal row centered on the origin. */
function computeLineOffsets(count: number): Offset[] {
  return Array.from({ length: count }, (_, i) => ({ col: i - (count - 1) / 2, row: 0 }));
}

/** Lay `count` items out evenly spaced around a ring, radius scaled so neighbors stay ~1 cell apart. */
function computeCircleOffsets(count: number): Offset[] {
  if (count <= 1) return [{ col: 0, row: 0 }];
  const radius = count / (2 * Math.PI);
  return Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2;
    return { col: radius * Math.cos(angle), row: radius * Math.sin(angle) };
  });
}

/** Grid layout with a bit of random jitter per token, for a looser, less mechanical look. */
function computeScatterOffsets(count: number): Offset[] {
  return computeGridOffsets(count).map(({ col, row }) => ({
    col: col + (Math.random() - 0.5) * 0.6,
    row: row + (Math.random() - 0.5) * 0.6,
  }));
}

function computeOffsets(count: number, layout: string): Offset[] {
  switch (layout) {
    case DEPLOY_LAYOUTS.LINE:
      return computeLineOffsets(count);
    case DEPLOY_LAYOUTS.CIRCLE:
      return computeCircleOffsets(count);
    case DEPLOY_LAYOUTS.SCATTER:
      return computeScatterOffsets(count);
    default:
      return computeGridOffsets(count);
  }
}

export interface SpawnActorsOptions {
  hidden?: boolean;
  /** Per-token flags, keyed by dotted path under flags.kaiserkram (e.g. `party.deployBatchId`). */
  extraFlags?: (actor: Actor, index: number) => Record<string, unknown> | undefined;
}

/** Creates one token per actor, laid out around `center` per the configured deploy layout. */
export async function spawnActorsAround(
  scene: Scene,
  actors: Actor[],
  center: { x: number; y: number },
  options: SpawnActorsOptions = {},
): Promise<void> {
  const grid = scene.grid as unknown as { size: number };
  const gridSize = grid.size;
  const spacing = getSpacing();
  const offsets = computeOffsets(actors.length, getDeployLayout());

  const tokenDataList: Record<string, unknown>[] = [];
  for (let i = 0; i < actors.length; i++) {
    const actor = actors[i];
    const offset = offsets[i];
    const targetX = center.x + offset.col * gridSize * spacing;
    const targetY = center.y + offset.row * gridSize * spacing;

    const td = await actorTokenSource(actor).getTokenDocument({ hidden: options.hidden ?? false }, { parent: scene });

    const data = td.toObject() as Record<string, unknown>;
    const width = Number(data.width ?? 1);
    const height = Number(data.height ?? 1);
    data.x = targetX - (width * gridSize) / 2;
    data.y = targetY - (height * gridSize) / 2;

    const extra = options.extraFlags?.(actor, i);
    if (extra) {
      const own = expandObject(extra);
      const existing = (data.flags ?? {}) as Record<string, Record<string, unknown> | undefined>;
      data.flags = { ...existing, [MODULE_ID]: { ...existing[MODULE_ID], ...own } };
    }
    tokenDataList.push(data);
  }

  await tokenCreator(scene).createEmbeddedDocuments('Token', tokenDataList);
}
