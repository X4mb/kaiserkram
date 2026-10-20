import { MODULE_ID, MODULE_PATH } from '../../core/constants.js';
import type { Feature } from '../../core/feature.js';
import { contextEntry, notify, on, settings, toElement } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';

export const SETTINGS = {
  DEFAULT_SCENE: 'landingDefaultSceneId',
  /** Kept for worlds migrated from the old module; no longer read. */
  LAST_BOOT: 'landingLastBootEpoch',
  /** Server uptime when a GM last checked in, in whatever unit the server reports it. */
  LAST_UPTIME: 'landingLastUptime',
  /** Shown read-only in Configure Settings (filled in on render), never written. */
  DEFAULT_SCENE_INFO: 'landingDefaultSceneInfo',
} as const;

const BADGE_CLASS = `${MODULE_ID}-landing-default`;

type SceneLike = { id: string; name: string; activate(): Promise<unknown>; view(): Promise<unknown> };
type ScenesView = { get(id: string): SceneLike | undefined; active?: SceneLike | null };

function rerenderSceneDirectory(): void {
  (ui as unknown as { scenes?: { render(): unknown } }).scenes?.render();
}

function scenes(): ScenesView {
  return game.scenes as unknown as ScenesView;
}

function log(...args: unknown[]): void {
  console.log(`${MODULE_ID} | landing |`, ...args);
}

function defaultSceneId(): string {
  return String(settings().get(MODULE_ID, SETTINGS.DEFAULT_SCENE) ?? '');
}

function getSceneIdFromRow(li: HTMLElement): string | null {
  const row = li.closest<HTMLElement>('[data-document-id], [data-entry-id], [data-scene-id]') ?? li;
  return row.dataset.documentId ?? row.dataset.entryId ?? row.dataset.sceneId ?? null;
}

function isDefaultScene(li: HTMLElement): boolean {
  const sceneId = getSceneIdFromRow(li);
  return !!sceneId && sceneId === defaultSceneId();
}

async function setDefaultScene(li: HTMLElement): Promise<void> {
  const sceneId = getSceneIdFromRow(li);
  if (!sceneId) return;
  await settings().set(MODULE_ID, SETTINGS.DEFAULT_SCENE, sceneId);
  const scene = scenes().get(sceneId);
  notify().info(
    fmt('kaiserkram.landing.SetNotification', '{name} will now load automatically when the world starts.', {
      name: scene?.name ?? sceneId,
    }),
  );
  rerenderSceneDirectory();
}

async function clearDefaultScene(): Promise<void> {
  await settings().set(MODULE_ID, SETTINGS.DEFAULT_SCENE, '');
  notify().info(loc('kaiserkram.landing.UnsetNotification', 'Default landing scene cleared.'));
  rerenderSceneDirectory();
}

/** Mark the landing scene in the Scenes directory. */
function markDefaultScene(_app: unknown, html: unknown): void {
  const sceneId = defaultSceneId();
  const rows = toElement(html)?.querySelectorAll<HTMLElement>('[data-document-id], [data-entry-id], [data-scene-id]') ?? [];
  for (const li of rows) li.classList.toggle(BADGE_CLASS, !!sceneId && getSceneIdFromRow(li) === sceneId);
}

/** Fill in the read-only "current default scene" line in Configure Settings. */
function showDefaultSceneInSettings(_app: unknown, html: unknown): void {
  const input = toElement(html)?.querySelector<HTMLInputElement>(`[name="${MODULE_ID}.${SETTINGS.DEFAULT_SCENE_INFO}"]`);
  if (!input) return;
  const id = defaultSceneId();
  input.value = (id && scenes().get(id)?.name) || loc('kaiserkram.landing.NoDefaultScene', 'None set');
  input.disabled = true;
}

function addSceneContextOptions(_application: unknown, options: Record<string, unknown>[]): void {
  options.push(
    contextEntry({
      label: loc('kaiserkram.landing.ContextSet', 'Set as Default Scene'),
      icon: '<i class="fa-solid fa-house"></i>',
      visible: (li) => Boolean(game.user?.isGM) && !isDefaultScene(li),
      onClick: (li) => setDefaultScene(li),
    }),
    contextEntry({
      label: loc('kaiserkram.landing.ContextUnset', 'Unset Default Scene'),
      icon: '<i class="fa-solid fa-house-circle-check"></i>',
      visible: (li) => Boolean(game.user?.isGM) && isDefaultScene(li),
      onClick: () => clearDefaultScene(),
    }),
  );
}

