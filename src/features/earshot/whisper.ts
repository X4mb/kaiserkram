import { MODULE_ID } from '../../core/constants.js';
import { flags, notify } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';
import { addTokenTools } from '../../core/sceneTools.js';
import { FLAGS } from './constants.js';
import { scheduleProximityRefresh } from './proximityAudioRouter.js';
import { scheduleVoiceIndicatorRedraw } from './voiceIndicatorLayer.js';

/**
 * Whisper: while on, a user is only heard by those whose token stands within the whisper range
 * (one square by default, diagonals included). The flag lives on the User, so every client sees it.
 */

const WHISPER_TOOL = `${MODULE_ID}EarshotWhisper`;

export function isWhispering(user: User | null | undefined): boolean {
  return Boolean(user && flags(user).getFlag(MODULE_ID, FLAGS.WHISPER));
}

export async function setWhisper(on: boolean): Promise<void> {
  const user = game.user;
  if (!user || isWhispering(user) === on) return;
  if (on) await flags(user).setFlag(MODULE_ID, FLAGS.WHISPER, true);
  else await flags(user).unsetFlag(MODULE_ID, FLAGS.WHISPER);
  notify().info(
    on
      ? loc('kaiserkram.earshot.WHISPER.on', 'Whispering: only those right next to you can hear you.')
      : loc('kaiserkram.earshot.WHISPER.off', 'Speaking normally again.'),
  );
  scheduleProximityRefresh();
  scheduleVoiceIndicatorRedraw();
  // Keep the token-controls toggle in step when the keybinding flipped it.
  (ui as unknown as { controls?: { render(): unknown } }).controls?.render();
}

export function toggleWhisper(): Promise<void> {
  return setWhisper(!isWhispering(game.user));
}

/** Nobody should stay stuck whispering across a reload. */
export async function clearWhisperForCurrentUser(): Promise<void> {
  const user = game.user;
  if (user && isWhispering(user)) await flags(user).unsetFlag(MODULE_ID, FLAGS.WHISPER);
}

export function registerWhisperControls(): void {
  // A Whisper toggle in the token controls (left toolbar).
  addTokenTools(() => [
    {
      name: WHISPER_TOOL,
      title: loc('kaiserkram.earshot.WHISPER.tool', 'Whisper (only those next to you hear you)'),
      icon: 'fa-solid fa-comment-dots',
      order: 100,
      toggle: { active: () => isWhispering(game.user) },
      use: (active) => void setWhisper(active),
    },
  ]);
}
