import { pushAvSessionLog } from './avSessionLog.js';

const lastClientState = new Map<string, string>();

/** Call when WebRTC peer disconnects so the next connection logs fresh state. */
export function clearClientGainStateForPeer(userId: string): void {
  lastClientState.delete(userId);
}

/**
 * Foundry stores per-remote-user hearing preferences (volume, mute, block) in client AV settings.
 * Default SimplePeer routes audio through the video element volume; we use Web Audio, so we must
 * apply the same factors on a GainNode.
 *
 * Priority (first match wins):
 *   1. muteAll          → 0  (global mute-all from client)
 *   2. muted || blocked → 0  (per-user dock mute or block)
 *   3. volume <= 0      → 1  (Foundry reports 0 before the dock applies its default — treat as full)
 *   4. otherwise        → volume (0–1)
 */
export function getFoundryClientGainForPeer(userId: string): number {
  let tag: string;
  let result: number;

  const settings = game.webrtc?.settings;
  if (!settings) {
    tag = 'no_webrtc_settings';
    result = 1;
  } else if (settings.client.muteAll) {
    tag = 'muteAll';
    result = 0;
  } else {
    const u = settings.getUser(userId);
    if (!u) {
      tag = 'no_user_row';
      result = 1;
    } else if (u.muted) {
      tag = 'muted';
      result = 0;
    } else if (u.blocked) {
      tag = 'blocked';
      result = 0;
    } else {
      const v = u.volume;
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        tag = 'volume_invalid';
        result = 1;
      } else if (v <= 0) {
        tag = 'volume_zero_as_full';
        result = 1;
      } else {
        tag = 'volume';
        result = Math.min(1, Math.max(0, v));
      }
    }
  }

  const sig = `${tag}:${result}`;
  if (lastClientState.get(userId) !== sig) {
    lastClientState.set(userId, sig);
    pushAvSessionLog('clientGain', { userId, tag, result });
  }

  return result;
}
