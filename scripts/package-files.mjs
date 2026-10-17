/** What ships in the module: shared by build.mjs, deploy.mjs and package-release.mjs. */
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const MODULE_ID = 'kaiserkram';
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE_FILES = ['module.json', 'LICENSE'];
export const PACKAGE_DIRS = ['dist', 'lang', 'assets', 'templates', 'styles'];

export function readManifest() {
  return JSON.parse(readFileSync(join(ROOT, 'module.json'), 'utf8'));
}

/** The bundle module.json loads, e.g. `dist/kaiserkram.js` (or a version-stamped name in CI builds). */
export function bundlePath() {
  return readManifest().esmodules[0];
}
