import { MODULE_ID } from '../../core/constants.js';
import { expandObject } from '../../core/foundryApi.js';
import { actorTokenSource, foldersOf, tokenCreator } from './views.js';
import { getSpacing } from './settings.js';

export function collectActorsInFolder(folder: Folder, recursive: boolean): Actor[] {
  const actors = [...(folder.contents as Actor[])];
  if (recursive) {
    for (const sub of foldersOf(folder).getSubfolders(true)) {
      actors.push(...(sub.contents as Actor[]));
    }
  }
  return actors;
}

/** Lay `count` items out in a square-ish grid centered on the origin, in grid-cell units. */
function computeGridOffsets(count: number): Array<{ col: number; row: number }> {
  const columns = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  const offsets: Array<{ col: number; row: number }> = [];
  for (let i = 0; i < count; i++) {
    const col = i % columns;
    const row = Math.floor(i / columns);
    offsets.push({ col: col - (columns - 1) / 2, row: row - (rows - 1) / 2 });
  }
  return offsets;
}

export interface SpawnActorsOptions {
  hidden?: boolean;
  /** Per-token flags, keyed by dotted path under flags.kaiserkram (e.g. `party.deployBatchId`). */
  extraFlags?: (actor: Actor, index: number) => Record<string, unknown> | undefined;
}

/** Creates one token per actor, laid out in a grid centered on `center`. */
export async function spawnActorsAround(
  scene: Scene,
  actors: Actor[],
  center: { x: number; y: number },
  options: SpawnActorsOptions = {},
): Promise<void> {
  const grid = scene.grid as unknown as { size: number };
  const gridSize = grid.size;
  const spacing = getSpacing();
  const offsets = computeGridOffsets(actors.length);

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