/** The server's uptime from Foundry's own /api/status route, or null if it can't be read. */
async function serverUptime(): Promise<number | null> {
  try {
    // getRoute honours a configured route prefix (e.g. https://host/foundry/api/status).
    const getRoute = (foundry.utils as unknown as { getRoute?(path: string): string }).getRoute;
    const response = await fetch(getRoute ? getRoute('api/status') : `${window.location.origin}/api/status`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`status endpoint returned ${response.status}`);
    const data = (await response.json()) as { uptime?: unknown };
    if (typeof data.uptime !== 'number') throw new Error('status endpoint had no uptime field');
    return data.uptime;
  } catch (err) {
    log('could not read server uptime:', err);
    return null;
  }
}

/**
 * Whether the world restarted since a GM last checked in. There is no hook for "the world just
 * booted", but the server's uptime only grows until it restarts: if it is lower than what the
 * last GM saw, it restarted in between. (Comparing uptimes, not clock times, needs neither
 * synced clocks nor knowing the unit.) Unknown uptime counts as no restart, so a GM rejoining
 * never pulls everyone back by mistake.
 */
function restartedSince(uptime: number | null): boolean {
  if (uptime === null) return false;
  const last = Number(settings().get(MODULE_ID, SETTINGS.LAST_UPTIME));
  return !Number.isFinite(last) || last <= 0 || uptime < last;
}

async function landingScene(): Promise<SceneLike | null> {
  const sceneId = defaultSceneId();
  if (!sceneId) return null;
  const scene = scenes().get(sceneId);
  if (!scene) log(`configured default scene "${sceneId}" no longer exists`);
  return scene ?? null;
}

/**
 * GM: on the first GM visit after a restart, make the landing scene active for everyone, and
 * note the uptime so later visits in the same run (a GM leaving and rejoining) do nothing.
 * Players: after a restart, until a GM has been in, show them the landing scene themselves
 * (only a GM can make a scene active).
 */
async function onReady(): Promise<void> {
  const uptime = await serverUptime();
  const fresh = restartedSince(uptime);
  const scene = await landingScene();

  if (game.user?.isGM) {
    const activeGM = (game.users as unknown as { activeGM?: { isSelf?: boolean } | null }).activeGM;
    if (!activeGM?.isSelf) return;
    if (uptime !== null) await settings().set(MODULE_ID, SETTINGS.LAST_UPTIME, uptime);
    if (!fresh || !scene || scenes().active?.id === scene.id) return;
    await scene.activate();
    log(`activated default scene "${scene.name}" on world start`);
    return;
  }

  if (!fresh || !scene || (canvas as unknown as { scene?: { id: string } | null } | null)?.scene?.id === scene.id) return;
  try {
    await scene.view();
    log(`showing default scene "${scene.name}" until a GM arrives`);
  } catch (err) {
    log('could not show the default scene:', err);
  }
}

export const landing: Feature = {
  id: 'landing',
  group: 'general',
  legacyModuleId: 'world-landing-fvtt',
  legacyTitle: 'World Landing',
  styles: [`${MODULE_PATH}/styles/landing.css`],

  init() {
    settings().register(MODULE_ID, SETTINGS.DEFAULT_SCENE, {
      scope: 'world',
      config: false,
      type: String,
      default: '',
    });
    settings().register(MODULE_ID, SETTINGS.LAST_BOOT, {
      scope: 'world',
      config: false,
      type: Number,
      default: 0,
    });
    settings().register(MODULE_ID, SETTINGS.LAST_UPTIME, {
      scope: 'world',
      config: false,
      type: Number,
      default: 0,
    });
    settings().register(MODULE_ID, SETTINGS.DEFAULT_SCENE_INFO, {
      name: 'kaiserkram.landing.CurrentDefaultSceneName',
      hint: 'kaiserkram.landing.CurrentDefaultSceneHint',
      scope: 'world',
      config: true,
      type: String,
      default: '',
    });
    on('getSceneContextOptions', addSceneContextOptions as (...args: never[]) => unknown);
    on('renderSceneDirectory', markDefaultScene);
    on('renderSettingsConfig', showDefaultSceneInSettings);
  },

  ready: onReady,

  api() {
    return {
      getDefaultSceneId: defaultSceneId,
      setDefaultSceneId: (id: string) => settings().set(MODULE_ID, SETTINGS.DEFAULT_SCENE, id ?? ''),
    };
  },
};
