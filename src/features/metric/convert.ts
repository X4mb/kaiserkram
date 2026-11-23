/**
 * Imperial units in text, shown in metric. Table rounding, as the toggle promises: a yard counts
 * as a metre (so yard values keep their numbers), a foot as 0.3 m, a mile as 1.6 km and an inch as
 * 2.5 cm. Only units with a number before them are converted for feet, miles and inches ("at your
 * feet" stays feet); yards are converted wherever the word stands ("Willpower yards").
 */

const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;

/** "1.5" → 1.5, "1,5" → 1.5 */
function read(n: string): number {
  return Number(n.replace(',', '.'));
}

/** At most one decimal, none when whole: 1.5, 2, 0.3 */
function show(n: number): string {
  return String(Math.round(n * 10) / 10);
}

type Rule = [RegExp, (match: string, ...groups: string[]) => string];

/** Keep the capital of the word it replaces: "Yards" → "Metres". */
function sameCase(word: string, replacement: string): string {
  return word[0] === word[0].toUpperCase() ? replacement[0].toUpperCase() + replacement.slice(1) : replacement;
}

const RULES: Rule[] = [
  [new RegExp(String.raw`${NUMBER}(\s*|-)(feet|foot|ft\.?)(?![a-z])`, 'gi'), (_m, n, gap) => `${show(read(n) * 0.3)}${gap || ''}m`],
  [new RegExp(String.raw`${NUMBER}(\s*|-)(miles?)\b`, 'gi'), (_m, n, gap) => `${show(read(n) * 1.6)}${gap || ''}km`],
  [new RegExp(String.raw`${NUMBER}(\s*|-)(inch(?:es)?)\b`, 'gi'), (_m, n, gap) => `${show(read(n) * 2.5)}${gap || ''}cm`],
  // Yards: the number stays, only the unit changes.
  [/\b(yards)\b/gi, (m) => sameCase(m, 'metres')],
  [/\b(yard)\b(?=[^a-z]|$)/gi, (m) => sameCase(m, 'metre')],
  [/\b(yds?)\b\.?/gi, () => 'm'],
];

/** Quick test before the real work: does the text mention any unit at all? */
const ANY_UNIT = /yard|yd|feet|foot|ft|mile|inch/i;

export function toMetric(text: string): string {
  if (!ANY_UNIT.test(text)) return text;
  let out = text;
  for (const [pattern, replace] of RULES) out = out.replace(pattern, replace as (substring: string, ...args: string[]) => string);
  return out;
}

/** A scene's distance unit in metric: the factor and the new name; null when already metric. */
export function metricUnit(units: string): { factor: number; name: string } | null {
  const u = units.trim().toLowerCase().replace(/\.$/, '');
  if (['ft', 'feet', 'foot'].includes(u)) return { factor: 0.3, name: 'm' };
  if (['yd', 'yds', 'yard', 'yards'].includes(u)) return { factor: 1, name: 'm' };
  if (['mi', 'mile', 'miles'].includes(u)) return { factor: 1.6, name: 'km' };
  return null;
}

/**
 * Every number in `text` times `factor`, written for `lang` ("+15" → "+4,5" in German). Foundry
 * writes ruler numbers with the language's separators, so they are read the same way.
 */
export function scaleNumbers(text: string, factor: number, lang = 'en'): string {
  if (factor === 1) return text;
  const parts = new Intl.NumberFormat(lang).formatToParts(12345.6);
  const group = parts.find((p) => p.type === 'group')?.value ?? ',';
  const decimal = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  return text.replace(/\d[\d.,\s  ']*/g, (match) => {
    const trail = /[.,\s  ']*$/.exec(match)?.[0] ?? '';
    const digits = match.slice(0, match.length - trail.length);
    const value = Number(digits.split(group).join('').replace(decimal, '.'));
    if (!Number.isFinite(value)) return match;
    const scaled = Math.round(value * factor * 100) / 100;
    return scaled.toLocaleString(lang, { maximumFractionDigits: 2 }) + trail;
  });
}
