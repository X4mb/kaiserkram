import { MODULE_ID } from '../../core/constants.js';
import { dialogV2, escapeHtml, notify, settings } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { buildScene, filesOfMap, isDaMap, nameFromPrefix, type DaMap, type LevelFile } from './build.js';
import { SETTINGS } from './settings.js';

/**
 * The import window: where the export is (a folder on this computer, uploaded on import, or
 * files already in Foundry), which file is the bottom level and which level that is, and how
 * high a level is. Then one Scene with a Level per file.
 */

type Picker = {
  browse(source: string, target: string, options?: Record<string, unknown>): Promise<{ files: string[]; target: string }>;
  upload(source: string, path: string, file: File, body?: unknown, options?: Record<string, unknown>): Promise<{ path?: string } | false | void>;
  createDirectory(source: string, target: string, options?: Record<string, unknown>): Promise<unknown>;
};
type PickerCtor = (new (options: Record<string, unknown>) => { render(force?: boolean): unknown }) & Picker;

function filePicker(): PickerCtor {
  return (foundry.applications as unknown as { apps: { FilePicker: { implementation: PickerCtor } } }).apps.FilePicker.implementation;
}

function route(path: string): string {
  const getRoute = (foundry.utils as unknown as { getRoute?(p: string): string }).getRoute;
  return getRoute ? getRoute(path) : `/${path}`;
}

/** Foundry may hand back paths with spaces as %20; names are compared decoded. */
function decoded(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function folderOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : '';
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
  };
  const sense = C.EDGE_SENSE_TYPES ?? C.WALL_SENSE_TYPES ?? {};
  return {
    senseNone: sense.NONE ?? 0,
    senseLimited: sense.LIMITED ?? 10,
    senseNormal: sense.NORMAL ?? 20,
    moveNone: C.WALL_MOVEMENT_TYPES.NONE ?? 0,
    moveNormal: C.WALL_MOVEMENT_TYPES.NORMAL ?? 20,
  };
}

/** Make `path` (and its parents) under the user data folder; existing folders are fine. */
async function ensureFolder(path: string): Promise<void> {
  let current = '';
  for (const part of path.split('/')) {
    current = current ? `${current}/${part}` : part;
    try {
      await filePicker().createDirectory('data', current, { notify: false });
    } catch {
      // Already there (or not ours to make): the upload says so if it really can't go there.
    }
  }
}

type Options = { sceneName: string; firstLevel: number; levelHeight: number };

async function createScene(files: LevelFile[], options: Options): Promise<void> {
  const built = buildScene(files, {
    ...options,
    newId: () => foundry.utils.randomID(16),
    levelName,
    constants: constants(),
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
  const files: LevelFile[] = [];
  for (const level of map.levels) {
    const response = await fetch(route(level.json.path), { cache: 'no-store' });
    if (!response.ok) throw new Error(`could not read ${level.json.name} (${response.status})`);
    files.push({ number: level.number, map: await readJson(response.text(), level.json.name), image: level.image?.path ?? null });
  }
  await createScene(files, options);
}

/** The export is on this computer: upload its images into the world, then build the scene. */
async function importFromComputer(all: File[], first: string, options: Options): Promise<void> {
  const map = filesOfMap(first, all);
  if (!map?.levels.length) throw new Error(`no level files found next to ${first}`);
  const world = (game as unknown as { world: { id: string } }).world.id;
  const target = `worlds/${world}/${MODULE_ID}/dungeon-alchemist/${slug(options.sceneName)}`;
  await ensureFolder(target);
  const files: LevelFile[] = [];
  for (const level of map.levels) {
    let image: string | null = null;
    if (level.image) {
      const result = await filePicker().upload('data', target, level.image, {}, { notify: false });
      image = (result && result.path) || `${target}/${level.image.name}`;
    }
    files.push({ number: level.number, map: await readJson(level.json.text(), level.json.name), image });
  }
  await createScene(files, options);
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
      <label>${t('kaiserkram.alchemist.sceneName', 'Scene name')}</label>
      <div class="form-fields"><input type="text" name="sceneName" /></div>
    </div>
    <p class="hint" data-summary></p>
  </div>`;
}

type Choice = { source: string; first: string; path: string; firstLevel: number; levelHeight: number; sceneName: string };

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
