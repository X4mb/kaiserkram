import { MODULE_ID } from '../../core/constants.js';
import { flags } from '../../core/foundryApi.js';
import { FLAGS } from './constants.js';

/**
 * Per-actor voice settings. `gainMultiplier` is applied before proximity attenuation.
 * Extend this object and the audio router when adding filters / pitch.
 */
export interface VoiceProfile {
  gainMultiplier?: number;
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
