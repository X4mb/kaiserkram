/**
 * Dual-grain pitch shifter (classic "Jungle" delay-line design). Two read heads sweep a ring
 * buffer half a grain apart, each faded by a half-sine window (sin² + cos² = 1, equal power),
 * so the periodic wrap of each head lands at zero gain — no clicks, unlike a single drifting
 * read pointer which glitches every time it laps the write pointer.
 */
/** AudioWorklet processor name; must be the same in registerProcessor and new AudioWorkletNode. */
export const PITCH_SHIFT_PROCESSOR = 'kaiserkram-earshot-pitch-shift';

export const PITCH_SHIFT_WORKLET_CODE = `
class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: 'pitchFactor',
      defaultValue: 1.0,
      minValue: 0.25,
      maxValue: 4.0,
      automationRate: 'k-rate'
    }];
  }

  constructor() {
    super();
    this._bufSize = 8192;              // power of two; must exceed grain + 2
    this._buf = new Float32Array(this._bufSize);
    this._writePos = 0;
    this._win = 2048;                  // grain length (~43ms @ 48kHz, ~21ms avg latency)
    this._phase = 0;                   // grain phase in [0, 1)
  }

  _read(delay) {
    const mask = this._bufSize - 1;
    const pos = this._writePos - delay;
    const base = Math.floor(pos);
    const frac = pos - base;
    const s0 = this._buf[base & mask];
    const s1 = this._buf[(base + 1) & mask];
    return s0 + frac * (s1 - s0);
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0]?.[0];
    const output = outputs[0]?.[0];
    if (!output) return true;

    const factor = parameters.pitchFactor[0] ?? 1.0;
    const mask = this._bufSize - 1;
    const win = this._win;
    // delay(t) slope = 1 - factor, so read position advances at exactly \`factor\` per sample.
    const dPhase = (1 - factor) / win;

    for (let i = 0; i < output.length; i++) {
      this._buf[this._writePos & mask] = input ? input[i] : 0;
      this._writePos++;

      let p = this._phase + dPhase;
      p -= Math.floor(p);               // wrap into [0, 1) for either sweep direction
      this._phase = p;
      const p2 = p + 0.5 - Math.floor(p + 0.5);

      // delay in [1, win + 1]: always behind the write head, never past the buffer.
      const g1 = Math.sin(Math.PI * p);
      const g2 = Math.sin(Math.PI * p2);
      output[i] = g1 * this._read(1 + p * win) + g2 * this._read(1 + p2 * win);
    }

    return true;
  }
}

registerProcessor('${PITCH_SHIFT_PROCESSOR}', PitchShiftProcessor);
`;
