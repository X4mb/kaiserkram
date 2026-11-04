/**
 * Dungeon Alchemist's "Foundry VTT" export, one JSON per level (`Tower_00.json`, `Tower_01.json`…,
 * the image beside it under the same name), turned into the data for one Scene with a Level per
 * file. Pure data in, data out: no Foundry calls here, so it can be tested on its own.
 */

export type DaWall = { c: number[]; move?: number; sense?: number; sound?: number; door?: number };
export type DaLight = { x: number; y: number; dim?: number; bright?: number; tintColor?: string; tintAlpha?: number };
export type DaMap = {
  name?: string;
  width: number;
  height: number;
  grid: number;
  shiftX?: number;
  shiftY?: number;
  gridDistance?: number;
  gridUnits?: string;
  padding?: number;
  gridColor?: string;
  gridAlpha?: number;
  globalLight?: boolean;
  darkness?: number;
  lights?: DaLight[];
  walls?: DaWall[];
};

/**
 * One exported level: its number at the end of the file name, its data, and its picture. With
 * `outline`, `image` is the picture cut to that outline and `source` the uncut original (kept for
 * cutting again when the GM edits the outline).
 */
export type LevelFile = { number: number; map: DaMap; image: string | null; outline?: number[][]; source?: string | null };

/** The flag on an outline region: what it cuts, and from which original picture. */
export type Cutout = { source: string; target: 'level' | 'roof'; id: string };

export type BuildOptions = {
  sceneName: string;
  /** Which level the lowest-numbered file is (Dungeon Alchemist's lowest is often -1). */
  firstLevel: number;
  /** Height of one level, in the scene's distance units. */
  levelHeight: number;
  /** A fresh document id. */
  newId: () => string;
  /** The display name for level `n`; `roof` for a top level with nothing to walk into. */
  levelName: (n: number, roof: boolean) => string;
  /** Foundry's wall and light constants (passed in, so this file needs no globals). */
  constants: { senseNone: number; senseLimited: number; senseNormal: number; moveNone: number; moveNormal: number; fade: number };
  /**
   * The roof as an overhead picture on the ground floor that fades when a token goes under it,
   * instead of a level of its own: the cut roof picture, its outline and the uncut original.
   */
  roofTile?: { image: string; outline: number[][]; source: string } | null;
  /** Flag scope for the outline regions (the module id). */
  scope: string;
  /** Names for the outline regions. */
  outlineName: (level: string) => string;
  roofName: string;
};

export type BuiltScene = { data: Record<string, unknown>; levels: { id: string; name: string; level: number }[] };

/** "Untitled Map_03" → { prefix: "Untitled Map_", number: 3 }; null without a number at the end. */
export function splitName(base: string): { prefix: string; number: number } | null {
  const match = /^(.*?)(\d+)$/.exec(base);
  return match ? { prefix: match[1], number: Number(match[2]) } : null;
}

/** File name without folder and extension. */
export function baseName(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.[^.]+$/, '');
}

export function extensionOf(path: string): string {
  const match = /\.([^./]+)$/.exec(path);
  return match ? match[1].toLowerCase() : '';
}

const IMAGE_EXTENSIONS = ['webp', 'png', 'jpg', 'jpeg'];

export function isImage(path: string): boolean {
  return IMAGE_EXTENSIONS.includes(extensionOf(path));
}

/** A scene name from the file prefix: "Untitled Map_" → "Untitled Map". */
export function nameFromPrefix(prefix: string): string {
  return prefix.replace(/[\s_\-.]+$/, '') || prefix || 'Dungeon Alchemist';
}

/**
 * The files of one map: every `<prefix><number>.json` with the same prefix as `first`, each with
 * the image of the same name if there is one (webp preferred, then png, jpg). Sorted by number;
 * files numbered below `first` are left out (the first file is the bottom of the scene).
 */
export function filesOfMap<T extends { name: string }>(
  first: string,
  files: T[],
): { prefix: string; levels: { number: number; json: T; image: T | null }[] } | null {
  const start = splitName(baseName(first));
  if (!start) return null;
  const byNumber = new Map<number, { json?: T; images: T[] }>();
  for (const file of files) {
    const parts = splitName(baseName(file.name));
    if (!parts || parts.prefix !== start.prefix || parts.number < start.number) continue;
    const entry = byNumber.get(parts.number) ?? { images: [] };
    if (extensionOf(file.name) === 'json') entry.json = file;
    else if (isImage(file.name)) entry.images.push(file);
    byNumber.set(parts.number, entry);
  }
  const rank = (f: T) => IMAGE_EXTENSIONS.indexOf(extensionOf(f.name));
  const levels = [...byNumber.entries()]
    .filter((e): e is [number, { json: T; images: T[] }] => Boolean(e[1].json))
    .sort((a, b) => a[0] - b[0])
    .map(([number, e]) => ({ number, json: e.json, image: [...e.images].sort((a, b) => rank(a) - rank(b))[0] ?? null }));
  return { prefix: start.prefix, levels };
}

/** The top file of a building with nothing to walk into: the roof. */
export function isRoof(map: DaMap): boolean {
  return !map.walls?.length && !map.lights?.length;
}

