import { MODULE_ID } from '../../core/constants.js';
import { dialogV2, escapeHtml, notify, settings } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { buildScene, filesOfMap, isDaMap, isRoof, nameFromPrefix, type BuildOptions, type DaMap, type LevelFile } from './build.js';
import { cutPicture, ensureFolder, filePicker, folderOf, route, upload } from './files.js';
import { outlineFromWalls } from './outline.js';
import { SETTINGS } from './settings.js';

/**
 * The import window: where the export is (a folder on this computer, uploaded on import, or
 * files already in Foundry), which file is the bottom level and which level that is, and how
 * high a level is. Then one Scene with a Level per file.
 */

/** Foundry may hand back paths with spaces as %20; names are compared decoded. */
function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'map';
}

function levelName(n: number, roof: boolean): string {
  if (roof) return loc('kaiserkram.alchemist.level.roof', 'Roof');
  if (n === 0) return loc('kaiserkram.alchemist.level.ground', 'Ground floor');
  if (n < 0) return fmt('kaiserkram.alchemist.level.below', 'Basement {n}', { n: -n });
  return fmt('kaiserkram.alchemist.level.above', 'Floor {n}', { n });
}

function constants() {
  const C = CONST as unknown as {
    EDGE_SENSE_TYPES?: Record<string, number>;
    WALL_SENSE_TYPES?: Record<string, number>;
    WALL_MOVEMENT_TYPES: Record<string, number>;
    OCCLUSION_MODES?: Record<string, number>;
  };
  const sense = C.EDGE_SENSE_TYPES ?? C.WALL_SENSE_TYPES ?? {};
  return {
    senseNone: sense.NONE ?? 0,
    senseLimited: sense.LIMITED ?? 10,
    senseNormal: sense.NORMAL ?? 20,
    moveNone: C.WALL_MOVEMENT_TYPES.NONE ?? 0,
    moveNormal: C.WALL_MOVEMENT_TYPES.NORMAL ?? 20,
    fade: C.OCCLUSION_MODES?.FADE ?? 1,
  };
}

type Options = { sceneName: string; firstLevel: number; levelHeight: number; cut: boolean };

/** One level as read: its data, its picture's path in Foundry, and the picture itself if it came from this computer. */
type Source = { number: number; map: DaMap; image: string | null; blob?: Blob };

/** Where this import puts its uploads: the pictures, and the cut copies. */
function uploadFolder(sceneName: string): string {
  const world = (game as unknown as { world: { id: string } }).world.id;
  return `${world ? `worlds/${world}` : 'kaiserkram'}/${MODULE_ID}/dungeon-alchemist/${slug(sceneName)}`;
}

/** Name of the cut copy of `image`: "Tower_02.webp" → "Tower_02-cut-<stamp>.webp". */
export function cutName(image: string): string {
  const base = (decoded(image).split('/').pop() ?? 'level').replace(/\.[^.]+$/, '');
  return `${base}-cut-${Date.now().toString(36)}.webp`;
}

/** Cut `source`'s picture to `outline` and upload it; its new path. */
export async function uploadCut(folder: string, picture: string | Blob, name: string, size: { width: number; height: number }, outline: number[][]): Promise<string> {
  const blob = await cutPicture(picture, size.width, size.height, outline);
  return upload(folder, new File([blob], name, { type: 'image/webp' }));
}

function outlineOf(map: DaMap): number[][] {
  const cell = Math.max(5, Math.round(map.grid / 5));
  return outlineFromWalls(
    map.width,
    map.height,
    (map.walls ?? []).filter((w) => Array.isArray(w.c) && w.c.length === 4).map((w) => w.c),
    // About half a square of margin around the walls; posts under two squares alone are dropped.
    { cell, grow: 2, minCells: 50 },
  );
}

/**
 * The levels above the ground floor cut to their walls, and the roof to the floor below it, so
 * the floors underneath show around the building. Ground floor and cellars keep their whole
 * picture.
 */
