import { MODULE_ID } from '../../core/constants.js';
import { settings } from '../../core/foundryApi.js';

export const SETTINGS = {
  LEVEL_HEIGHT: 'alchemistLevelHeight',
  /** The level the GM last gave the lowest file (remembered per client). */
  FIRST_LEVEL: 'alchemistFirstLevel',
} as const;

export function registerAlchemistSettings(): void {
  settings().register(MODULE_ID, SETTINGS.LEVEL_HEIGHT, {
    name: 'kaiserkram.alchemist.SETTINGS.levelHeight.name',
    hint: 'kaiserkram.alchemist.SETTINGS.levelHeight.hint',
    scope: 'world',
    config: true,
    type: Number,
    default: 10,
  });
  settings().register(MODULE_ID, SETTINGS.FIRST_LEVEL, {
    scope: 'client',
    config: false,
    type: Number,
    default: 0,
  });
}
