import { escapeHtml, notify } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { getVoiceProfileForActor, persistVoiceProfileFlag } from './voiceProfile.js';
import { voiceChangerProcessor } from './voiceChangerProcessor.js';
import { voicePreviewer } from './voicePreview.js';
import { getVoiceTokenIdFromUser } from './voiceToken.js';
import type { VoicePreset, VoiceProfile } from './voiceProfile.js';

const PRESETS: { value: VoicePreset; label: () => string }[] = [
  { value: 'none',      label: () => loc('kaiserkram.earshot.ASSIGN.presetNone', 'None (passthrough)') },
  { value: 'deep',      label: () => loc('kaiserkram.earshot.ASSIGN.presetDeep', 'Deep') },
  { value: 'high',      label: () => loc('kaiserkram.earshot.ASSIGN.presetHigh', 'High') },
  { value: 'feminine',  label: () => loc('kaiserkram.earshot.ASSIGN.presetFeminine', 'Female (male → female)') },
  { value: 'masculine', label: () => loc('kaiserkram.earshot.ASSIGN.presetMasculine', 'Male (female → male)') },
  { value: 'whisper',   label: () => loc('kaiserkram.earshot.ASSIGN.presetWhisper', 'Whisper') },
  { value: 'custom',    label: () => loc('kaiserkram.earshot.ASSIGN.presetCustom', 'Custom') },
];

type SliderValues = {
  pitchShift: number;
  eqLowGain: number;
  eqHighGain: number;
  distortion: number;
  echo: number;
};

const SLIDER_DEFAULTS: SliderValues = { pitchShift: 0, eqLowGain: 0, eqHighGain: 0, distortion: 0, echo: 0 };

/**
 * Selecting a preset loads its recipe into the sliders (starting point, then tweak freely).
 * 'custom' keeps whatever is set; 'none' zeroes everything (true passthrough).
 */
const PRESET_RECIPES: Record<VoicePreset, SliderValues | null> = {
  none:    { ...SLIDER_DEFAULTS },
  deep:    { pitchShift: -4, eqLowGain: 6,  eqHighGain: -4, distortion: 0,  echo: 0 },
  high:    { pitchShift: 4,  eqLowGain: -4, eqHighGain: 4,  distortion: 0,  echo: 0 },
  // M→F: our granular shifter moves formants along with pitch, so a big shift turns chipmunk
  // fast — stay moderate on pitch (+3.5) and let EQ carry the rest: cut chest resonance hard
  // (a pitched-up voice with male chest weight reads as "small man", not female) and brighten
  // for head-voice timbre. Pitch MUST then be tuned to the speaker's base voice (see note).
  feminine: { pitchShift: 3.5, eqLowGain: -9, eqHighGain: 6, distortion: 0, echo: 0 },
  // F→M: mirror — lower pitch moderately, rebuild chest weight, darken the top end.
  masculine: { pitchShift: -3.5, eqLowGain: 7, eqHighGain: -4, distortion: 0, echo: 0 },
  robot:   { pitchShift: 0,  eqLowGain: 0,  eqHighGain: 2,  distortion: 15, echo: 0 },
  whisper: { pitchShift: 0,  eqLowGain: 0,  eqHighGain: 3,  distortion: 0,  echo: 0 },
  custom:  null,
};

function previewLabel(on: boolean): string {
  return on
    ? `<i class="fas fa-stop"></i> ${escapeHtml(loc('kaiserkram.earshot.ASSIGN.stopPreview', 'Stop preview'))}`
    : `<i class="fas fa-headphones"></i> ${escapeHtml(loc('kaiserkram.earshot.ASSIGN.preview', 'Preview my voice'))}`;
}

/** True when the GM's live outgoing voice currently uses this actor's profile (pinned token). */
function isLiveVoiceActor(actorId: string): boolean {
  if (!game.user?.isGM || !voiceChangerProcessor.isInitialized()) return false;
  const pinnedId = getVoiceTokenIdFromUser(game.user);
  if (!pinnedId) return false;
  const pinnedDoc = canvas?.scene?.tokens.get(pinnedId);
  return pinnedDoc?.actor?.id === actorId;
}

