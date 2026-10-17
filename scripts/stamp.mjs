/**
 * CI only: rewrite module.json for a published build.
 *
 *   node scripts/stamp.mjs release          -> versioned bundle name
 *   node scripts/stamp.mjs test <build>     -> version <version>.<build>, "(Test)" title, and
 *                                              manifest/download pointing at the `test-latest`
 *                                              pre-release
 */
import { writeFileSync } from 'fs';
import { join } from 'path';
import { MODULE_ID, ROOT, readManifest } from './package-files.mjs';

const TEST_RELEASE = `https://github.com/X4mb/${MODULE_ID}/releases/download/test-latest`;

const [channel, build] = process.argv.slice(2);
const manifest = readManifest();

if (channel === 'test') {
  if (!/^\d+$/.test(build ?? '')) throw new Error('usage: stamp.mjs test <build number>');
  manifest.version = `${manifest.version}.${build}`;
  manifest.title = `${manifest.title} (Test)`;
  manifest.manifest = `${TEST_RELEASE}/module.json`;
  manifest.download = `${TEST_RELEASE}/module.zip`;
  manifest.description = `<p><strong>TEST BUILD</strong> from the <code>test</code> branch. Install with <code>${TEST_RELEASE}/module.json</code>. Uses the same module id as the release, so only one of the two can be installed.</p>${manifest.description}`;
} else if (channel !== 'release') {
  throw new Error(`unknown channel ${channel}`);
}

manifest.esmodules = [`dist/${MODULE_ID}-${manifest.version}.js`];
writeFileSync(join(ROOT, 'module.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`[${MODULE_ID}] stamped ${channel} build ${manifest.version} -> ${manifest.esmodules[0]}`);
