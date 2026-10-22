import { getVoiceProfileForActor } from './voiceProfile.js';
import {
  computeProximityGain,
  getCenterPointFromTokenDocument,
  getListenerTokenForProximity,
  getProximityCenterFromToken,
  gridDistanceBetween,
} from './proximity.js';
import { getVoiceLosMultiplier } from './proximityLos.js';
import { getSpeakerTokenDocumentForUser, getVoiceTokenIdFromUser } from './voiceToken.js';
import { getGmVoiceGlobal, getMaxRange, getMuteUnresolvedSpeaker, getWhisperRange } from './settings.js';
import { isWhispering } from './whisper.js';
import { clearClientGainStateForPeer, getFoundryClientGainForPeer } from './avClientGain.js';
import { pushAvSessionLog } from './avSessionLog.js';

interface PeerAudio {
  source: MediaStreamAudioSourceNode;
  profileGain: GainNode;
  /** Foundry dock volume / mute / block (replaces video-element volume on the default client). */
  clientGain: GainNode;
  proximityGain: GainNode;
  /** After every gain stage: how loud this peer is *to this listener* (drives the speaking ring). */
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  stream: MediaStream;
}

/**
 * Quantize environmental gain (distance × walls). 5% steps — 1% steps still flipped at LOS/distance
 * boundaries every frame while idle.
 */
function quantizeEnvGain(x: number): number {
  const c = Math.min(1, Math.max(0, x));
  return Math.round(c * 20) / 20;
}

/** Ignore sub-threshold wobble vs last applied env gain (same peer, standing still / wall edge). */
const ENV_GAIN_STICKY_EPS = 0.04;

/**
 * Remote User#isGM can be unreliable on non-GM clients; fall back to role / hasRole so GM audio
 * is not muted when !speakerDoc (see computeGainForSpeaker).
 */
function isGameMasterUser(user: User | null | undefined): boolean {
  if (!user) return false;
  if (user.isGM === true) return true;
  const role = (user as unknown as { role?: number }).role;
  if (typeof role === 'number' && role >= CONST.USER_ROLES.ASSISTANT) return true;
  try {
    return user.hasRole(CONST.USER_ROLES.GAMEMASTER, { exact: false });
  } catch {
    return false;
  }
}

/**
 * Whether `user`'s whisper is in effect. A whisper needs a place to come from: a GM without a
 * pinned voice token stays omnipresent.
 */
export function whisperApplies(user: User | null | undefined): boolean {
  if (!user || !isWhispering(user)) return false;
  return !isGameMasterUser(user) || !!getVoiceTokenIdFromUser(user);
}

class ProximityAudioRouter {
  private audioContext: AudioContext | null = null;
  private readonly peers = new Map<string, PeerAudio>();
  private readonly lastStableEnvGain = new Map<string, number>();

  get context(): AudioContext {
    if (!this.audioContext) this.audioContext = new AudioContext();
    return this.audioContext;
  }

  async ensureResumed(): Promise<void> {
    const ctx = this.context;
    if (ctx.state === 'suspended') await ctx.resume();
  }

  attachPeer(userId: string, stream: MediaStream): void {
    if (this.peers.has(userId)) this.detachPeer(userId);
    const ctx = this.context;
    const source = ctx.createMediaStreamSource(stream);
    const profileGain = ctx.createGain();
    const clientGain = ctx.createGain();
    const proximityGain = ctx.createGain();
    source.connect(profileGain);
    profileGain.connect(clientGain);
    clientGain.connect(proximityGain);
    proximityGain.connect(ctx.destination);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    proximityGain.connect(analyser);

    const remoteUser = game.users?.get(userId);
    const mult = getVoiceProfileForActor(remoteUser?.character ?? null)?.gainMultiplier ?? 1;
    profileGain.gain.value = Math.min(2, Math.max(0, mult));

    const samples = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
    this.peers.set(userId, { source, profileGain, clientGain, proximityGain, analyser, samples, stream });
    this.lastStableEnvGain.delete(userId);
    pushAvSessionLog('peer:attach', { userId });
    this.refreshGain(userId);
  }

  detachPeer(userId: string): void {
    this.lastStableEnvGain.delete(userId);
    clearClientGainStateForPeer(userId);
    pushAvSessionLog('peer:detach', { userId });
    const p = this.peers.get(userId);
    if (!p) return;
    try {
      p.source.disconnect();
      p.profileGain.disconnect();
      p.clientGain.disconnect();
      p.proximityGain.disconnect();
      p.analyser.disconnect();
    } catch {
      /* already disconnected */
    }
    this.peers.delete(userId);
  }

  detachAll(): void {
    for (const id of [...this.peers.keys()]) this.detachPeer(id);
  }

