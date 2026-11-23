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
