import { PITCH_SHIFT_PROCESSOR } from './pitchShiftWorklet.js';
import type { VoiceProfile, VoicePreset } from './voiceProfile.js';

export interface VoiceChainNodes {
  workletNode: AudioWorkletNode | null;
  filters: AudioNode[];
  ringOsc: OscillatorNode | null;
  outputGain: GainNode;
}

/** Soft-clip curve for the growl stage; amount 0–100. */
function makeDistortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const k = amount * 3; // 0–300: subtle at 10, snarling at 60+
  const n = 8192;
  const curve = new Float32Array(new ArrayBuffer(n * 4));
  const deg = Math.PI / 180;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((3 + k) * x * 20 * deg) / (Math.PI + k * Math.abs(x));
  }
  return curve;
}

/**
 * Wire source → (chain) → outputGain → sink inside ctx and return the created nodes.
 * Shared by the live processor (sink = MediaStreamAudioDestinationNode feeding peers) and the
 * dialog preview (sink = ctx.destination, the GM's own speakers) so both hear the same chain.
 * Callers own teardown via teardownVoiceChain. workletAvailable gates the pitch-shift stage.
 *
 * Stage order: pitch → preset character (robot ring-mod / whisper filter) → shelf EQ →
 * growl (waveshaper) → echo (feedback delay). Every slider applies for every preset; the
 * preset only contributes its special stage and a pitch fallback.
 */
export function buildVoiceChain(
  ctx: AudioContext,
  source: AudioNode,
  sink: AudioNode,
  profile: VoiceProfile,
  workletAvailable: boolean,
): VoiceChainNodes {
  const preset: VoicePreset = profile.preset ?? 'none';
  const outputGain = ctx.createGain();
  outputGain.connect(sink);
  outputGain.gain.value = 1.0;

  const filters: AudioNode[] = [];
  let workletNode: AudioWorkletNode | null = null;
  let ringOsc: OscillatorNode | null = null;

  /** Slider at 0 (or unset) means "use the preset's character" — these presets shift by default. */
  const presetDefaultShift =
    preset === 'deep' ? -4
    : preset === 'high' ? 4
    : preset === 'feminine' ? 3.5
    : preset === 'masculine' ? -3.5
    : 0;
  const pitchShift = profile.pitchShift || presetDefaultShift;
  const pitchFactor = Math.pow(2, pitchShift / 12);

  let head: AudioNode = source;

  // --- Pitch stage ---
  if (Math.abs(pitchFactor - 1.0) > 0.001 && workletAvailable) {
    workletNode = new AudioWorkletNode(ctx, PITCH_SHIFT_PROCESSOR, {
      parameterData: { pitchFactor },
    });
    head.connect(workletNode);
    head = workletNode;
    filters.push(workletNode);
  }

  // --- Preset character stage ---
  if (preset === 'robot') {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1000;
    bp.Q.value = 0.8;

    // Ring modulator: multiply signal by oscillator
    const ringGain = ctx.createGain();
    ringGain.gain.value = 0; // oscillator drives this AudioParam

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 60;
    osc.connect(ringGain.gain);
    osc.start();
    ringOsc = osc;

    head.connect(bp);
    bp.connect(ringGain);
    head = ringGain;
    filters.push(bp, ringGain);
    outputGain.gain.value = 0.8;
  } else if (preset === 'whisper') {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4000;

    const mid = ctx.createBiquadFilter();
    mid.type = 'peaking';
    mid.frequency.value = 800;
    mid.gain.value = -6;

    head.connect(lp);
    lp.connect(mid);
    head = mid;
    filters.push(lp, mid);
    outputGain.gain.value = 0.35;
  }

  // --- Shelf EQ stage (always active; 250 Hz / 3 kHz sit where speech actually lives) ---
  const eqLow = profile.eqLowGain ?? 0;
  const eqHigh = profile.eqHighGain ?? 0;
  if (eqLow !== 0 || eqHigh !== 0) {
    const low = ctx.createBiquadFilter();
    low.type = 'lowshelf';
    low.frequency.value = 250;
    low.gain.value = eqLow;

    const high = ctx.createBiquadFilter();
    high.type = 'highshelf';
    high.frequency.value = 3000;
    high.gain.value = eqHigh;

    head.connect(low);
    low.connect(high);
    head = high;
    filters.push(low, high);
  }

  // --- Growl stage ---
  const distortion = Math.max(0, Math.min(100, profile.distortion ?? 0));
  if (distortion > 0) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = makeDistortionCurve(distortion);
    shaper.oversample = '4x';
    // The curve boosts overall level; pull it back so growl doesn't read as "louder = better".
    const makeup = ctx.createGain();
    makeup.gain.value = 1 / (1 + distortion / 40);
    head.connect(shaper);
    shaper.connect(makeup);
    head = makeup;
    filters.push(shaper, makeup);
  }

  // --- Echo stage (parallel dry/wet feedback delay) ---
  const echo = Math.max(0, Math.min(100, profile.echo ?? 0));
  if (echo > 0) {
    const dry = ctx.createGain();
    dry.gain.value = 1.0;
    const delay = ctx.createDelay(1.0);
    delay.delayTime.value = 0.22;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.35;
    const wet = ctx.createGain();
    wet.gain.value = (echo / 100) * 0.9;

    head.connect(dry);
    dry.connect(outputGain);
    head.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(outputGain);
    filters.push(dry, delay, feedback, wet);
  } else {
    head.connect(outputGain);
  }

  return { workletNode, filters, ringOsc, outputGain };
}

export function teardownVoiceChain(chain: VoiceChainNodes | null, source?: AudioNode | null): void {
  if (!chain) return;
  const { workletNode, filters, ringOsc, outputGain } = chain;
  try { ringOsc?.stop(); } catch { /* */ }
  try { ringOsc?.disconnect(); } catch { /* */ }
  for (const node of filters) {
    try { node.disconnect(); } catch { /* */ }
  }
  try { workletNode?.disconnect(); } catch { /* */ }
  try { outputGain.disconnect(); } catch { /* */ }
  try { source?.disconnect(); } catch { /* */ }
}
