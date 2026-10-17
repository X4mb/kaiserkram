/**
 * Copies the built module into the local Foundry VTT user data folder.
 * Runs automatically after `npm run build`.
 *
 * Override destination: set FOUNDRY_MODULE_PATH to the full `kaiserkram` folder
 * (e.g. `D:/FoundryVTT/Data/modules/kaiserkram`).
 */
import { cpSync, copyFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MODULE_ID, PACKAGE_DIRS } from './package-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const dest =
  process.env.FOUNDRY_MODULE_PATH?.trim() ||
  (() => {
    const local = process.env.LOCALAPPDATA;
    if (!local) return null;
    return join(local, 'FoundryVTT', 'Data', 'modules', MODULE_ID);
  })();

if (!dest) {
  console.warn(
    `[${MODULE_ID}] Skip Foundry deploy: set LOCALAPPDATA (Windows) or FOUNDRY_MODULE_PATH to your Data/modules/${MODULE_ID} folder.`,
  );
  process.exit(0);
}

if (!existsSync(join(root, 'dist', `${MODULE_ID}.js`))) {
  console.error(`[${MODULE_ID}] dist/${MODULE_ID}.js missing — run esbuild first.`);
  process.exit(1);
}

for (const dir of PACKAGE_DIRS) {
  mkdirSync(join(dest, dir), { recursive: true });
  cpSync(join(root, dir), join(dest, dir), { recursive: true });
}
copyFileSync(join(root, 'module.json'), join(dest, 'module.json'));
console.log(`[${MODULE_ID}] Deployed -> ${dest}`);
