/** Bundle tests/unit.ts with esbuild and run it (`npm run test`). A failed check exits non-zero. */
import { build } from 'esbuild';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Not in dist/: that folder is packaged into module.zip and copied into Foundry.
const outfile = join(root, 'node_modules', '.cache', 'kaiserkram', 'unit-tests.mjs');
await build({ entryPoints: [join(root, 'tests', 'unit.ts')], bundle: true, platform: 'node', format: 'esm', outfile, logLevel: 'error' });
await import(pathToFileURL(outfile).href);
