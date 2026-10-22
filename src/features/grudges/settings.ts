import { MODULE_ID } from '../../core/constants.js';
import { settings as s } from '../../core/foundryApi.js';

const SETTINGS = {
  /** World: hidden points each side starts with, so the first few real ones barely move the odds. */
  STEADINESS: 'grudgesSteadiness',
  /** Client (per-user): ask for a reason whenever a point is added. */
  ASK_REASON: 'grudgesAskReason',
} as const;

const DEFAULT_STEADINESS = 5;

/** Names and hints are i18n keys; Foundry localizes them when it shows the settings. */
export function registerGrudgeSettings(onChange: () => void): void {
  s().register(MODULE_ID, SETTINGS.STEADINESS, {
    name: 'kaiserkram.grudges.SETTINGS.steadiness.name',
    hint: 'kaiserkram.grudges.SETTINGS.steadiness.hint',
    scope: 'world',
    config: true,
    type: Number,
    range: { min: 0, max: 20, step: 1 },
    default: DEFAULT_STEADINESS,
    onChange,
  });
  s().register(MODULE_ID, SETTINGS.ASK_REASON, {
    name: 'kaiserkram.grudges.SETTINGS.askReason.name',
    hint: 'kaiserkram.grudges.SETTINGS.askReason.hint',
    scope: 'client',
    config: true,
    type: Boolean,
    default: false,
  });
}

export function getSteadiness(): number {
  const v = Number(s().get(MODULE_ID, SETTINGS.STEADINESS));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_STEADINESS;
}

export function getAskReason(): boolean {
  return Boolean(s().get(MODULE_ID, SETTINGS.ASK_REASON));
}