/** Whether data read from a file looks like a Dungeon Alchemist map. */
export function isDaMap(data: unknown): data is DaMap {
  const d = data as Partial<DaMap> | null;
  return Boolean(d && typeof d === 'object' && Number(d.width) > 0 && Number(d.height) > 0 && Number(d.grid) > 0);
}

/** The scene, its levels, and every level's walls and lights, ready for `Scene.create`. */
export function buildScene(files: LevelFile[], options: BuildOptions): BuiltScene {
  const sorted = [...files].sort((a, b) => a.number - b.number);
  if (!sorted.length) throw new Error('no levels to import');
  const base = sorted[0].map;
  const firstNumber = sorted[0].number;
  const { senseNone, senseLimited, senseNormal, moveNone, moveNormal } = options.constants;
  // Dungeon Alchemist writes Foundry's old wall values: 0 none, 1 normal, 2 limited.
  const sense = (v: number | undefined) => (v === 1 ? senseNormal : v === 2 ? senseLimited : senseNone);

  const levels: BuiltScene['levels'] = [];
  const levelData: Record<string, unknown>[] = [];
  const walls: Record<string, unknown>[] = [];
  const lights: Record<string, unknown>[] = [];
  const regions: Record<string, unknown>[] = [];
  const tiles: Record<string, unknown>[] = [];

  const outlineRegion = (name: string, outline: number[][], level: string, cutout: Cutout) => ({
    name,
    color: '#4fc3f7',
    shapes: outline.map((points) => ({ type: 'polygon', points })),
    levels: [level],
    flags: { [options.scope]: { cutout } },
  });

  const roofIndex = sorted.length > 1 && isRoof(sorted.at(-1)!.map) ? sorted.length - 1 : -1;
  sorted.forEach((file, index) => {
    const n = options.firstLevel + (file.number - firstNumber);
    const bottom = n * options.levelHeight;
    const roof = index === roofIndex;
    // A roof shown as a fading picture over the ground floor isn't a level of its own.
    if (roof && options.roofTile) return;
    const id = options.newId();
    const name = options.levelName(n, roof);
    levels.push({ id, name, level: n });
    levelData.push({
      _id: id,
      name,
      elevation: { bottom, top: bottom + options.levelHeight },
      background: { src: file.image },
      // A floor cut to its walls shows the floors below around the building.
      visibility: { levels: file.outline ? levels.slice(0, -1).map((l) => l.id) : [] },
      sort: index,
    });
    if (file.outline && file.source) {
      regions.push(outlineRegion(options.outlineName(name), file.outline, id, { source: file.source, target: 'level', id }));
    }
    for (const w of file.map.walls ?? []) {
      if (!Array.isArray(w.c) || w.c.length !== 4) continue;
      const [x0, y0, x1, y1] = w.c.map((v) => Math.round(Number(v)));
      if (x0 === x1 && y0 === y1) continue; // zero-length joints add nothing
      walls.push({
        c: [x0, y0, x1, y1],
        levels: [id],
        move: w.move ? moveNormal : moveNone,
        sight: sense(w.sense),
        light: sense(w.sense),
        sound: w.sound ? senseNormal : senseNone,
        door: Number(w.door) || 0,
      });
    }
    for (const l of file.map.lights ?? []) {
      lights.push({
        x: Math.round(l.x),
        y: Math.round(l.y),
        elevation: bottom,
        levels: [id],
        config: {
          dim: Number(l.dim) || 0,
          bright: Number(l.bright) || 0,
          color: l.tintColor ?? null,
          alpha: Number(l.tintAlpha) || 0,
        },
      });
    }
  });

  // Open on the ground floor (level 0) if there is one, else on the bottom level.
  const initial = levels.find((l) => l.level === 0) ?? levels[0];

  if (options.roofTile && roofIndex >= 0) {
    const ground = levelData.find((l) => l._id === initial.id) as { elevation: { bottom: number; top: number } };
    const tileId = options.newId();
    tiles.push({
      _id: tileId,
      texture: { src: options.roofTile.image },
      x: 0,
      y: 0,
      width: base.width,
      height: base.height,
      // Above the ground floor's tokens, so it covers them from outside and fades over them.
      elevation: ground.elevation.top,
      levels: [initial.id],
      occlusion: { modes: [options.constants.fade], alpha: 0 },
    });
    regions.push(
      outlineRegion(options.roofName, options.roofTile.outline, initial.id, { source: options.roofTile.source, target: 'roof', id: tileId }),
    );
  }
  return {
    levels,
    data: {
      name: options.sceneName,
      width: base.width,
      height: base.height,
      padding: Number(base.padding) || 0,
      shiftX: Number(base.shiftX) || 0,
      shiftY: Number(base.shiftY) || 0,
      grid: {
        size: base.grid,
        distance: Number(base.gridDistance) || 5,
        units: base.gridUnits ?? 'ft',
        color: base.gridColor ?? '#000000',
        alpha: base.gridAlpha ?? 0.2,
      },
      environment: { globalLight: { enabled: Boolean(base.globalLight) }, darknessLevel: Number(base.darkness) || 0 },
      initialLevel: initial.id,
      levels: levelData,
      walls,
      lights,
      regions,
      tiles,
    },
  };
}