async function cutFloors(sources: Source[], options: Options, folder: string): Promise<{ files: LevelFile[]; roof: BuildOptions['roofTile'] }> {
  const sorted = [...sources].sort((a, b) => a.number - b.number);
  const files: LevelFile[] = sorted.map((s) => ({ number: s.number, map: s.map, image: s.image }));
  if (!options.cut) return { files, roof: null };
  const firstNumber = sorted[0].number;
  const levelOf = (s: Source) => options.firstLevel + (s.number - firstNumber);
  // The ground floor: level 0, or the bottom level if the map has none.
  const groundNumber = (sorted.find((s) => levelOf(s) === 0) ?? sorted[0]).number;
  const roofIndex = sorted.length > 1 && isRoof(sorted.at(-1)!.map) ? sorted.length - 1 : -1;
  let lastOutline: number[][] | null = null;
  for (const [i, s] of sorted.entries()) {
    if (s.number <= groundNumber || i === roofIndex || !s.image || !s.map.walls?.length) continue;
    const outline = outlineOf(s.map);
    if (!outline.length) continue;
    lastOutline = outline;
    files[i].source = s.image;
    files[i].outline = outline;
    files[i].image = await uploadCut(folder, s.blob ?? s.image, cutName(s.image), s.map, outline);
  }
  let roof: BuildOptions['roofTile'] = null;
  const top = roofIndex >= 0 ? sorted[roofIndex] : null;
  // The roof follows the highest floor's walls (or the ground floor's in a one-storey house).
  const roofOutline = lastOutline ?? outlineOf(sorted.find((s) => s.number === groundNumber)!.map);
  if (top?.image && roofOutline.length) {
    roof = { image: await uploadCut(folder, top.blob ?? top.image, cutName(top.image), top.map, roofOutline), outline: roofOutline, source: top.image };
  }
  return { files, roof };
}

async function createScene(sources: Source[], options: Options, folder: string): Promise<void> {
  const { files, roof } = await cutFloors(sources, options, folder);
  const built = buildScene(files, {
    ...options,
    newId: () => foundry.utils.randomID(16),
    levelName,
    constants: constants(),
    roofTile: roof,
    scope: MODULE_ID,
    outlineName: (level) => fmt('kaiserkram.alchemist.outlineName', 'Visible area: {level}', { level }),
    roofName: loc('kaiserkram.alchemist.roofName', 'Roof area'),
  });
  const Scene = (CONFIG as unknown as { Scene: { documentClass: { create(d: unknown): Promise<{ name: string } | undefined> } } })
    .Scene.documentClass;
  const scene = await Scene.create(built.data);
  if (!scene) throw new Error('Foundry did not create the scene');
  const missing = files.filter((f) => !f.image).length;
  notify().info(
    fmt('kaiserkram.alchemist.done', 'Imported {name} with {count} levels.', { name: scene.name, count: built.levels.length }),
  );
  if (missing) {
    notify().warn(
      fmt('kaiserkram.alchemist.noImage', '{count} level(s) had no image beside their JSON file and have no background.', { count: missing }),
    );
  }
}

async function readJson(text: Promise<string>, label: string): Promise<DaMap> {
  const data: unknown = JSON.parse(await text);
  if (!isDaMap(data)) throw new Error(`${label} is not a Dungeon Alchemist map`);
  return data;
}

/** The export is already in Foundry: `first` is the path of the bottom level's JSON file. */
async function importFromFoundry(first: string, options: Options): Promise<void> {
  const listing = await filePicker().browse('data', folderOf(decoded(first)));
  // Match on readable names ("Untitled Map_00"), load from the paths Foundry gave.
  const map = filesOfMap(decoded(first), listing.files.map((path) => ({ name: decoded(path), path })));
  if (!map?.levels.length) throw new Error(`no level files found next to ${first}`);
  const sources: Source[] = [];
  for (const level of map.levels) {
    const response = await fetch(route(level.json.path), { cache: 'no-store' });
    if (!response.ok) throw new Error(`could not read ${level.json.name} (${response.status})`);
    sources.push({ number: level.number, map: await readJson(response.text(), level.json.name), image: level.image?.path ?? null });
  }
  const folder = uploadFolder(options.sceneName);
  if (options.cut) await ensureFolder(folder);
  await createScene(sources, options, folder);
}

/** The export is on this computer: upload its images into the world, then build the scene. */
async function importFromComputer(all: File[], first: string, options: Options): Promise<void> {
  const map = filesOfMap(first, all);
  if (!map?.levels.length) throw new Error(`no level files found next to ${first}`);
  const folder = uploadFolder(options.sceneName);
  await ensureFolder(folder);
  const sources: Source[] = [];
  for (const level of map.levels) {
    const image = level.image ? await upload(folder, level.image) : null;
    sources.push({ number: level.number, map: await readJson(level.json.text(), level.json.name), image, blob: level.image ?? undefined });
  }
  await createScene(sources, options, folder);
}

