/**
 * Foundry stores per-remote-user hearing preferences (volume, mute, block) in client AV settings.
 * Default SimplePeer routes audio through the video element volume; we use Web Audio, so we must
 * apply the same factors on a GainNode.
 *
 * Priority (first match wins):
 *   1. muteAll          → 0  (global mute-all from client)
 *   2. muted || blocked → 0  (per-user dock mute or block)
 *   3. otherwise        → volume (0–1; schema default is 1, so a persisted 0 is an explicit mute)
 */
export function getFoundryClientGainForPeer(userId: string): number {
  const settings = game.webrtc?.settings;
  if (!settings) return 1;
  if (settings.client.muteAll) return 0;
  const u = settings.getUser(userId);
  if (!u) return 1;
  if (u.muted || u.blocked) return 0;
  const v = u.volume;
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1;
}
