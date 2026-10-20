import { injectStylesheet } from './core/assets.js';
import { MODULE_ID } from './core/constants.js';
import type { Feature } from './core/feature.js';
import { featureName, registerFeatureManager } from './core/featureManager.js';
import { loadTemplates, moduleById, notify } from './core/foundryApi.js';
import { fmt } from './core/i18n.js';
import { migrate } from './core/migration.js';
import { FEATURES } from './core/registry.js';
import { registerSettingsSections } from './core/settingsSections.js';
import { registerTahContainerIconFix } from './core/compat/tahContainerIcon.js';
import { isAvailable, isEnabled, registerCoreSettings } from './core/toggles.js';

/** Features running in this world, decided once during `init`. */
const active: Feature[] = [];

function log(...args: unknown[]): void {
  console.log(`${MODULE_ID} |`, ...args);
}

Hooks.once('init', () => {
  registerCoreSettings();
  registerFeatureManager();
  // Workarounds for other modules' bugs, each only active while the bug is there.
  registerTahContainerIconFix();

  active.push(...FEATURES.filter((f) => isAvailable(f) && isEnabled(f.id)));

  const templates: string[] = [];
  for (const feature of [...active]) {
    try {
      feature.styles?.forEach(injectStylesheet);
      feature.init();
      templates.push(...(feature.templates ?? []));
    } catch (err) {
      console.error(`${MODULE_ID} | feature "${feature.id}" failed to initialize`, err);
      active.splice(active.indexOf(feature), 1);
    }
  }
  if (templates.length) void loadTemplates(templates);
  if (active.length) registerSettingsSections(active);
  log(active.length ? `active features: ${active.map((f) => f.id).join(', ')}` : 'no features enabled');
});

/** Running a feature next to the module it replaces doubles hooks, sheets or the WebRTC client. */
function warnLegacyConflicts(): void {
  for (const feature of active) {
    const legacy = feature.legacyModuleId ? moduleById(feature.legacyModuleId) : null;
    if (!legacy?.active) continue;
    notify().warn(
      fmt(
        'kaiserkram.conflict',
        'Kaiserkram: "{feature}" is enabled while the old module "{module}" is still active. Disable "{module}" in Manage Modules.',
        { feature: featureName(feature.id), module: legacy.title ?? feature.legacyTitle },
      ),
      { permanent: true },
    );
  }
}

Hooks.once('ready', () => {
  const features: Record<string, unknown> = {};
  for (const feature of active) if (feature.api) features[feature.id] = feature.api();
  const mod = moduleById(MODULE_ID);
  if (mod) mod.api = { features, migrate, isEnabled };

  for (const feature of active) {
    void Promise.resolve()
      .then(() => feature.ready?.())
      .catch((err) => console.error(`${MODULE_ID} | feature "${feature.id}" failed in ready`, err));
  }

  if (!game.user?.isGM) return;
  warnLegacyConflicts();
  const activeGM = (game.users as unknown as { activeGM?: { isSelf?: boolean } | null } | undefined)?.activeGM;
  if (activeGM?.isSelf) {
    void migrate().catch((err) => console.error(`${MODULE_ID} | migration failed`, err));
  }
});
