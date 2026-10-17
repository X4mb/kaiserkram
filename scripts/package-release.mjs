/** Build module.zip: module.json, LICENSE, dist/, lang/, assets/, templates/, styles/ (for GitHub Release + manifest download). */
import { createWriteStream, existsSync } from 'fs';
import { join } from 'path';
import { ZipArchive } from 'archiver';
import { MODULE_ID, PACKAGE_DIRS, PACKAGE_FILES, ROOT as root, bundlePath } from './package-files.mjs';
const outPath = join(root, 'module.zip');

if (!existsSync(join(root, bundlePath()))) {
  console.error(`[${MODULE_ID}] ${bundlePath()} missing — run npm run build first.`);
  process.exit(1);
}

const output = createWriteStream(outPath);
const archive = new ZipArchive({ zlib: { level: 9 } });

archive.pipe(output);
for (const file of PACKAGE_FILES) archive.file(join(root, file), { name: file });
for (const dir of PACKAGE_DIRS) archive.directory(join(root, dir), dir);

await new Promise((resolve, reject) => {
  output.on('close', resolve);
  archive.on('error', reject);
  archive.finalize();
});

console.log(`[${MODULE_ID}] Wrote ${outPath} (${archive.pointer()} bytes)`);
