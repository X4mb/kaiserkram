/** Flags, as dotted paths under flags.kaiserkram (i.e. flags.kaiserkram.earshot.<key>). */
export const FLAGS = {
  /** User flag: scene token id this user speaks from for proximity (unset = use default primary token). */
  VOICE_TOKEN_ID: 'earshot.voiceTokenId',
  /** Actor flag: per-actor {@link VoiceProfile}. */
  VOICE_PROFILE: 'earshot.voiceProfile',
} as const;

/** Single PIXI.Graphics on canvas.tokens for voice source outline (persists across token.refresh). */
export const VOICE_INDICATOR_LAYER = 'kaiserkramEarshotVoiceIndicator';
