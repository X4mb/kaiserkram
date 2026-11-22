import { MODULE_ID, MODULE_PATH } from '../../core/constants.js';
import type { Feature } from '../../core/feature.js';
import { contextEntry, ENTRY_SELECTOR, entryIdOf, isActiveGM, notify, on, settings, toElement } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';

const SETTINGS = {
  DEFAULT_SCENE: 'landingDefaultSceneId',
  /** The world launch the active GM last handled (the world's `lastPlayed` stamp). */
  LAST_LAUNCH: 'landingLastLaunch',
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

function isDefaultScene(li: HTMLElement): boolean {
  const sceneId = entryIdOf(li);
  return !!sceneId && sceneId === defaultSceneId();
}

async function setDefaultScene(li: HTMLElement): Promise<void> {
  const sceneId = entryIdOf(li);
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
  const rows = toElement(html)?.querySelectorAll<HTMLElement>(ENTRY_SELECTOR) ?? [];
  for (const li of rows) li.classList.toggle(BADGE_CLASS, !!sceneId && entryIdOf(li) === sceneId);
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

/**
 * When this world was launched: Foundry stamps it each time the world starts, from Setup or
 * with the server. The server's uptime alone misses a world relaunched without restarting the
 * server.
 */
function launchStamp(): string | null {
  const stamp = (game as unknown as { world?: { lastPlayed?: unknown } }).world?.lastPlayed;
  return typeof stamp === 'string' && stamp ? stamp : null;
}

/** Whether this is the first visit since the world started, and how to remember it was seen. */
function checkLaunch(): { fresh: boolean; record: () => Promise<unknown>; how: string } {
  const stamp = launchStamp() ?? '';
  const last = String(settings().get(MODULE_ID, SETTINGS.LAST_LAUNCH) ?? '');
  return {
    // No stamp at all (never seen in v14): treat as the same start, so nobody is pulled by mistake.
    fresh: Boolean(stamp) && stamp !== last,
    record: () => settings().set(MODULE_ID, SETTINGS.LAST_LAUNCH, stamp),
    how: `world launched ${stamp || 'unknown'}, last handled ${last || 'never'}`,
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
  const { fresh, record, how } = checkLaunch();
  log(`${fresh ? 'new world start' : 'same world start'} (${how})`);

  if (game.user?.isGM) {
    // Noted even with no landing scene set, so setting one later doesn't count as a restart.
    if (fresh) await record();
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
