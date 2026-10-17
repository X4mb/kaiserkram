import { MODULE_ID } from '../../core/constants.js';
import { keybindings } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';
import { scheduleProximityRefresh } from './proximityAudioRouter.js';
import { scheduleVoiceIndicatorRedraw } from './voiceIndicatorLayer.js';
import { toggleVoiceTokenForCurrentUser } from './voiceToken.js';
import { KEYBINDINGS } from './settings.js';

/**
 * Must run from `init` (same as other keybindings). Do not add non-Token children to
 * `canvas.tokens.objects` — D&D5e TokenLayer5e only allows Token5e there.
 */
export function registerVoiceTokenKeybinding(): void {
  keybindings().register(MODULE_ID, KEYBINDINGS.VOICE_TOKEN, {
    name: 'kaiserkram.earshot.SETTINGS.toggleVoiceToken.name',
    hint: 'kaiserkram.earshot.SETTINGS.toggleVoiceToken.hint',
    editable: [{ key: 'KeyV', modifiers: ['CONTROL', 'SHIFT'] }],
    onDown: () => {
      if (!canvas?.ready || !canvas.tokens) return;
      const token = canvas.tokens.controlled[0];
      if (!token) {
        ui.notifications?.warn(
          loc('kaiserkram.earshot.VOICE.needSelection', 'Select a token first (control it), then press the keybinding.'),
        );
        return;
      }
      void toggleVoiceTokenForCurrentUser(token).then(() => {
        token.refresh();
        scheduleVoiceIndicatorRedraw();
        scheduleProximityRefresh();
      });
    },
  });
}
