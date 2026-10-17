import { MODULE_ID } from '../../core/constants.js';
import { settings } from '../../core/foundryApi.js';

export const SETTINGS = {
  DEFAULT_MARKUP: 'traderDefaultMarkup',
  DEFAULT_SELL_RATE: 'traderDefaultSellRate',
  ENFORCE_PURSE: 'traderEnforcePurse',
  ASK_SETTLEMENT: 'traderAskSettlementOnDrop',
  HAGGLE_ENABLED: 'traderHaggleEnabled',
  HAGGLE_MODE: 'traderHaggleMode',
  HAGGLE_MAX_ASK: 'traderHaggleMaxAsk',
  HAGGLE_DIFFICULTY: 'traderHaggleDifficultyPerPercent',
  HAGGLE_DISCOUNT_PER_SL: 'traderHaggleDiscountPerSL',
  HAGGLE_PENALTY_PER_SL: 'traderHagglePenaltyPerSL',
  HAGGLE_GREED: 'traderHaggleGreed',
  HAGGLE_MAX_PENALTY: 'traderHaggleMaxPenalty',
  HAGGLE_BYSTANDER_SHARE: 'traderHaggleBystanderShare',
  HAGGLE_BYSTANDER_RADIUS: 'traderHaggleBystanderRadius',
  HAGGLE_RETRY: 'traderHaggleRetry',
} as const;

export const HAGGLE_MODES = {
  OPPOSED: 'opposed',
  SIMPLE: 'simple',
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
    def: 50, min: 0, max: 200, step: 5,
  },
  {
    key: SETTINGS.HAGGLE_MAX_ASK,
    name: 'kaiserkram.trader.SETTINGS.haggleMaxAsk.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleMaxAsk.hint',
    def: 50, min: 5, max: 90, step: 5,
  },
  {
    key: SETTINGS.HAGGLE_DIFFICULTY,
    name: 'kaiserkram.trader.SETTINGS.haggleDifficultyPerPercent.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleDifficultyPerPercent.hint',
    def: 2, min: 0, max: 5, step: 0.5,
  },
  {
    key: SETTINGS.HAGGLE_DISCOUNT_PER_SL,
    name: 'kaiserkram.trader.SETTINGS.haggleDiscountPerSL.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleDiscountPerSL.hint',
    def: 5, min: 1, max: 25, step: 1,
  },
  {
    key: SETTINGS.HAGGLE_PENALTY_PER_SL,
    name: 'kaiserkram.trader.SETTINGS.hagglePenaltyPerSL.name',
    hint: 'kaiserkram.trader.SETTINGS.hagglePenaltyPerSL.hint',
    def: 5, min: 0, max: 25, step: 1,
  },
  {
    key: SETTINGS.HAGGLE_GREED,
    name: 'kaiserkram.trader.SETTINGS.haggleGreed.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleGreed.hint',
    def: 25, min: 0, max: 100, step: 5,
  },
  {
    key: SETTINGS.HAGGLE_MAX_PENALTY,
    name: 'kaiserkram.trader.SETTINGS.haggleMaxPenalty.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleMaxPenalty.hint',
    def: 50, min: 0, max: 200, step: 5,
  },
  {
    key: SETTINGS.HAGGLE_BYSTANDER_SHARE,
    name: 'kaiserkram.trader.SETTINGS.haggleBystanderShare.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleBystanderShare.hint',
    def: 50, min: 0, max: 100, step: 5,
  },
  {
    key: SETTINGS.HAGGLE_BYSTANDER_RADIUS,
    name: 'kaiserkram.trader.SETTINGS.haggleBystanderRadius.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleBystanderRadius.hint',
    def: 10, min: 0, max: 100, step: 1,
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
    key: SETTINGS.ASK_SETTLEMENT,
    name: 'kaiserkram.trader.SETTINGS.askSettlementOnDrop.name',
    hint: 'kaiserkram.trader.SETTINGS.askSettlementOnDrop.hint',
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
  const byKey = (key: string) => {
    const n = NUMBER_SETTINGS.find((d) => d.key === key);
    if (n) return registerNumber(n);
    const b = BOOL_SETTINGS.find((d) => d.key === key);
    if (b) return registerBool(b);
    if (key === SETTINGS.HAGGLE_MODE) return registerHaggleMode();
  };
  // Order here is the order shown in Configure Settings.
  [
    SETTINGS.DEFAULT_MARKUP,
    SETTINGS.DEFAULT_SELL_RATE,
    SETTINGS.ENFORCE_PURSE,
    SETTINGS.ASK_SETTLEMENT,
    SETTINGS.HAGGLE_ENABLED,
    SETTINGS.HAGGLE_MODE,
    SETTINGS.HAGGLE_MAX_ASK,
    SETTINGS.HAGGLE_DIFFICULTY,
    SETTINGS.HAGGLE_DISCOUNT_PER_SL,
    SETTINGS.HAGGLE_PENALTY_PER_SL,
    SETTINGS.HAGGLE_GREED,
    SETTINGS.HAGGLE_MAX_PENALTY,
    SETTINGS.HAGGLE_BYSTANDER_SHARE,
    SETTINGS.HAGGLE_BYSTANDER_RADIUS,
    SETTINGS.HAGGLE_RETRY,
  ].forEach(byKey);
}

function registerHaggleMode(): void {
  settings().register(MODULE_ID, SETTINGS.HAGGLE_MODE, {
    name: 'kaiserkram.trader.SETTINGS.haggleMode.name',
    hint: 'kaiserkram.trader.SETTINGS.haggleMode.hint',
    scope: 'world',
    config: true,
    type: String,
    choices: {
      [HAGGLE_MODES.OPPOSED]: 'kaiserkram.trader.SETTINGS.haggleMode.opposed',
      [HAGGLE_MODES.SIMPLE]: 'kaiserkram.trader.SETTINGS.haggleMode.simple',
    },
    default: HAGGLE_MODES.OPPOSED,
  });
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

export function getHaggleMode(): string {
  return String(settings().get(MODULE_ID, SETTINGS.HAGGLE_MODE) ?? HAGGLE_MODES.OPPOSED);
}