function render(levelHeight: number, firstLevel: number): string {
  const t = (key: string, fallback: string) => escapeHtml(loc(key, fallback));
  return `<div class="kk-alchemist">
    <p class="hint">${t('kaiserkram.alchemist.intro', 'Pick the lowest level of the export (e.g. Tower_00). Every file with the same name and a higher number becomes a level above it.')}</p>
    <div class="form-group">
      <label>${t('kaiserkram.alchemist.source', 'Files')}</label>
      <div class="form-fields">
        <label><input type="radio" name="source" value="computer" checked /> ${t('kaiserkram.alchemist.fromComputer', 'On this computer')}</label>
        <label><input type="radio" name="source" value="foundry" /> ${t('kaiserkram.alchemist.fromFoundry', 'Already in Foundry')}</label>
      </div>
    </div>
    <div class="form-group" data-for="computer">
      <label>${t('kaiserkram.alchemist.folder', 'Export folder')}</label>
      <div class="form-fields"><input type="file" name="folder" webkitdirectory multiple /></div>
    </div>
    <div class="form-group" data-for="computer">
      <label>${t('kaiserkram.alchemist.first', 'Lowest level file')}</label>
      <div class="form-fields"><select name="first"></select></div>
    </div>
    <div class="form-group" data-for="foundry" hidden>
      <label>${t('kaiserkram.alchemist.first', 'Lowest level file')}</label>
      <div class="form-fields">
        <input type="text" name="path" placeholder="worlds/…/Tower_00.json" />
        <button type="button" data-browse><i class="fa-solid fa-folder-open"></i></button>
      </div>
    </div>
    <div class="form-group">
      <label>${t('kaiserkram.alchemist.firstLevel', 'That file is level')}</label>
      <div class="form-fields"><input type="number" name="firstLevel" step="1" value="${firstLevel}" /></div>
      <p class="hint">${t('kaiserkram.alchemist.firstLevelHint', '0 is the ground floor, -1 the first level below it.')}</p>
    </div>
    <div class="form-group">
      <label>${t('kaiserkram.alchemist.height', 'Height per level')}</label>
      <div class="form-fields"><input type="number" name="levelHeight" min="1" step="any" value="${levelHeight}" /></div>
    </div>
    <div class="form-group">
      <label>${t('kaiserkram.alchemist.cut', 'See-through upper floors')}</label>
      <div class="form-fields"><input type="checkbox" name="cut" checked /></div>
      <p class="hint">${t('kaiserkram.alchemist.cutHint', 'Floors above the ground floor are cut to their walls so the floors below show around the building, and the roof fades when a token goes under it. Each cut follows a region you can edit (add a balcony, say); the picture is cut again when you change it.')}</p>
    </div>
    <div class="form-group">
      <label>${t('kaiserkram.alchemist.sceneName', 'Scene name')}</label>
      <div class="form-fields"><input type="text" name="sceneName" /></div>
    </div>
    <p class="hint" data-summary></p>
  </div>`;
}

type Choice = { source: string; first: string; path: string; firstLevel: number; levelHeight: number; sceneName: string; cut: boolean };

