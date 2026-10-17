/** Build module.zip: module.json, LICENSE, dist/, lang/, assets/, templates/, styles/ (for GitHub Release + manifest download). */
import { createWriteStream, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import { MODULE_ID, PACKAGE_DIRS, PACKAGE_FILES } from './package-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath = join(root, 'module.zip');

if (!existsSync(join(root, 'dist', `${MODULE_ID}.js`))) {
  console.error(`[${MODULE_ID}] dist/${MODULE_ID}.js missing — run npm run build first.`);
  process.exit(1);
}

const output = createWriteStream(outPath);
const archive = archiver('zip', { zlib: { level: 9 } });

archive.pipe(output);
for (const file of PACKAGE_FILES) archive.file(join(root, file), { name: file });
for (const dir of PACKAGE_DIRS) archive.directory(join(root, dir), dir);

await new Promise((resolve, reject) => {
  output.on('close', resolve);
  archive.on('error', reject);
  archive.finalize();
});

console.log(`[${MODULE_ID}] Wrote ${outPath} (${archive.pointer()} bytes)`);