  refreshGain(userId: string): void {
    const p = this.peers.get(userId);
    if (!p) return;
    const rawClient = getFoundryClientGainForPeer(userId);
    const clientG =
      rawClient <= 0 ? 0 : rawClient >= 1 ? 1 : Math.round(rawClient * 20) / 20;
    glideTo(p.clientGain.gain, clientG);
    const env = this.computeGainForSpeaker(userId);
    let q = Math.min(1, Math.max(0, env));
    const prev = this.lastStableEnvGain.get(userId);
    if (prev !== undefined && Math.abs(q - prev) < ENV_GAIN_STICKY_EPS) {
      q = prev;
    } else {
      this.lastStableEnvGain.set(userId, q);
    }
    glideTo(p.proximityGain.gain, q);
  }

  /** Recompute every remote peer's gain; run when something that affects it changes. */
  refreshAllGains(): void {
    for (const id of this.peers.keys()) this.refreshGain(id);
  }

  /** RMS level (0–1) of what this listener hears from `userId` right now; 0 when not attached. */
  levelOf(userId: string): number {
    const p = this.peers.get(userId);
    if (!p) return 0;
    p.analyser.getFloatTimeDomainData(p.samples);
    let sum = 0;
    for (const v of p.samples) sum += v * v;
    return Math.sqrt(sum / p.samples.length);
  }

  /** Users with an attached audio graph. */
  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  hasPeer(userId: string): boolean {
    return this.peers.has(userId);
  }

  updateProfileGainForUser(userId: string): void {
    const p = this.peers.get(userId);
    if (!p) return;
    const remoteUser = game.users?.get(userId);
    const mult = getVoiceProfileForActor(remoteUser?.character ?? null)?.gainMultiplier ?? 1;
    p.profileGain.gain.value = Math.min(2, Math.max(0, mult));
  }

  private computeGainForSpeaker(speakerUserId: string): number {
    const speaker = game.users?.get(speakerUserId);
    if (!speaker) return 1;

    if (isGameMasterUser(game.user)) return 1;

    const gmSpeaker = isGameMasterUser(speaker);
    const whisper = whisperApplies(speaker);

    if (!whisper && gmSpeaker && getGmVoiceGlobal()) return 1;

    if (!whisper && gmSpeaker && !getVoiceTokenIdFromUser(speaker)) return 1;

    const maxRange = getMaxRange();

    // From here on, "can't place someone" means full volume normally, but silence for a whisper.
    if (!canvas?.scene) return whisper ? 0 : 1;

    const listenerToken = getListenerTokenForProximity();
    if (!listenerToken) return whisper ? 0 : 1;

    const speakerDoc = getSpeakerTokenDocumentForUser(speaker);
    if (!speakerDoc) {
      if (whisper) return 0;
      if (isGameMasterUser(speaker)) return 1;
      if (getMuteUnresolvedSpeaker()) return canvas.ready ? 0 : 1;
      return 1;
    }

    const lp = getProximityCenterFromToken(listenerToken);
    const sp = getCenterPointFromTokenDocument(speakerDoc);
    const listenerPoint = { x: lp.x, y: lp.y };
    const speakerPoint = { x: sp.x, y: sp.y };
    const distanceGrid = gridDistanceBetween(listenerPoint, speakerPoint);
    if (whisper && distanceGrid > getWhisperRange()) return 0;

    const proximity = computeProximityGain(distanceGrid, maxRange);
    const los = getVoiceLosMultiplier(listenerToken, speakerDoc);
    let combined = proximity * los;
    if (combined >= 0.995) combined = 1;

    return quantizeEnvGain(combined);
  }
}

/** How quickly a voice follows a change in distance or walls (seconds to ~63%): a fade, not a click. */
const GLIDE_S = 0.08;

/** The value each gain is gliding towards, so an unchanged one isn't rescheduled. */
const targets = new WeakMap<AudioParam, number>();

/** Move a gain to `value` smoothly, and only when it actually changes. */
function glideTo(param: AudioParam, value: number): void {
  const target = targets.get(param);
  if (target === undefined) {
    // A new voice starts where it belongs: no fade in from full volume (that could leak a whisper).
    targets.set(param, value);
    param.value = value;
    return;
  }
  if (Math.abs(target - value) < 1e-4) return;
  targets.set(param, value);
  // Every peer's nodes live on the router's context.
  const now = proximityRouter.context.currentTime;
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, GLIDE_S);
}

export const proximityRouter = new ProximityAudioRouter();

let rafScheduled = false;

export function scheduleProximityRefresh(): void {
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    proximityRouter.refreshAllGains();
  });
}
