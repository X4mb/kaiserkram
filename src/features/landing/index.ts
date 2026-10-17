import { MODULE_ID } from '../../core/constants.js';
import type { Feature } from '../../core/feature.js';
import { notify, on, settings } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';

export const SETTINGS = {
  DEFAULT_SCENE: 'landingDefaultSceneId',
  LAST_BOOT: 'landingLastBootEpoch',
} as const;

// If the server-reported boot time differs from what we last saw by more
// than this, treat it as a genuine restart rather than clock/network jitter.
const BOOT_TOLERANCE_MS = 15000;

type SceneLike = { id: string; name: string; activate(): Promise<unknown> };
type ScenesView = { get(id: string): SceneLike | undefined; active?: SceneLike | null };
type UsersView = { filter(fn: (u: { active: boolean }) => boolean): unknown[] };

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
  return li.dataset.documentId ?? li.dataset.entryId ?? li.dataset.sceneId ?? null;
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
}

async function clearDefaultScene(): Promise<void> {
  await settings().set(MODULE_ID, SETTINGS.DEFAULT_SCENE, '');
  notify().info(loc('kaiserkram.landing.UnsetNotification', 'Default landing scene cleared.'));
}

type ContextOption = {
  name: string;
  icon: string;
  condition: (li: HTMLElement) => boolean;
  callback: (li: HTMLElement) => unknown;
};

function addSceneContextOptions(_application: unknown, options: ContextOption[]): void {
  options.push(
    {
      name: 'kaiserkram.landing.ContextSet',
      icon: '<i class="fa-solid fa-house"></i>',
      condition: (li) => Boolean(game.user?.isGM) && !isDefaultScene(li),
      callback: (li) => setDefaultScene(li),
    },
    {
      name: 'kaiserkram.landing.ContextUnset',
      icon: '<i class="fa-solid fa-house-circle-check"></i>',
      condition: (li) => Boolean(game.user?.isGM) && isDefaultScene(li),
      callback: () => clearDefaultScene(),
    },
  );
}

/**
 * There is no client hook for "the world process just booted" as distinct
 * from "a client connected to an already-running world". We approximate it
 * using the server's uptime, exposed by Foundry's own /api/status route,
 * falling back to an active-user heuristic if that's ever unavailable.
 */
async function isFreshWorldBoot(): Promise<boolean> {
  try {
    const response = await fetch(`${window.location.origin}/api/status`);
    if (!response.ok) throw new Error(`status endpoint returned ${response.status}`);
    const data = (await response.json()) as { uptime?: unknown };
    if (typeof data.uptime !== 'number') throw new Error('status endpoint had no uptime field');

    const bootEpoch = Date.now() - data.uptime;
    const lastBootEpoch = Number(settings().get(MODULE_ID, SETTINGS.LAST_BOOT)) || 0;
    const isFresh = Math.abs(bootEpoch - lastBootEpoch) > BOOT_TOLERANCE_MS;
    if (isFresh) await settings().set(MODULE_ID, SETTINGS.LAST_BOOT, bootEpoch);
    return isFresh;
  } catch (err) {
    log('could not read server uptime, falling back to active-user check:', err);
    return (game.users as unknown as UsersView).filter((u) => u.active).length <= 1;
  }
}

async function activateLandingScene(): Promise<void> {
  if (!game.user?.isGM) return;

  const sceneId = defaultSceneId();
  if (!sceneId) return;

  const scene = scenes().get(sceneId);
  if (!scene) {
    log(`configured default scene "${sceneId}" no longer exists`);
    return;
  }

  if (scenes().active?.id === scene.id) return;
  if (!(await isFreshWorldBoot())) return;

  await scene.activate();
  log(`activated default scene "${scene.name}" on world start`);
}

export const landing: Feature = {
  id: 'landing',
  group: 'general',
  legacyModuleId: 'world-landing-fvtt',
  legacyTitle: 'World Landing',

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
    on('getSceneContextOptions', addSceneContextOptions as (...args: never[]) => unknown);
  },

  ready: activateLandingScene,

  api() {
    return {
      getDefaultSceneId: defaultSceneId,
      setDefaultSceneId: (id: string) => settings().set(MODULE_ID, SETTINGS.DEFAULT_SCENE, id ?? ''),
    };
  },
};