/**
 * DialogV2 (foundry.applications.api) replaces the removed v1 `Dialog`. It wraps the content in a
 * form itself, so `content` below has no <form> tag; button callbacks receive `button.form`.
 * Subclassed only to hook the AppV2 lifecycle: `_onRender` wires the live controls, `_onClose`
 * runs cleanup for every close path (Save / Cancel / X / Escape).
 */
interface DialogV2Instance {
  element: HTMLElement;
  render(options?: { force?: boolean }): Promise<unknown>;
  close(options?: unknown): Promise<unknown>;
  _onRender(context: unknown, options: unknown): void;
  _onClose(options: unknown): void;
}
type DialogV2Ctor = new (config: Record<string, unknown>) => DialogV2Instance;
type VoiceAssignDialogCtor = new (
  config: Record<string, unknown>,
  onRenderCb: (root: HTMLElement) => void,
  onCloseCb: () => void,
) => DialogV2Instance;

let VoiceAssignDialogClass: VoiceAssignDialogCtor | undefined;

/**
 * One Assign Voice window at a time: they share the GM's mute and the preview, so closing one
 * would otherwise unmute the GM (and stop the preview) while another is still being tuned.
 */
let openDialog: DialogV2Instance | null = null;
/** Opens one after another, so two quick opens can't both get past closing the old window. */
let opening: Promise<void> = Promise.resolve();

/** Built on first use so nothing touches DialogV2 unless the feature is enabled and a GM opens it. */
function voiceAssignDialogClass(): VoiceAssignDialogCtor {
  if (VoiceAssignDialogClass) return VoiceAssignDialogClass;
  const Base = (foundry.applications.api as unknown as { DialogV2: DialogV2Ctor }).DialogV2;
  VoiceAssignDialogClass = defineVoiceAssignDialog(Base);
  return VoiceAssignDialogClass;
}

function defineVoiceAssignDialog(Base: DialogV2Ctor): VoiceAssignDialogCtor {
  return class VoiceAssignDialog extends Base {
    private readonly onRenderCb: (root: HTMLElement) => void;
    private readonly onCloseCb: () => void;

    constructor(
      config: Record<string, unknown>,
      onRenderCb: (root: HTMLElement) => void,
      onCloseCb: () => void,
    ) {
      super(config);
      this.onRenderCb = onRenderCb;
      this.onCloseCb = onCloseCb;
    }

    override _onRender(context: unknown, options: unknown): void {
      super._onRender(context, options);
      this.onRenderCb(this.element);
    }

    override _onClose(options: unknown): void {
      this.onCloseCb();
      super._onClose(options);
    }
  };
}

export function openVoiceAssignDialogForActor(actor: Actor): Promise<void> {
  const next = opening.then(() => openNow(actor));
  opening = next.catch(() => undefined);
  return next;
}

