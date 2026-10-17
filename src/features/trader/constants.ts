import { MODULE_ID, MODULE_PATH } from '../../core/constants.js';

/** Sheet class id as stored in `flags.core.sheetClass`. */
export const SHEET_CLASS = `${MODULE_ID}.TraderSheet`;

/** Flags, as dotted paths under flags.kaiserkram (i.e. flags.kaiserkram.trader.<key>). */
export const FLAGS = {
  // Set on the trader actor.
  IS_TRADER: 'trader.isTrader',
  CONFIG: 'trader.config',
  HAGGLE: 'trader.haggle',
  RESTOCK_TABLE: 'trader.restockTable',

  // Set on items in the trader's inventory.
  PRICE_OVERRIDE: 'trader.priceOverride',
  INFINITE: 'trader.infinite',
  NOT_FOR_SALE: 'trader.notForSale',
} as const;

/** Standard WFRP4e coins, valued in brass pennies. */
export const COIN = {
  GC: 240,
  SS: 12,
  BP: 1,
} as const;

export const DEFAULT_TRADER_IMAGE = `${MODULE_PATH}/assets/trader.svg`;

/** CSS class on chat cards the trader posts. */
export const CARD_CLASS = `${MODULE_ID}-trader-card`;

export const TEMPLATES = {
  SHEET: `${MODULE_PATH}/templates/trader/trader-sheet.hbs`,
  HAGGLE_DIALOG: `${MODULE_PATH}/templates/trader/haggle-dialog.hbs`,
  RESTOCK_DIALOG: `${MODULE_PATH}/templates/trader/restock-dialog.hbs`,
  SETTLEMENT_DIALOG: `${MODULE_PATH}/templates/trader/settlement-dialog.hbs`,
  QUANTITY_DIALOG: `${MODULE_PATH}/templates/trader/quantity-dialog.hbs`,
} as const;

export const STYLESHEET = `${MODULE_PATH}/styles/trader.css`;
