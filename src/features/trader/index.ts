import type { Feature } from '../../core/feature.js';
import { on } from '../../core/foundryApi.js';
import { createTrader, openShopPicker, registerShopAccess } from './access.js';
import { STYLESHEET, TEMPLATES } from './constants.js';
import { registerHaggleHandler, resetHaggling, startHaggle } from './haggle.js';
import { registerTraderSettings } from './settings.js';
import { openShop, openShops, refreshShops } from './shop.js';
import { onActorChanges } from '../../core/refresh.js';
import { registerSocket } from './socket.js';
import { isTrader } from './trader.js';
import { registerTransactionHandlers } from './transactions.js';

function registerHooks(): void {
  // The trader's settings or stock, or the shopper's coins or inventory, changed: redraw that shop.
  onActorChanges((changed) => {
    if (openShops.size) refreshShops(changed);
  }, { actors: true });
  registerShopAccess();
}

export const trader: Feature = {
  id: 'trader',
  group: 'wfrp4e',
  systems: ['wfrp4e'],
  legacyModuleId: 'trader-wfrp4e',
  legacyTitle: 'WFRP4e Trader',
  styles: [STYLESHEET],
  templates: Object.values(TEMPLATES),

  init() {
    registerTraderSettings();
    registerTransactionHandlers();
    registerHaggleHandler();
    registerHooks();
  },

  ready() {
    registerSocket();
  },

  api() {
    return {
      createTrader,
      isTrader,
      openShop,
      openShopPicker,
      resetHaggling,
      startHaggle,
    };
  },
};
