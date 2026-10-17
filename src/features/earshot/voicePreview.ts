import { PITCH_SHIFT_WORKLET_CODE } from './pitchShiftWorklet.js';
import { voiceChangerProcessor } from './voiceChangerProcessor.js';
import { buildVoiceChain, teardownVoiceChain } from './voiceChain.js';
import type { VoiceChainNodes } from './voiceChain.js';
import type { VoiceProfile } from './voiceProfile.js';

/**
 * GM self-monitor for the Assign Voice dialog: separate mic capture and AudioContext with the
 * chain output wired to the speakers, fully independent of the live RTC path so previewing can
 * never disturb what peers receive.
 */
class VoicePreviewer {
  private ctx: AudioContext | null = null;
  private micStream: MediaStream | null = null;
  /** Only stop tracks we captured ourselves — never the live A/V stream we merely tap. */
  private ownsMicStream = false;
  private source: MediaStreamAudioSourceNode | null = null;
  private chain: VoiceChainNodes | null = null;
  private workletReady = false;
  private starting = false;
  /** Live track we switched to raw processing for the monitor; restored on stop. */
  private tappedTrack: MediaStreamTrack | null = null;
  private tappedOriginal: MediaTrackConstraints | null = null;

  isActive(): boolean {
    return this.ctx !== null;
  }

  async start(profile: VoiceProfile): Promise<void> {
    if (this.starting || this.ctx) return;
    this.starting = true;
    try {
      // Prefer tapping the raw mic stream the live A/V path already holds: a second
      // getUserMedia on the same device with different constraints can end/silence the first
      // capture on Firefox (GM goes mute to players until the mic is re-acquired), and the
      // shared capture means the preview is exactly what players would hear. The raw input
      // feeds our graph before Foundry's push-to-talk / voice-activation gating (that toggles
      // the processed output track), so the preview is always open mic either way.
      const liveRaw = voiceChangerProcessor.getRawInputStream();
      let mic: MediaStream;
      if (liveRaw?.getAudioTracks().some((t) => t.readyState === 'live')) {
        mic = liveRaw;
        this.ownsMicStream = false;
        // Self-monitoring an echo-cancelled capture cancels the GM's own voice (the EC sees the
        // monitor playback as echo of the mic — the cut-outs). The GM is muted to players while
        // the dialog is open, so switch the live track to raw processing for the duration of
        // the preview and restore the original settings on stop.
        const track = mic.getAudioTracks().find((t) => t.readyState === 'live');
        if (track) {
          const s = track.getSettings() as {
            echoCancellation?: boolean;
            noiseSuppression?: boolean;
            autoGainControl?: boolean;
          };
          const original: MediaTrackConstraints = {};
          if (s.echoCancellation !== undefined) original.echoCancellation = s.echoCancellation;
          if (s.noiseSuppression !== undefined) original.noiseSuppression = s.noiseSuppression;
          if (s.autoGainControl !== undefined) original.autoGainControl = s.autoGainControl;
          try {
            await track.applyConstraints({
              echoCancellation: false,
              noiseSuppression: false,
              autoGainControl: false,
            });
            this.tappedTrack = track;
            this.tappedOriginal = original;
          } catch {
            // Constraint change unsupported: preview still works, just through the browser's
            // processing.
          }
        }
      } else {
        // No live A/V: capture raw (browser noise suppression / AGC clip word onsets and made
        // the monitor feel choppy). Prefer the input device from Foundry's A/V settings.
        const constraints: MediaTrackConstraints = {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        };
        const audioSrc = (game as unknown as {
          webrtc?: { settings?: { get(scope: string, key: string): unknown } };
        }).webrtc?.settings?.get('client', 'audioSrc');
        if (typeof audioSrc === 'string' && audioSrc !== 'disabled' && audioSrc !== 'default') {
          constraints.deviceId = { ideal: audioSrc };
        }
        mic = await navigator.mediaDevices.getUserMedia({ audio: constraints });
        this.ownsMicStream = true;
      }
      const ctx = new AudioContext({ sampleRate: 48000 });
      // The preview may auto-start with the dialog, where the opening gesture can already have
      // expired — never await resume (it can stay pending under autoplay policy); retry on the
      // next pointer gesture instead.
      void ctx.resume().catch(() => { /* retried below */ });
      if (ctx.state === 'suspended') {
        window.addEventListener(
          'pointerdown',
          () => {
            if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => { /* */ });
          },
          { once: true },
        );
      }
      try {
        const blobUrl = URL.createObjectURL(
          new Blob([PITCH_SHIFT_WORKLET_CODE], { type: 'application/javascript' }),
        );
        try {
          await ctx.audioWorklet.addModule(blobUrl);
          this.workletReady = true;
        } finally {
          URL.revokeObjectURL(blobUrl);
        }
      } catch {
        this.workletReady = false; // EQ-only preview, same degradation as the live chain
      }
      this.micStream = mic;
      this.ctx = ctx;
      this.source = ctx.createMediaStreamSource(mic);
      this.chain = buildVoiceChain(ctx, this.source, ctx.destination, profile, this.workletReady);
    } catch (err) {
      this.stop();
      throw err;
    } finally {
      this.starting = false;
    }
  }

  /** Rebuild the preview chain with new settings; no-op when the preview is not running. */
  update(profile: VoiceProfile): void {
    if (!this.ctx || !this.source) return;
    teardownVoiceChain(this.chain, this.source);
    this.chain = buildVoiceChain(this.ctx, this.source, this.ctx.destination, profile, this.workletReady);
  }

  stop(): void {
    teardownVoiceChain(this.chain, this.source);
    this.chain = null;
    try { this.source?.disconnect(); } catch { /* */ }
    this.source = null;
    if (this.tappedTrack && this.tappedOriginal) {
      void this.tappedTrack.applyConstraints(this.tappedOriginal).catch(() => { /* */ });
    }
    this.tappedTrack = null;
    this.tappedOriginal = null;
    if (this.ownsMicStream) {
      for (const t of this.micStream?.getTracks() ?? []) t.stop();
    }
    this.ownsMicStream = false;
    this.micStream = null;
    try { void this.ctx?.close(); } catch { /* */ }
    this.ctx = null;
    this.workletReady = false;
  }
}

export const voicePreviewer = new VoicePreviewer();
