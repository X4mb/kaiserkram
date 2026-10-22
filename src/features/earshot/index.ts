import { MODULE_ID } from '../../core/constants.js';
import type { Feature } from '../../core/feature.js';
import { notify, on } from '../../core/foundryApi.js';
import { clearAvSessionLog, copyAvSessionLogToClipboard, getAvSessionLogSnapshot } from './avSessionLog.js';
import { proximityClientClass } from './proximityClient.js';
import { proximityRouter, scheduleProximityRefresh } from './proximityAudioRouter.js';
import { registerVoiceEntryPoints } from './entryPoints.js';
import { getDebug, registerEarshotClientSettings, registerEarshotKeybindings, registerEarshotSettings, SETTINGS } from './settings.js';
import { destroySpeakingRings, updateSpeakingRings } from './speakingRings.js';
import { openVoiceAssignDialogForActor } from './voiceAssignDialog.js';
import { voiceChangerProcessor } from './voiceChangerProcessor.js';
import { clearLosCache } from './proximityLos.js';
import { destroyWhisperBadges, hasWhisperers, refreshWhisperers, updateWhisperBadges } from './whisperBadges.js';
import {
  clearVoiceIndicator,
  destroyVoiceIndicatorLayer,
  redrawVoiceIndicator,
  scheduleVoiceIndicatorRedraw,
} from './voiceIndicatorLayer.js';
import { getVoiceProfileForActor, persistVoiceProfileFlag, type VoiceProfile } from './voiceProfile.js';
import { clearVoiceTokenFlagForCurrentUser, getVoiceTokenIdFromUser } from './voiceToken.js';
import { registerVoiceTokenKeybinding } from './voiceTokenInput.js';
import { clearWhisperForCurrentUser, isWhispering, registerWhisperControls, setWhisper, toggleWhisper } from './whisper.js';

/**
 * Per frame, only what has to follow a moving token on screen: the voice indicator, whisper
 * badges and speaking rings. Gains are worked out from token positions as stored (which change
 * when a move starts, not during its animation), so they are recomputed on changes, not per frame.
 */
let canvasPositionTicker: ((dt?: number) => void) | undefined;

function registerCanvasPositionTicker(): void {
  unregisterCanvasPositionTicker();
  const app = canvas?.app;
  if (!app?.ticker) return;
  canvasPositionTicker = () => {
    if (!canvas?.ready) return;
    // A/V switched off for the world: no voices to place, nothing to draw.
    if ((game as unknown as { webrtc?: { mode?: number } }).webrtc?.mode === 0) {
      clearVoiceIndicator();
      if (hasWhisperers()) destroyWhisperBadges();
      destroySpeakingRings();
      return;
    }
    redrawVoiceIndicator();
    if (hasWhisperers()) updateWhisperBadges();
    updateSpeakingRings();
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
  // What moves voices: tokens moving, appearing or going, and which token is yours.
  for (const h of ['controlToken', 'updateToken', 'moveToken', 'createToken', 'deleteToken']) {
    on(h, refreshAll);
  }
  on('canvasReady', () => {
    clearLosCache();
    refreshWhisperers();
    refreshAll();
    registerCanvasPositionTicker();
    // canvasTearDown only detaches the Web Audio graph; WebRTC peers survive a scene change and
    // need to be re-wired, or remote voice stays silently dropped.
    const client = (game as unknown as { webrtc?: { client?: unknown } }).webrtc?.client;
    if (client instanceof proximityClientClass()) void client.reattachAllPeers();
  });
  on('canvasTearDown', () => {
    clearLosCache();
    destroyWhisperBadges();
    destroySpeakingRings();
    unregisterCanvasPositionTicker();
    destroyVoiceIndicatorLayer();
    proximityRouter.detachAll();
  });
  on('rtcSettingsChanged', scheduleProximityRefresh);
  // A whisperer who leaves stops showing a badge.
  on('userConnected', refreshWhisperers);
  on('visibilityRefresh', scheduleProximityRefresh);
  for (const h of ['createWall', 'updateWall', 'deleteWall']) {
    on(h, () => {
      clearLosCache();
      scheduleProximityRefresh();
    });
  }

  on('updateUser', ((user: User, change: { character?: unknown; flags?: Record<string, Record<string, unknown> | undefined> }) => {
    // A user's character decides which token they speak from (and hear with).
    if ('character' in change) refreshAll();
    if (change.flags?.[MODULE_ID]?.earshot !== undefined) {
      refreshWhisperers();
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
      // The GM speaking as this actor: their outgoing voice follows the profile.
      if (game.user?.isGM && voiceChangerProcessor.isInitialized()) {
        const pinnedId = getVoiceTokenIdFromUser(game.user);
        if (pinnedId && canvas?.scene?.tokens.get(pinnedId)?.actor?.id === doc.id) {
          void voiceChangerProcessor.applyProfile(getVoiceProfileForActor(doc));
        }
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
    registerEarshotSettings();
    registerEarshotClientSettings();
    // Foundry requires keybindings to be registered during init (not ready), or setup throws.
    registerEarshotKeybindings(toggleWhisper);
    registerVoiceTokenKeybinding();
    registerHooks();
    registerVoiceEntryPoints();
    registerWhisperControls();
    // Last: if anything above throws, voice chat keeps Foundry's own client instead of a half-set-up one.
    (CONFIG.WebRTC as { clientClass: unknown }).clientClass = proximityClientClass();
  },

  async ready() {
    if (game.user?.isGM && getDebug()) {
      const version = (game.modules?.get(MODULE_ID) as { version?: string } | undefined)?.version ?? '?';
      notify().info(`Kaiserkram v${version}: Within Earshot active`, { permanent: true });
    }
    await clearVoiceTokenFlagForCurrentUser();
    await clearWhisperForCurrentUser();
    window.addEventListener('pointerdown', () => void proximityRouter.ensureResumed(), { once: true });
    refreshAll();
  },

  api() {
    return {
      getVoiceProfileForActor,
      setVoiceProfileForActor,
      openVoiceAssignDialogForActor,
      isWhispering,
      setWhisper,
      scheduleProximityRefresh,
      getAvSessionLog: getAvSessionLogSnapshot,
      clearAvSessionLog,
      copyAvSessionLogToClipboard,
    };
  },
};