/** GM: ask for the export and its levels, then import it. */
export async function openImport(): Promise<void> {
  if (!game.user?.isGM) return;
  let picked: File[] = [];
  const levelHeight = Number(settings().get(MODULE_ID, SETTINGS.LEVEL_HEIGHT)) || 10;
  const firstLevel = Number(settings().get(MODULE_ID, SETTINGS.FIRST_LEVEL)) || 0;

  const choice = (await dialogV2().wait({
    window: { title: loc('kaiserkram.alchemist.title', 'Import from Dungeon Alchemist'), icon: 'fa-solid fa-flask' },
    position: { width: 520 },
    content: render(levelHeight, firstLevel),
    rejectClose: false,
    render: (_event: unknown, dialog: { element: HTMLElement }) => {
      const root = dialog.element;
      const q = <T extends Element>(sel: string) => root.querySelector<T>(sel);
      const name = q<HTMLInputElement>('input[name="sceneName"]');
      const summary = q<HTMLElement>('[data-summary]');
      const firstSelect = q<HTMLSelectElement>('select[name="first"]');
      const pathInput = q<HTMLInputElement>('input[name="path"]');
      let named = false;
      name?.addEventListener('input', () => (named = true));

      const update = () => {
        const source = q<HTMLInputElement>('input[name="source"]:checked')?.value ?? 'computer';
        root.querySelectorAll<HTMLElement>('[data-for]').forEach((el) => (el.hidden = el.dataset.for !== source));
        const first = source === 'computer' ? (firstSelect?.value ?? '') : (pathInput?.value ?? '');
        const map = source === 'computer' && first ? filesOfMap(first, picked) : null;
        const parts = first ? filesOfMap(first, [{ name: first }]) : null;
        if (parts && name && !named) name.value = nameFromPrefix(parts.prefix.split('/').pop() ?? parts.prefix);
        if (!summary) return;
        if (map) {
          const start = Number(q<HTMLInputElement>('input[name="firstLevel"]')?.value) || 0;
          const last = start + (map.levels.at(-1)!.number - map.levels[0].number);
          summary.textContent = fmt('kaiserkram.alchemist.summary', '{count} level files: levels {from} to {to}.', {
            count: map.levels.length,
            from: start,
            to: last,
          });
        } else summary.textContent = '';
      };

      q<HTMLInputElement>('input[name="folder"]')?.addEventListener('change', (ev) => {
        picked = Array.from((ev.currentTarget as HTMLInputElement).files ?? []);
        const jsons = picked.filter((f) => f.name.toLowerCase().endsWith('.json')).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
        if (firstSelect) {
          firstSelect.innerHTML = jsons.map((f) => `<option value="${escapeHtml(f.name)}">${escapeHtml(f.name)}</option>`).join('');
        }
        update();
      });
      q('[data-browse]')?.addEventListener('click', () => {
        new (filePicker())({
          type: 'any',
          current: pathInput?.value || '',
          callback: (path: string) => {
            if (pathInput) pathInput.value = path;
            update();
          },
        }).render(true);
      });
      root.querySelectorAll('input, select').forEach((el) => el.addEventListener('change', update));
      pathInput?.addEventListener('input', update);
      update();
    },
    buttons: [
      {
        action: 'import',
        label: loc('kaiserkram.alchemist.import', 'Import'),
        icon: 'fa-solid fa-file-import',
        default: true,
        callback: (_event: unknown, button: { form: HTMLFormElement }): Choice => {
          const f = button.form.elements as unknown as Record<string, HTMLInputElement>;
          const source = (button.form.querySelector<HTMLInputElement>('input[name="source"]:checked')?.value ?? 'computer');
          return {
            source,
            first: f.first?.value ?? '',
            path: f.path?.value.trim() ?? '',
            firstLevel: Math.round(Number(f.firstLevel?.value) || 0),
            levelHeight: Number(f.levelHeight?.value) > 0 ? Number(f.levelHeight.value) : levelHeight,
            sceneName: f.sceneName?.value.trim() ?? '',
            cut: Boolean(f.cut?.checked),
          };
        },
      },
      { action: 'cancel', label: loc('kaiserkram.alchemist.cancel', 'Cancel') },
    ],
  })) as Choice | string | null;
  if (!choice || typeof choice !== 'object') return;

  const first = choice.source === 'computer' ? choice.first : choice.path;
  if (!first) {
    notify().warn(loc('kaiserkram.alchemist.pickFirst', 'Pick the lowest level file first.'));
    return;
  }
  const prefix = filesOfMap(first, [{ name: first }])?.prefix;
  if (prefix === undefined) {
    notify().warn(loc('kaiserkram.alchemist.noNumber', 'That file name has no level number at the end (like Tower_00).'));
    return;
  }
  const options: Options = {
    sceneName: choice.sceneName || nameFromPrefix(prefix.split('/').pop() ?? prefix),
    firstLevel: choice.firstLevel,
    levelHeight: choice.levelHeight,
    cut: choice.cut,
  };
  await settings().set(MODULE_ID, SETTINGS.FIRST_LEVEL, options.firstLevel);
  notify().info(loc('kaiserkram.alchemist.working', 'Importing… this can take a moment for large maps.'));
  try {
    if (choice.source === 'computer') await importFromComputer(picked, first, options);
    else await importFromFoundry(first, options);
  } catch (err) {
    console.error('[kaiserkram] alchemist: import failed', err);
    notify().error(fmt('kaiserkram.alchemist.failed', 'The import failed: {error}', { error: (err as Error).message ?? String(err) }));
  }
}
