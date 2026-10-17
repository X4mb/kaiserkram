import { MODULE_ID } from '../../core/constants.js';
import { flags } from '../../core/foundryApi.js';
import { FLAGS } from './constants.js';

/** 'robot' is no longer offered in the dialog but stays valid for previously saved profiles. */
export type VoicePreset =
  | 'none'
  | 'deep'
  | 'high'
  | 'feminine'
  | 'masculine'
  | 'robot'
  | 'whisper'
  | 'custom';

/**
 * Per-actor voice settings. `gainMultiplier` is applied (to how others hear this actor's player)
 * before proximity attenuation; the rest drives the GM's voice changer while speaking as this actor.
 */
export interface VoiceProfile {
  gainMultiplier?: number;
  preset?: VoicePreset;
  pitchShift?: number;
  eqLowGain?: number;
  eqHighGain?: number;
  /** 0–100: waveshaper drive ("growl"). */
  distortion?: number;
  /** 0–100: feedback-delay wet mix ("cave/spirit echo"). */
  echo?: number;
}

export function getVoiceProfileForActor(actor: Actor | null | undefined): VoiceProfile | null {
  if (!actor) return null;
  const data = flags(actor).getFlag(MODULE_ID, FLAGS.VOICE_PROFILE);
  if (!data || typeof data !== 'object') return null;
  return data as VoiceProfile;
}

/** Persist `flags.kaiserkram.earshot.voiceProfile` on the actor (no audio refresh; use the feature API for that). */
export async function persistVoiceProfileFlag(actor: Actor, profile: VoiceProfile | null): Promise<void> {
  if (profile === null) await flags(actor).unsetFlag(MODULE_ID, FLAGS.VOICE_PROFILE);
  else await flags(actor).setFlag(MODULE_ID, FLAGS.VOICE_PROFILE, profile);
}
