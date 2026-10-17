/** In-memory ring (cap) for post-mortem debugging — `game.modules.get('kaiserkram').api.features.earshot.getAvSessionLog()`. */
const MAX = 1500;
const buf: Array<{ t: number; tag: string; data?: unknown }> = [];

export function pushAvSessionLog(tag: string, data?: unknown): void {
  buf.push({ t: Date.now(), tag, data });
  if (buf.length > MAX) buf.splice(0, buf.length - MAX);
}

/** Newest entries last; default last 400 lines as compact JSON. */
export function getAvSessionLogSnapshot(maxLines = 400): string {
  const slice = buf.slice(-maxLines);
  return JSON.stringify(slice, null, 0);
}

export function clearAvSessionLog(): void {
  buf.length = 0;
}

export function copyAvSessionLogToClipboard(): void {
  const s = getAvSessionLogSnapshot();
  void navigator.clipboard?.writeText(s);
  pushAvSessionLog('session:copy', { len: s.length });
}
