import { PITCH_SHIFT_WORKLET_CODE } from './pitchShiftWorklet.js';
import { pushAvSessionLog } from './avSessionLog.js';
import { buildVoiceChain, teardownVoiceChain } from './voiceChain.js';
import type { VoiceChainNodes } from './voiceChain.js';
import type { VoiceProfile } from './voiceProfile.js';

type State = 'uninitialized' | 'initializing' | 'ready' | 'disposed';

class VoiceChangerProcessor {
  private ctx: AudioContext | null = null;
  private rawInputStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private destNode: MediaStreamAudioDestinationNode | null = null;
  private processedStream: MediaStream | null = null;
  private chain: VoiceChainNodes | null = null;
  private state: State = 'uninitialized';
  private workletReady = false;
  private workletFailed = false;
  private pendingProfile: VoiceProfile | null = null;
  private workletBlobUrl: string | null = null;
  private chainBaseGain = 1;
  private outputMuted = false;

  isInitialized(): boolean {
    return this.state === 'ready';
  }

  getProcessedStream(): MediaStream | null {
    return this.processedStream;
  }

  /**
   * The raw mic stream feeding this processor. The dialog preview taps it instead of opening a
   * second getUserMedia capture: Firefox can end/silence the first capture when the same device
   * is opened twice with conflicting constraints, leaving the GM mute to players.
   */
  getRawInputStream(): MediaStream | null {
    return this.rawInputStream;
  }

  /** True when the track is this processor's output (lets callers avoid re-processing it). */
  ownsTrack(track: MediaStreamTrack): boolean {
    return this.processedStream?.getAudioTracks().includes(track) ?? false;
  }

  /**
   * Hard-mute the processed output at the chain gain. Unlike toggling track.enabled — which
   * Foundry's voice-activation gating flips on speech and would undo — a zero gain guarantees
   * peers hear silence, e.g. while the GM tunes a voice in the Assign Voice dialog.
   */
  setOutputMuted(muted: boolean): void {
    this.outputMuted = muted;
    if (this.chain) this.chain.outputGain.gain.value = muted ? 0 : this.chainBaseGain;
  }

  async initialize(micStream: MediaStream): Promise<void> {
    if (this.state === 'initializing') return;
    // Re-initialization (new mic stream after a device switch) tears down the old graph first.
    if (this.state !== 'uninitialized') this.reset();
    this.state = 'initializing';
    try {
      this.ctx = new AudioContext({ sampleRate: 48000 });
      this.resumeWhenAllowed();

      this.rawInputStream = micStream;
      this.sourceNode = this.ctx.createMediaStreamSource(micStream);
      this.destNode = this.ctx.createMediaStreamDestination();
      this.processedStream = this.destNode.stream;

      await this.ensureWorklet();

      await this.buildChain(this.pendingProfile ?? { preset: 'none' });
      this.pendingProfile = null;

      this.state = 'ready';
      pushAvSessionLog('voiceChanger:initialized', {});
    } catch (err) {
      this.state = 'uninitialized';
      throw err;
    }
  }

  async applyProfile(profile: VoiceProfile | null): Promise<void> {
    if (this.state === 'disposed') return;
    if (this.state !== 'ready') {
      this.pendingProfile = profile;
      return;
    }
    await this.buildChain(profile ?? { preset: 'none' });
    pushAvSessionLog('voiceChanger:applyProfile', { preset: profile?.preset ?? 'none' });
  }

  dispose(): void {
    if (this.state === 'disposed') return;
    this.tearDownChain();
    try { this.sourceNode?.disconnect(); } catch { /* */ }
    try { this.ctx?.close(); } catch { /* */ }
    if (this.workletBlobUrl) {
      URL.revokeObjectURL(this.workletBlobUrl);
      this.workletBlobUrl = null;
    }
    this.ctx = null;
    this.rawInputStream = null;
    this.sourceNode = null;
    this.destNode = null;
    this.processedStream = null;
    this.chain = null;
    this.state = 'disposed';
    this.workletReady = false;
    this.workletFailed = false;
    this.pendingProfile = null;
    pushAvSessionLog('voiceChanger:disposed', {});
  }

  reset(): void {
    this.dispose();
    this.state = 'uninitialized';
  }

  /**
   * Never `await ctx.resume()` here: under autoplay policy the promise can stay pending until a
   * user gesture, which would stall the whole A/V connect inside initializeLocalStream.
   */
  private resumeWhenAllowed(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'suspended') return;
    void ctx.resume().catch(() => { /* retried on next gesture */ });
    window.addEventListener(
      'pointerdown',
      () => {
        if (this.ctx?.state === 'suspended') void this.ctx.resume().catch(() => { /* */ });
      },
      { once: true },
    );
  }

  private async ensureWorklet(): Promise<void> {
    if (this.workletReady || this.workletFailed || !this.ctx) return;
    try {
      const blob = new Blob([PITCH_SHIFT_WORKLET_CODE], { type: 'application/javascript' });
      this.workletBlobUrl = URL.createObjectURL(blob);
      await this.ctx.audioWorklet.addModule(this.workletBlobUrl);
      this.workletReady = true;
    } catch (err) {
      console.warn('[kaiserkram] earshot: pitch shift worklet unavailable (CSP or browser issue). EQ-only mode active.', err);
      this.workletFailed = true;
    }
  }

  private async buildChain(profile: VoiceProfile): Promise<void> {
    if (!this.ctx || !this.sourceNode || !this.destNode) return;
    this.tearDownChain();
    this.chain = buildVoiceChain(
      this.ctx,
      this.sourceNode,
      this.destNode,
      profile,
      this.workletReady && !this.workletFailed,
    );
    // A rebuild (applyProfile) while muted must not unmute: remember the preset's own level.
    this.chainBaseGain = this.chain.outputGain.gain.value;
    if (this.outputMuted) this.chain.outputGain.gain.value = 0;
  }

  private tearDownChain(): void {
    teardownVoiceChain(this.chain, this.sourceNode);
    this.chain = null;
  }
}

export const voiceChangerProcessor = new VoiceChangerProcessor();
