import { notify } from '../../core/foundryApi.js';
import { fmt } from '../../core/i18n.js';
import { proximityRouter, scheduleProximityRefresh } from './proximityAudioRouter.js';
import { voiceChangerProcessor } from './voiceChangerProcessor.js';
import { getVoiceProfileForActor } from './voiceProfile.js';
import { getVoiceTokenIdFromUser } from './voiceToken.js';

type BaseClient = typeof foundry.av.clients.SimplePeerAVClient;

/** How long to wait between stream-ready poll attempts (ms). */
const WIRE_RETRY_DELAY_MS = 100;
/** Maximum attempts before giving up and falling back to video-element audio. */
const WIRE_MAX_ATTEMPTS = 30;

/**
 * Routes each remote MediaStream through Web Audio gain nodes for proximity.
 * Mutes the default video-element audio only after the Web Audio path is confirmed live,
 * so a failed wiring attempt falls back to native browser audio rather than silence.
 */
function defineProximityClient(Base: BaseClient) {
  return class ProximitySimplePeerAVClient extends Base {
    /** Pending video elements awaiting Web Audio wiring before being muted. */
    readonly #videoElements = new Map<string, HTMLVideoElement>();
    /** Bumped whenever a peer's wiring loop should be abandoned (disconnect / re-wire), so a late poll tick from a superseded loop is a no-op. */
    readonly #wireGeneration = new Map<string, number>();

    #invalidateWireLoop(userId: string): number {
      const gen = (this.#wireGeneration.get(userId) ?? 0) + 1;
      this.#wireGeneration.set(userId, gen);
      return gen;
    }

    /**
     * SimplePeerAVClient has no `getUserMedia` — this is the real mic acquisition point, called by
     * both `connect` and `updateLocalStream` (device switch). For the GM, the voice changer's
     * processed track is swapped into the stream **in place**: `connectPeer` / `updateLocalStream`
     * ship `this.localStream` after this returns, and `levelsStream` (VU meter / voice activation)
     * was already cloned from the raw mic.
     */
    override async initializeLocalStream(): Promise<MediaStream | null> {
      const stream = await super.initializeLocalStream();
      if (!game.user?.isGM || !stream) return stream;
      const rawTrack = stream.getAudioTracks()[0];
      // Guard against double-processing when a caller chains back into this method.
      if (!rawTrack || voiceChangerProcessor.ownsTrack(rawTrack)) return stream;
      try {
        // Fresh graph per acquisition so a device switch re-wires from the new mic.
        await voiceChangerProcessor.initialize(new MediaStream([rawTrack]));
        const processedTrack = voiceChangerProcessor.getProcessedStream()?.getAudioTracks()[0];
        if (processedTrack) {
          stream.removeTrack(rawTrack);
          stream.addTrack(processedTrack);
          await this.#applyPinnedVoiceProfile();
        }
      } catch (err) {
        notify().warn(
          fmt('kaiserkram.earshot.VOICE.voiceChangerUnavailable', 'Within Earshot: voice changer unavailable ({error})', {
            error: String(err),
          }),
        );
      }
      return stream;
    }

    /** Re-apply the profile of the GM's pinned voice token after the graph is (re)built. */
    async #applyPinnedVoiceProfile(): Promise<void> {
      const user = game.user;
      if (!user) return;
      const pinnedId = getVoiceTokenIdFromUser(user);
      const actor = pinnedId ? (canvas?.scene?.tokens.get(pinnedId)?.actor ?? null) : null;
      await voiceChangerProcessor.applyProfile(actor ? getVoiceProfileForActor(actor) : null);
    }

    override async initializePeerStream(userId: string): Promise<SimplePeer.Instance> {
      const inst = await super.initializePeerStream(userId);
      void this.#wirePeerWhenReady(userId, this.#invalidateWireLoop(userId));
      return inst;
    }

    override async disconnectPeer(userId: string): Promise<void> {
      this.#videoElements.delete(userId);
      this.#invalidateWireLoop(userId);
      proximityRouter.detachPeer(userId);
      return super.disconnectPeer(userId);
    }

    override async disconnectAll(): Promise<void[]> {
      this.#videoElements.clear();
      for (const userId of this.#wireGeneration.keys()) this.#invalidateWireLoop(userId);
      proximityRouter.detachAll();
      return super.disconnectAll();
    }

    override async disconnect(): Promise<boolean> {
      this.#videoElements.clear();
      for (const userId of this.#wireGeneration.keys()) this.#invalidateWireLoop(userId);
      proximityRouter.detachAll();
      voiceChangerProcessor.reset();
      return super.disconnect();
    }

    /**
     * Re-wire Web Audio for every currently connected peer. The underlying WebRTC connections are
     * not scene-scoped, so `canvasTearDown` (which detaches the Web Audio graph only) needs this on
     * the following `canvasReady` or remote audio stays silently dropped until a full page reload.
     */
    async reattachAllPeers(): Promise<void> {
      await Promise.all(
        this.getConnectedUsers().map((userId) => this.#wirePeerWhenReady(userId, this.#invalidateWireLoop(userId))),
      );
    }

    override async setUserVideo(userId: string, videoElement: HTMLVideoElement): Promise<void> {
      await super.setUserVideo(userId, videoElement);
      if (userId !== game.user?.id) {
        this.#videoElements.set(userId, videoElement);
        // If the peer is already wired through Web Audio, mute the element immediately.
        // Otherwise #wirePeerWhenReady will mute it once the audio graph is attached.
        if (proximityRouter.hasPeer(userId)) {
          videoElement.muted = true;
          videoElement.volume = 0;
        }
      }
      scheduleProximityRefresh();
    }

    override async onSettingsChanged(changed: unknown): Promise<void> {
      await super.onSettingsChanged(changed as never);
      scheduleProximityRefresh();
    }

    async #wirePeerWhenReady(userId: string, gen: number, attempt = 0): Promise<void> {
      // A disconnect, reconnect, or reattachAllPeers() superseded this loop — abandon it.
      if (this.#wireGeneration.get(userId) !== gen) return;
      const stream = this.getMediaStreamForUser(userId);
      if (stream && stream.getAudioTracks().length > 0) {
        proximityRouter.attachPeer(userId, stream);
        await proximityRouter.ensureResumed();
        // Mute the video element now that Web Audio is handling the stream.
        const el = this.#videoElements.get(userId);
        if (el) {
          el.muted = true;
          el.volume = 0;
        }
        return;
      }
      if (attempt >= WIRE_MAX_ATTEMPTS) {
        console.warn(
          `[kaiserkram] earshot: could not attach Web Audio for user ${userId} after ${WIRE_MAX_ATTEMPTS} attempts.` +
          ` Audio will play through the video element instead (no proximity attenuation).`,
        );
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, WIRE_RETRY_DELAY_MS));
      return this.#wirePeerWhenReady(userId, gen, attempt + 1);
    }
  };
}

let ProximityClient: ReturnType<typeof defineProximityClient> | undefined;

/** Built on first use so nothing touches `foundry.av` unless this feature is enabled. */
export function proximityClientClass(): ReturnType<typeof defineProximityClient> {
  ProximityClient ??= defineProximityClient(foundry.av.clients.SimplePeerAVClient);
  return ProximityClient;
}