async function openNow(actor: Actor): Promise<void> {
  if (openDialog) await openDialog.close();
  const profile = getVoiceProfileForActor(actor) ?? {};
  const currentPreset: VoicePreset = profile.preset ?? 'none';
  const pitchShift = profile.pitchShift ?? 0;
  const eqLowGain  = profile.eqLowGain  ?? 0;
  const eqHighGain = profile.eqHighGain ?? 0;
  const distortion = profile.distortion ?? 0;
  const echo       = profile.echo       ?? 0;

  const actorId   = (actor as Actor & { id: string }).id;
  const actorName = (actor as Actor & { name: string }).name;

  const presetOptions = PRESETS.map(
    (p) =>
      `<option value="${p.value}"${p.value === currentPreset ? ' selected' : ''}>${escapeHtml(p.label())}</option>`,
  ).join('');

  const canMuteLive = !!game.user?.isGM && voiceChangerProcessor.isInitialized();
  const muteHint = canMuteLive
    ? `<p class="notes" style="margin:0 0 6px"><i class="fas fa-volume-mute"></i> ${escapeHtml(
        loc('kaiserkram.earshot.ASSIGN.mutedHint', 'Players cannot hear you while this window is open.'),
      )}</p>`
    : '';

  const slider = (name: string, label: string, valId: string, min: number, max: number, step: number, value: number): string => `
      <div class="form-group" style="margin-top:8px">
        <label>${escapeHtml(label)}: <span id="${valId}">${value}</span></label>
        <input type="range" name="${name}" min="${min}" max="${max}" step="${step}"
               value="${value}" style="width:100%">
      </div>`;

  // No <form> wrapper: DialogV2 supplies the form. actorId is a Foundry id (safe charset).
  const content = `
    <input type="hidden" name="actorId" value="${actorId}">
    ${muteHint}
    <div class="form-group">
      <label><b>${escapeHtml(loc('kaiserkram.earshot.ASSIGN.preset', 'Voice preset'))}</b></label>
      <select name="preset" style="width:100%">${presetOptions}</select>
      <p class="notes" style="margin:2px 0 0">${escapeHtml(
        loc('kaiserkram.earshot.ASSIGN.presetHint', 'Presets load starting values into the sliders; tweak from there.'),
      )}</p>
      <p class="notes" id="wea-preset-note" style="display:none; margin:2px 0 0">${escapeHtml(
        loc(
          'kaiserkram.earshot.ASSIGN.tuneNote',
          'Tune the pitch to the speaker: the right shift depends on how low or high the base voice is. A deep voice needs more (up to ±5), a lighter voice less (±2–3). Go in 0.5 steps until it stops sounding artificial, then adjust Bass and Treble.',
        ),
      )}</p>
    </div>
    ${slider('pitchShift', loc('kaiserkram.earshot.ASSIGN.pitch', 'Pitch shift (semitones)'), 'wea-pitch-val', -12, 12, 0.5, pitchShift)}
    ${slider('eqLowGain', loc('kaiserkram.earshot.ASSIGN.bass', 'Bass (dB)'), 'wea-low-val', -18, 18, 1, eqLowGain)}
    ${slider('eqHighGain', loc('kaiserkram.earshot.ASSIGN.treble', 'Treble (dB)'), 'wea-high-val', -18, 18, 1, eqHighGain)}
    ${slider('distortion', loc('kaiserkram.earshot.ASSIGN.growl', 'Growl (distortion)'), 'wea-growl-val', 0, 100, 5, distortion)}
    ${slider('echo', loc('kaiserkram.earshot.ASSIGN.echo', 'Echo (cave/spirit)'), 'wea-echo-val', 0, 100, 5, echo)}
    <div class="form-group" style="margin-top:12px; display:flex; gap:6px">
      <button type="button" id="wea-preview-btn" style="flex:1">${previewLabel(false)}</button>
      <button type="button" id="wea-reset-btn" title="${escapeHtml(
        loc('kaiserkram.earshot.ASSIGN.reset', 'Reset all sliders to 0'),
      )}" style="flex:0 0 auto">
        <i class="fas fa-undo"></i>
      </button>
    </div>
    <p class="notes" style="margin:4px 0 0">${escapeHtml(
      loc(
        'kaiserkram.earshot.ASSIGN.previewHint',
        'Hear yourself with these settings, live as you adjust them. Always open mic: push-to-talk does not apply here. Use headphones; on speakers the mic picks the playback up again.',
      ),
    )}</p>`;

  // Mute the GM's outgoing chain for the whole lifetime of the dialog: settings are applied to
  // the live voice as they change, and players must not hear the tuning happen.
  if (canMuteLive) voiceChangerProcessor.setOutputMuted(true);

  const readProfileFromForm = (form: HTMLFormElement): VoiceProfile => {
    const fd = new FormData(form);
    return {
      preset:     (fd.get('preset')     as VoicePreset) ?? 'none',
      pitchShift: parseFloat(fd.get('pitchShift') as string) || 0,
      eqLowGain:  parseFloat(fd.get('eqLowGain')  as string) || 0,
      eqHighGain: parseFloat(fd.get('eqHighGain') as string) || 0,
      distortion: parseFloat(fd.get('distortion') as string) || 0,
      echo:       parseFloat(fd.get('echo')       as string) || 0,
    };
  };

  const wire = (root: HTMLElement): void => {
    // AppV2 may call _onRender more than once; only wire the controls a single time.
    if (root.dataset.weaWired) return;
    root.dataset.weaWired = '1';

    const form = root.querySelector('form') as HTMLFormElement | null;
    if (!form) return;
    const $ = <T extends HTMLElement>(sel: string): T | null => root.querySelector<T>(sel);
    const input = (name: string): HTMLInputElement | null =>
      root.querySelector<HTMLInputElement>(`[name="${name}"]`);

    const VALUE_LABELS: Record<keyof SliderValues, string> = {
      pitchShift: '#wea-pitch-val',
      eqLowGain:  '#wea-low-val',
      eqHighGain: '#wea-high-val',
      distortion: '#wea-growl-val',
      echo:       '#wea-echo-val',
    };
    const setSlider = (name: keyof SliderValues, value: number): void => {
      const el = input(name);
      if (el) el.value = String(value);
      const label = $(VALUE_LABELS[name]);
      if (label) label.textContent = String(value);
    };
    for (const name of Object.keys(VALUE_LABELS) as (keyof SliderValues)[]) {
      input(name)?.addEventListener('input', function (this: HTMLInputElement) {
        const label = $(VALUE_LABELS[name]);
        if (label) label.textContent = this.value;
      });
    }

    // Live apply: rebuild the headphone preview and — when this actor is the pinned live
    // voice — the outgoing chain (muted above, so only the GM hears the tuning). Debounced:
    // range inputs fire continuously while dragging and a chain rebuild per event would glitch.
    let applyTimer: number | undefined;
    const applyLive = (): void => {
      window.clearTimeout(applyTimer);
      applyTimer = window.setTimeout(() => {
        const p = readProfileFromForm(form);
        if (voicePreviewer.isActive()) voicePreviewer.update(p);
        if (isLiveVoiceActor(actorId)) {
          void voiceChangerProcessor.applyProfile(p).catch(() => { /* preview keeps running */ });
        }
      }, 120);
    };
    for (const range of Array.from(root.querySelectorAll<HTMLInputElement>('input[type=range]'))) {
      range.addEventListener('input', applyLive);
      range.addEventListener('change', applyLive);
    }

    const updatePresetNote = (preset: VoicePreset): void => {
      const note = $('#wea-preset-note');
      if (note) note.style.display = preset === 'feminine' || preset === 'masculine' ? '' : 'none';
    };
    updatePresetNote(currentPreset);

    // Preset change loads its recipe into the sliders, then applies.
    const presetSel = root.querySelector<HTMLSelectElement>('select[name="preset"]');
    presetSel?.addEventListener('change', () => {
      const value = presetSel.value as VoicePreset;
      const recipe = PRESET_RECIPES[value];
      if (recipe) {
        for (const [name, v] of Object.entries(recipe)) {
          setSlider(name as keyof SliderValues, v);
        }
      }
      updatePresetNote(value);
      applyLive();
    });

    $('#wea-reset-btn')?.addEventListener('click', () => {
      for (const [name, value] of Object.entries(SLIDER_DEFAULTS)) {
        setSlider(name as keyof SliderValues, value);
      }
      applyLive();
    });

    const btn = $<HTMLButtonElement>('#wea-preview-btn');
    const setBtnState = (on: boolean): void => {
      if (btn) {
        btn.innerHTML = previewLabel(on);
      }
    };
    const startPreview = (notifyOnFail: boolean): void => {
      voicePreviewer
        .start(readProfileFromForm(form))
        .then(() => setBtnState(true))
        .catch((err: unknown) => {
          setBtnState(false);
          if (notifyOnFail) {
            notify().warn(fmt('kaiserkram.earshot.ASSIGN.previewFailed', 'Within Earshot: preview failed ({error})', { error: String(err) }));
          }
        });
    };
    btn?.addEventListener('click', () => {
      if (voicePreviewer.isActive()) {
        voicePreviewer.stop();
        setBtnState(false);
        return;
      }
      startPreview(true);
    });

    // The whole point of opening this dialog is hearing the result — start monitoring
    // immediately; the button remains as the off switch.
    startPreview(false);
  };

  const onClose = (): void => {
    if (openDialog === dialog) openDialog = null;
    voicePreviewer.stop();
    // Recovery net: if something ended the live mic capture (e.g. a device conflict from a
    // second getUserMedia), re-acquire it — otherwise the GM stays silent to players.
    const raw = voiceChangerProcessor.getRawInputStream();
    if (raw && raw.getAudioTracks().length > 0 && raw.getAudioTracks().every((t) => t.readyState === 'ended')) {
      console.warn('[kaiserkram] earshot: live mic track dead after dialog close, re-acquiring');
      const client = game.webrtc?.client as unknown as
        | { updateLocalStream?: () => Promise<void> }
        | undefined;
      void client?.updateLocalStream?.()?.catch?.(() => { /* */ });
    }
    if (canMuteLive) {
      voiceChangerProcessor.setOutputMuted(false);
      // Re-apply the persisted profile: reverts live tuning on Cancel, and after Save the
      // persisted profile is already the new one, so this is correct either way.
      if (isLiveVoiceActor(actorId)) {
        const stored = game.actors?.get(actorId);
        const saved = stored ? (getVoiceProfileForActor(stored) ?? { preset: 'none' as VoicePreset }) : null;
        if (saved) void voiceChangerProcessor.applyProfile(saved).catch(() => { /* */ });
      }
    }
  };

  const saveProfile = async (form: HTMLFormElement | null): Promise<void> => {
    if (!form) return;
    const fd = new FormData(form);
    const targetActorId = fd.get('actorId') as string;
    const targetActor = targetActorId ? game.actors?.get(targetActorId) : null;
    if (!targetActor) return;

    // Spread the stored profile first: fields this dialog doesn't edit (gainMultiplier,
    // set via the module API) must survive a save.
    const newProfile: VoiceProfile = {
      ...(getVoiceProfileForActor(targetActor) ?? {}),
      ...readProfileFromForm(form),
    };

    await persistVoiceProfileFlag(targetActor, newProfile);

    if (isLiveVoiceActor(targetActor.id as string)) {
      void voiceChangerProcessor.applyProfile(newProfile).catch((err: unknown) => {
        notify().warn(
          fmt('kaiserkram.earshot.VOICE.cannotApplyProfile', 'Within Earshot: could not apply voice profile ({error})', {
            error: String(err),
          }),
        );
      });
    }
  };

  const Dialog = voiceAssignDialogClass();
  const dialog = new Dialog(
    {
      window: { title: fmt('kaiserkram.earshot.ASSIGN.title', 'Assign Voice: {name}', { name: actorName }) },
      content,
      buttons: [
        {
          action: 'save',
          icon: 'fas fa-save',
          label: loc('kaiserkram.earshot.ASSIGN.save', 'Save'),
          default: true,
          callback: async (_event: unknown, button: { form?: HTMLFormElement | null }) => {
            await saveProfile(button.form ?? null);
          },
        },
        { action: 'cancel', icon: 'fas fa-times', label: loc('kaiserkram.earshot.ASSIGN.cancel', 'Cancel') },
      ],
    },
    wire,
    onClose,
  );
  openDialog = dialog;
  await dialog.render({ force: true });
}
