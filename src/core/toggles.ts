import { MODULE_ID } from './constants.js';
import type { Feature, FeatureId } from './feature.js';
import { settings, systemId } from './foundryApi.js';

export const CORE_SETTINGS = {
  ENABLED_FEATURES: 'enabledFeatures',
  MIGRATION_VERSION: 'migrationVersion',
} as const;

export type EnabledMap = Partial<Record<FeatureId, boolean>>;

export function registerCoreSettings(): void {
  settings().register(MODULE_ID, CORE_SETTINGS.ENABLED_FEATURES, {
    scope: 'world',
    config: false,
    type: Object,
    default: {},
  });
  settings().register(MODULE_ID, CORE_SETTINGS.MIGRATION_VERSION, {
    scope: 'world',
    config: false,
    type: Number,
    default: 0,
  });
}

export function enabledFeatures(): EnabledMap {
  const v = settings().get(MODULE_ID, CORE_SETTINGS.ENABLED_FEATURES);
  return v && typeof v === 'object' ? { ...(v as EnabledMap) } : {};
}

export function setEnabledFeatures(map: EnabledMap): Promise<unknown> {
  return settings().set(MODULE_ID, CORE_SETTINGS.ENABLED_FEATURES, map);
}

export function isEnabled(id: FeatureId): boolean {
  return enabledFeatures()[id] === true;
}

/** Whether the feature can run in this world's game system at all. */
export function isAvailable(feature: Feature): boolean {
  return !feature.systems || feature.systems.includes(systemId());
}
