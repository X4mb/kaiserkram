import { MODULE_ID } from '../../core/constants.js';
import { settings } from '../../core/foundryApi.js';

export const SETTINGS = {
  DEFAULT_MARKUP: 'traderDefaultMarkup',
  DEFAULT_SELL_RATE: 'traderDefaultSellRate',
  ENFORCE_PURSE: 'traderEnforcePurse',
  HAGGLE_ENABLED: 'traderHaggleEnabled',
  HAGGLE_RETRY: 'traderHaggleRetry',
  HAGGLE_STEP: 'traderHaggleStep',
  HAGGLE_FREE: 'traderHaggleFree',
} as const;

/** `name` and `hint` are i18n keys; Foundry localizes them when it shows the settings. */
type NumberSetting = { key: string; name: string; hint: string; def: number; min: number; max: number; step: number };
type BoolSetting = { key: string; name: string; hint: string; def: boolean };

const NUMBER_SETTINGS: NumberSetting[] = [
  {
    key: SETTINGS.DEFAULT_MARKUP,
    name: 'kaiserkram.trader.SETTINGS.defaultMarkup.name',
    hint: 'kaiserkram.trader.SETTINGS.defaultMarkup.hint',
    def: 100, min: 0, max: 400, step: 5,
  },
  {
    key: SETTINGS.DEFAULT_SELL_RATE,
    name: 'kaiserkram.trader.SETTINGS.defaultSellRate.name',
    hint: 'kaiserkram.trader.SETTINGS.defaultSellRate.hint',
    def: 90, min: 0, max: 200, step: 5,
  },
  {
    key: SETTINGS.HAGGLE_STEP,
    name: 'kaiserkram.trader.SETTINGS.haggleStep.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleStep.hint',
    def: 5, min: 0, max: 10, step: 1,
  },
  {
    key: SETTINGS.HAGGLE_FREE,
    name: 'kaiserkram.trader.SETTINGS.haggleFree.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleFree.hint',
    def: 10, min: 0, max: 30, step: 5,
  },
];

const BOOL_SETTINGS: BoolSetting[] = [
  {
    key: SETTINGS.ENFORCE_PURSE,
    name: 'kaiserkram.trader.SETTINGS.enforcePurse.name',
    hint: 'kaiserkram.trader.SETTINGS.enforcePurse.hint',
    def: true,
  },
  {
    key: SETTINGS.HAGGLE_ENABLED,
    name: 'kaiserkram.trader.SETTINGS.haggleEnabled.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleEnabled.hint',
    def: true,
  },
  {
    key: SETTINGS.HAGGLE_RETRY,
    name: 'kaiserkram.trader.SETTINGS.haggleRetry.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleRetry.hint',
    def: false,
  },
];

export function registerTraderSettings(): void {
  // Order here is the order shown in Configure Settings.
  for (const def of NUMBER_SETTINGS) registerNumber(def);
  for (const def of BOOL_SETTINGS) registerBool(def);
}

function registerNumber(def: NumberSetting): void {
  settings().register(MODULE_ID, def.key, {
    name: def.name,
    hint: def.hint,
    scope: 'world',
    config: true,
    type: Number,
    range: { min: def.min, max: def.max, step: def.step },
    default: def.def,
  });
}

function registerBool(def: BoolSetting): void {
  settings().register(MODULE_ID, def.key, {
    name: def.name,
    hint: def.hint,
    scope: 'world',
    config: true,
    type: Boolean,
    default: def.def,
  });
}

export function getNumber(key: string): number {
  const v = Number(settings().get(MODULE_ID, key));
  if (Number.isFinite(v)) return v;
  return NUMBER_SETTINGS.find((d) => d.key === key)?.def ?? 0;
}

export function getBool(key: string): boolean {
  return Boolean(settings().get(MODULE_ID, key));
}
