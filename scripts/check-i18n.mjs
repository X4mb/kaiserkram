/**
 * Every `kaiserkram.…` i18n key used in src/ and templates/ must exist in lang/en.json,
 * and every key in lang/en.json should be used somewhere.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

const lang = JSON.parse(readFileSync(join(root, 'lang', 'en.json'), 'utf8'));
const defined = new Set(Object.keys(lang));
const used = new Map();
const KEY = /['"`](kaiserkram\.[A-Za-z0-9_.]+[A-Za-z0-9_])['"`]/g;
const HBS = /localize\s+"(kaiserkram\.[A-Za-z0-9_.]+)"/g;

for (const file of [...walk(join(root, 'src')), ...walk(join(root, 'templates'))]) {
  const text = readFileSync(file, 'utf8');
  for (const re of [KEY, HBS]) {
    for (const m of text.matchAll(re)) {
      // Setting / flag / class ids share the prefix but aren't i18n keys.
      if (/^kaiserkram\.(TraderSheet)$/.test(m[1])) continue;
      if (!used.has(m[1])) used.set(m[1], file.slice(root.length + 1));
    }
  }
}

// Foundry may expand dotted keys into nested objects, so no key may also be a prefix of another.
const clashes = [...defined].filter((k) => [...defined].some((o) => o.startsWith(`${k}.`)));
for (const k of clashes) console.error(`key is both a string and a group in lang/en.json: ${k}`);

const missing = [...used].filter(([k]) => !defined.has(k));
const unused = [...defined].filter((k) => !used.has(k));
for (const [k, file] of missing) console.error(`missing in lang/en.json: ${k} (used in ${file})`);
for (const k of unused) console.warn(`unused key in lang/en.json: ${k}`);
console.log(`[kaiserkram] i18n: ${used.size} keys used, ${defined.size} defined, ${missing.length} missing, ${unused.length} unused`);
if (missing.length || clashes.length) process.exit(1);
