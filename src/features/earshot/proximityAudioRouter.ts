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
import { getGmVoiceGlobal, getMaxRange, getMuteUnresolvedSpeaker } from './settings.js';
import { clearClientGainStateForPeer, getFoundryClientGainForPeer } from './avClientGain.js';
import { pushAvSessionLog } from './avSessionLog.js';

interface PeerAudio {
  source: MediaStreamAudioSourceNode;
  profileGain: GainNode;
  /** Foundry dock volume / mute / block (replaces video-element volume on the default client). */
  clientGain: GainNode;
  proximityGain: GainNode;
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

export class ProximityAudioRouter {
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

    const remoteUser = game.users?.get(userId);
    const mult = getVoiceProfileForActor(remoteUser?.character ?? null)?.gainMultiplier ?? 1;
    profileGain.gain.value = Math.min(2, Math.max(0, mult));

    this.peers.set(userId, { source, profileGain, clientGain, proximityGain, stream });
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
    p.clientGain.gain.value = clientG;
    const env = this.computeGainForSpeaker(userId);
    let q = Math.min(1, Math.max(0, env));
    const prev = this.lastStableEnvGain.get(userId);
    if (prev !== undefined && Math.abs(q - prev) < ENV_GAIN_STICKY_EPS) {
      q = prev;
    } else {
      this.lastStableEnvGain.set(userId, q);
    }
    p.proximityGain.gain.value = q;
  }

  /** Recompute all remote peer gains (no artificial throttle — canvas ticker + hooks drive rate). */
  refreshAllGains(_force = true): void {
    for (const id of this.peers.keys()) this.refreshGain(id);
  }

  hasPeer(userId: string): boolean {
    return this.peers.has(userId);
  }

  get peerCount(): number {
    return this.peers.size;
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

    if (isGameMasterUser(speaker) && getGmVoiceGlobal()) return 1;

    if (isGameMasterUser(speaker) && !getVoiceTokenIdFromUser(speaker)) return 1;

    const maxRange = getMaxRange();

    if (!canvas?.scene) return 1;

    const listenerToken = getListenerTokenForProximity();
    if (!listenerToken) return 1;

    const speakerDoc = getSpeakerTokenDocumentForUser(speaker);
    if (!speakerDoc) {
      if (isGameMasterUser(speaker)) return 1;
      if (getMuteUnresolvedSpeaker()) return canvas.ready ? 0 : 1;
      return 1;
    }

    const lp = getProximityCenterFromToken(listenerToken);
    const sp = getCenterPointFromTokenDocument(speakerDoc);
    const listenerPoint = { x: lp.x, y: lp.y };
    const speakerPoint = { x: sp.x, y: sp.y };
    const distanceGrid = gridDistanceBetween(listenerPoint, speakerPoint);

    const proximity = computeProximityGain(distanceGrid, maxRange);
    const los = getVoiceLosMultiplier(listenerToken, speakerDoc);
    let combined = proximity * los;
    if (combined >= 0.995) combined = 1;

    return quantizeEnvGain(combined);
  }
}

export const proximityRouter = new ProximityAudioRouter();

let rafScheduled = false;

export function scheduleProximityRefresh(): void {
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    proximityRouter.refreshAllGains(true);
  });
}
