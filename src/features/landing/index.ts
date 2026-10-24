import { MODULE_ID, MODULE_PATH } from '../../core/constants.js';
import type { Feature } from '../../core/feature.js';
import { contextEntry, isActiveGM, notify, on, settings, toElement } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';

const SETTINGS = {
  DEFAULT_SCENE: 'landingDefaultSceneId',
  /** The world launch the active GM last handled (the world's `lastPlayed` stamp). */
  LAST_LAUNCH: 'landingLastLaunch',
  /** Fallback when the world has no launch stamp: when the server last booted (ms, server clock). */
  LAST_BOOT: 'landingLastBootEpoch',
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

/** Two uptime readings this far apart tell the unit the server reports it in. */
const PROBE_MS = 1500;
/** Boot times closer than this are the same boot (timing jitter between readings). */
const SAME_BOOT_MS = 60_000;

function serverNow(): number {
  return (game as unknown as { time?: { serverTime?: number } }).time?.serverTime ?? Date.now();
}

/**
 * When the server booted (ms since the epoch, on the server's clock), or null if it can't be read.
 * There is no hook for "the world just started", so it is worked out from the server's uptime;
 * reading it twice tells whether that is in seconds or milliseconds.
 */
async function serverBootTime(): Promise<number | null> {
  const first = await serverUptime();
  if (first === null) return null;
  const started = performance.now();
  await new Promise((resolve) => setTimeout(resolve, PROBE_MS));
  const second = await serverUptime();
  if (second === null) return null;
  const perMs = (second - first) / Math.max(1, performance.now() - started);
  const msPerUnit = perMs > 0.1 ? 1 : 1000;
  return Math.round(serverNow() - second * msPerUnit);
}

/** Whether the server booted since the active GM last recorded it. Unknown counts as no. */
function isNewBoot(boot: number | null): boolean {
  if (boot === null) return false;
  const last = Number(settings().get(MODULE_ID, SETTINGS.LAST_BOOT)) || 0;
  return Math.abs(boot - last) > SAME_BOOT_MS;
}

/**
 * When this world was launched: Foundry stamps it each time the world starts, from Setup or
 * with the server. The server's uptime alone misses a world relaunched without restarting the
 * server.
 */
function launchStamp(): string | null {
  const stamp = (game as unknown as { world?: { lastPlayed?: unknown } }).world?.lastPlayed;
  return typeof stamp === 'string' && stamp ? stamp : null;
}

type Launch = { fresh: boolean; record?: () => Promise<unknown>; how: string };

/** Whether this is the first visit since the world started, and how to remember it was seen. */
async function checkLaunch(): Promise<Launch> {
  const stamp = launchStamp();
  if (stamp) {
    const last = String(settings().get(MODULE_ID, SETTINGS.LAST_LAUNCH) ?? '');
    return {
      fresh: stamp !== last,
      record: () => settings().set(MODULE_ID, SETTINGS.LAST_LAUNCH, stamp),
      how: `world launched ${stamp}, last handled ${last || 'never'}`,
    };
  }
  const boot = await serverBootTime();
  return {
    fresh: isNewBoot(boot),
    record: boot === null ? undefined : () => settings().set(MODULE_ID, SETTINGS.LAST_BOOT, boot),
    how: boot === null ? 'no launch stamp, server uptime unreadable' : `no launch stamp, server booted ${new Date(boot).toISOString()}`,
  };
}

function landingScene(): SceneLike | null {
  const sceneId = defaultSceneId();
  if (!sceneId) return null;
  const scene = scenes().get(sceneId);
  if (!scene) log(`configured default scene "${sceneId}" no longer exists`);
  return scene ?? null;
}

/**
 * GM: on the first GM visit after the world starts, make the landing scene active for everyone,
 * and note that start so later visits in the same run (a GM leaving and rejoining) do nothing.
 * Players: after a restart, until a GM has been in, show them the landing scene themselves
 * (only a GM can make a scene active).
 */
async function onReady(): Promise<void> {
  const scene = landingScene();
  // Other GMs leave it to the active one; players have nothing to do without a landing scene.
  if (game.user?.isGM ? !isActiveGM() : !scene) return;
  const { fresh, record, how } = await checkLaunch();
  log(`${fresh ? 'new world start' : 'same world start'} (${how})`);

  if (game.user?.isGM) {
    // Noted even with no landing scene set, so setting one later doesn't count as a restart.
    if (fresh) await record?.();
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
  styles: [`${MODULE_PATH}/styles/landing.css`],

  init() {
    settings().register(MODULE_ID, SETTINGS.DEFAULT_SCENE, {
      scope: 'world',
      config: false,
      type: String,
      default: '',
    });
    settings().register(MODULE_ID, SETTINGS.LAST_LAUNCH, {
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
