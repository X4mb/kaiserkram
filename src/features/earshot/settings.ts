import { MODULE_ID } from '../../core/constants.js';
import { keybindings, settings as s } from '../../core/foundryApi.js';
import { scheduleProximityRefresh } from './proximityAudioRouter.js';

export const SETTINGS = {
  MAX_RANGE: 'earshotMaxRange',
  GM_VOICE_GLOBAL: 'earshotGmVoiceGlobal',
  /** 1 = no muffling through walls; 0.05 default (heavy muffling). World scope = GM only. */
  THROUGH_WALL_GAIN: 'earshotThroughWallGain',
  /**
   * World (GM): when true, non-GM speakers with no resolvable token on the scene are silent to other
   * players (GM still hears everyone). When false (default), they are heard at full volume until a token exists.
   */
  MUTE_UNRESOLVED_SPEAKER: 'earshotMuteUnresolvedSpeaker',
  /** World: how far (grid units) a whisper carries. 1.5 reaches the eight squares around the speaker. */
  WHISPER_RANGE: 'earshotWhisperRange',
  /** Client (per-user): verbose console diagnostics + a "build active" banner for the GM. Off by default. */
  DEBUG: 'earshotDebug',
} as const;

export const KEYBINDINGS = {
  TOGGLE_GM_VOICE_GLOBAL: 'earshotToggleGMVoiceGlobal',
  WHISPER: 'earshotToggleWhisper',
  VOICE_TOKEN: 'earshotVoiceToken',
} as const;

/** World settings change on every client at once; refresh gains wherever they change. */
const onChange = () => scheduleProximityRefresh();

/** Names and hints are i18n keys; Foundry localizes them when it shows the settings. */
export function registerEarshotSettings(): void {
  s().register(MODULE_ID, SETTINGS.MAX_RANGE, {
    name: 'kaiserkram.earshot.SETTINGS.maxRange.name',
    hint: 'kaiserkram.earshot.SETTINGS.maxRange.hint',
    scope: 'world',
    config: true,
    type: Number,
    range: { min: 1, max: 500, step: 1 },
    default: 15,
    onChange,
  });

  s().register(MODULE_ID, SETTINGS.GM_VOICE_GLOBAL, {
    name: 'kaiserkram.earshot.SETTINGS.gmVoiceGlobal.name',
    hint: 'kaiserkram.earshot.SETTINGS.gmVoiceGlobal.hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
    onChange,
  });

  s().register(MODULE_ID, SETTINGS.THROUGH_WALL_GAIN, {
    name: 'kaiserkram.earshot.SETTINGS.throughWallGain.name',
    hint: 'kaiserkram.earshot.SETTINGS.throughWallGain.hint',
    scope: 'world',
    config: true,
    type: Number,
    range: { min: 0.05, max: 1, step: 0.05 },
    default: 0.05,
    onChange,
  });

  s().register(MODULE_ID, SETTINGS.WHISPER_RANGE, {
    name: 'kaiserkram.earshot.SETTINGS.whisperRange.name',
    hint: 'kaiserkram.earshot.SETTINGS.whisperRange.hint',
    scope: 'world',
    config: true,
    type: Number,
    range: { min: 1, max: 5, step: 0.5 },
    default: 1.5,
    onChange,
  });

  s().register(MODULE_ID, SETTINGS.MUTE_UNRESOLVED_SPEAKER, {
    name: 'kaiserkram.earshot.SETTINGS.muteUnresolvedSpeaker.name',
    hint: 'kaiserkram.earshot.SETTINGS.muteUnresolvedSpeaker.hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
    onChange,
  });
}

export function registerEarshotDebugSetting(): void {
  s().register(MODULE_ID, SETTINGS.DEBUG, {
    name: 'kaiserkram.earshot.SETTINGS.debug.name',
    hint: 'kaiserkram.earshot.SETTINGS.debug.hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
  });
}

export function getDebug(): boolean {
  try {
    return Boolean(s().get(MODULE_ID, SETTINGS.DEBUG));
  } catch {
    return false;
  }
}

/** Must run from the `init` hook only — Foundry forbids registering keybindings after init. */
export function registerEarshotKeybindings(toggleWhisper: () => unknown): void {
  keybindings().register(MODULE_ID, KEYBINDINGS.WHISPER, {
    name: 'kaiserkram.earshot.SETTINGS.toggleWhisper.name',
    hint: 'kaiserkram.earshot.SETTINGS.toggleWhisper.hint',
    editable: [{ key: 'KeyW', modifiers: ['ALT'] }],
    onDown: () => {
      void toggleWhisper();
      return true;
    },
  });

  keybindings().register(MODULE_ID, KEYBINDINGS.TOGGLE_GM_VOICE_GLOBAL, {
    name: 'kaiserkram.earshot.SETTINGS.toggleGMVoiceGlobal.name',
    hint: 'kaiserkram.earshot.SETTINGS.toggleGMVoiceGlobal.hint',
    onDown: () => {
      if (!game.user?.isGM) return;
      void setGmVoiceGlobal(!getGmVoiceGlobal());
    },
  });
}

export function getMaxRange(): number {
  const v = s().get(MODULE_ID, SETTINGS.MAX_RANGE);
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return 15;
  return Math.min(500, Math.max(1, n));
}

export function getGmVoiceGlobal(): boolean {
  return Boolean(s().get(MODULE_ID, SETTINGS.GM_VOICE_GLOBAL));
}

export function setGmVoiceGlobal(v: boolean): Promise<unknown> {
  return s().set(MODULE_ID, SETTINGS.GM_VOICE_GLOBAL, v);
}

export function getWhisperRange(): number {
  const n = Number(s().get(MODULE_ID, SETTINGS.WHISPER_RANGE));
  return Number.isFinite(n) && n > 0 ? n : 1.5;
}

export function getThroughWallGain(): number {
  const v = s().get(MODULE_ID, SETTINGS.THROUGH_WALL_GAIN);
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0.05;
  return Math.min(1, Math.max(0.05, n));
}

/** When true, missing speaker token doc → mute for non-GM listeners (see proximity router). */
export function getMuteUnresolvedSpeaker(): boolean {
  try {
    return Boolean(s().get(MODULE_ID, SETTINGS.MUTE_UNRESOLVED_SPEAKER));
  } catch {
    return false;
  }
}
