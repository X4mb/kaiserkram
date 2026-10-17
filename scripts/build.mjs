/**
 * Bundle src/main.ts to whatever file module.json's `esmodules` names. Locally that is
 * dist/kaiserkram.js; CI builds stamp a versioned name first (see stamp.mjs) so browsers
 * behind a caching proxy can't keep running an old bundle after an update.
 */
import { readdirSync, rmSync, mkdirSync } from 'fs';
import { basename, join } from 'path';
import esbuild from 'esbuild';
import { MODULE_ID, ROOT, bundlePath } from './package-files.mjs';

const outfile = join(ROOT, bundlePath());
const distDir = join(ROOT, 'dist');

mkdirSync(distDir, { recursive: true });
for (const f of readdirSync(distDir)) {
  if (f.startsWith(MODULE_ID) && !f.startsWith(basename(outfile))) rmSync(join(distDir, f));
}

await esbuild.build({
  entryPoints: [join(ROOT, 'src', 'main.ts')],
  bundle: true,
  outfile,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  minify: true,
  logLevel: 'info',
});
