import { proximityRouter, scheduleProximityRefresh } from './proximityAudioRouter.js';

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

    override async initializePeerStream(userId: string): Promise<SimplePeer.Instance> {
      const inst = await super.initializePeerStream(userId);
      void this.#wirePeerWhenReady(userId);
      return inst;
    }

    override async disconnectPeer(userId: string): Promise<void> {
      this.#videoElements.delete(userId);
      proximityRouter.detachPeer(userId);
      return super.disconnectPeer(userId);
    }

    override async disconnectAll(): Promise<void[]> {
      this.#videoElements.clear();
      proximityRouter.detachAll();
      return super.disconnectAll();
    }

    override async disconnect(): Promise<boolean> {
      this.#videoElements.clear();
      proximityRouter.detachAll();
      return super.disconnect();
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

    async #wirePeerWhenReady(userId: string, attempt = 0): Promise<void> {
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
      return this.#wirePeerWhenReady(userId, attempt + 1);
    }
  };
}

let ProximityClient: ReturnType<typeof defineProximityClient> | undefined;

/** Built on first use so nothing touches `foundry.av` unless this feature is enabled. */
export function proximityClientClass(): ReturnType<typeof defineProximityClient> {
  ProximityClient ??= defineProximityClient(foundry.av.clients.SimplePeerAVClient);
  return ProximityClient;
}
