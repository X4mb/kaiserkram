import { MODULE_ID } from '../../core/constants.js';
import type { Feature } from '../../core/feature.js';
import { on } from '../../core/foundryApi.js';
import { clearAvSessionLog, copyAvSessionLogToClipboard, getAvSessionLogSnapshot } from './avSessionLog.js';
import { proximityClientClass } from './proximityClient.js';
import { proximityRouter, scheduleProximityRefresh } from './proximityAudioRouter.js';
import { registerEarshotKeybindings, registerEarshotSettings, SETTINGS } from './settings.js';
import { destroyVoiceIndicatorLayer, redrawVoiceIndicator, scheduleVoiceIndicatorRedraw } from './voiceIndicatorLayer.js';
import { getVoiceProfileForActor, persistVoiceProfileFlag, type VoiceProfile } from './voiceProfile.js';
import { clearVoiceTokenFlagForCurrentUser } from './voiceToken.js';
import { registerVoiceTokenKeybinding } from './voiceTokenInput.js';

/** Indicator follows the token every frame; gain updates are throttled inside the router. */
let canvasPositionTicker: ((dt?: number) => void) | undefined;

function registerCanvasPositionTicker(): void {
  unregisterCanvasPositionTicker();
  const app = canvas?.app;
  if (!app?.ticker) return;
  canvasPositionTicker = () => {
    if (!canvas?.ready) return;
    redrawVoiceIndicator();
    /** Keep gains aligned with token positions every frame (no artificial 125ms delay). */
    proximityRouter.refreshAllGains();
  };
  /** Run after NORMAL-priority updates (e.g. movement tweens) so positions match the mesh. */
  const afterMove = (PIXI as typeof PIXI & { UPDATE_PRIORITY?: { LOW: number } }).UPDATE_PRIORITY?.LOW ?? -25;
  app.ticker.add(canvasPositionTicker, undefined, afterMove);
}

function unregisterCanvasPositionTicker(): void {
  const app = canvas?.app;
  if (canvasPositionTicker && app?.ticker) app.ticker.remove(canvasPositionTicker);
  canvasPositionTicker = undefined;
}

function refreshAll(): void {
  scheduleProximityRefresh();
  scheduleVoiceIndicatorRedraw();
}

const WATCHED_SETTINGS: readonly string[] = Object.values(SETTINGS);

function registerHooks(): void {
  for (const h of ['controlObject', 'targetToken', 'canvasPan', 'updateToken', 'moveToken', 'refreshToken']) {
    on(h, refreshAll);
  }
  on('canvasReady', () => {
    refreshAll();
    registerCanvasPositionTicker();
  });
  on('canvasTearDown', () => {
    unregisterCanvasPositionTicker();
    destroyVoiceIndicatorLayer();
    proximityRouter.detachAll();
  });
  on('rtcSettingsChanged', scheduleProximityRefresh);
  on('visibilityRefresh', scheduleProximityRefresh);
  for (const h of ['createWall', 'updateWall', 'deleteWall']) on(h, scheduleProximityRefresh);

  on('updateUser', ((user: User, change: { flags?: Record<string, Record<string, unknown> | undefined> }) => {
    if (change.flags?.[MODULE_ID]?.earshot !== undefined) {
      scheduleProximityRefresh();
      if (user.id === game.user?.id) scheduleVoiceIndicatorRedraw();
    }
  }) as (...args: never[]) => unknown);

  // Any change under flags.kaiserkram.earshot, including unsetting the voice profile.
  on('updateActor', ((doc: Actor, change: { flags?: Record<string, Record<string, unknown> | undefined> }) => {
    if (change.flags?.[MODULE_ID]?.earshot !== undefined) {
      const uid = game.users?.find((u) => u.character?.id === doc.id)?.id;
      if (uid) {
        proximityRouter.updateProfileGainForUser(uid);
        scheduleProximityRefresh();
      }
    }
  }) as (...args: never[]) => unknown);

  // Fires with the full "namespace.key" for client-scoped settings. World settings refresh via their onChange.
  on('clientSettingChanged', ((key: string) => {
    const full = String(key);
    if (WATCHED_SETTINGS.some((k) => full === `${MODULE_ID}.${k}`)) scheduleProximityRefresh();
    /** Per-user A/V volume & mute live under core rtc client settings (not always covered by rtcSettingsChanged). */
    if (full === 'core.rtcClientSettings') scheduleProximityRefresh();
  }) as (...args: never[]) => unknown);
}

async function setVoiceProfileForActor(actor: Actor, profile: VoiceProfile | null): Promise<void> {
  await persistVoiceProfileFlag(actor, profile);
  const uid = game.users?.find((u) => u.character?.id === actor.id)?.id;
  if (uid) {
    proximityRouter.updateProfileGainForUser(uid);
    scheduleProximityRefresh();
  }
}

export const earshot: Feature = {
  id: 'earshot',
  group: 'general',
  legacyModuleId: 'withinearshot',
  legacyTitle: 'Within Earshot',

  init() {
    (CONFIG.WebRTC as { clientClass: unknown }).clientClass = proximityClientClass();
    registerEarshotSettings();
    // Foundry requires keybindings to be registered during init (not ready), or setup throws.
    registerEarshotKeybindings();
    registerVoiceTokenKeybinding();
    registerHooks();
  },

  async ready() {
    await clearVoiceTokenFlagForCurrentUser();
    window.addEventListener('pointerdown', () => void proximityRouter.ensureResumed(), { once: true });
    refreshAll();
  },

  api() {
    return {
      getVoiceProfileForActor,
      setVoiceProfileForActor,
      scheduleProximityRefresh,
      getAvSessionLog: getAvSessionLogSnapshot,
      clearAvSessionLog,
      copyAvSessionLogToClipboard,
    };
  },
};
