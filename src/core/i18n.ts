/** Resolve an i18n key once the module's language file is loaded; otherwise show the English fallback. */
export function loc(key: string, fallback: string): string {
  const v = game.i18n?.localize(key) ?? key;
  return v === key ? fallback : v;
}

/** Like `loc`, with `{name}` placeholders filled from `data`. */
export function fmt(key: string, fallback: string, data: Record<string, unknown>): string {
  const template = loc(key, fallback);
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in data ? String(data[k]) : m));
}
