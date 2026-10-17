import type { Feature } from '../../core/feature.js';
import { on } from '../../core/foundryApi.js';
import { createTrader, openShopPicker, registerShopAccess } from './access.js';
import { STYLESHEET, TEMPLATES } from './constants.js';
import { registerHaggleHandler, resetHaggling, startHaggle } from './haggle.js';
import { registerTraderSettings } from './settings.js';
import { openShop, refreshShops, TraderShop } from './shop.js';
import { registerSocket } from './socket.js';
import { isTrader } from './trader.js';
import { registerTransactionHandlers } from './transactions.js';

function registerHooks(): void {
  /** The trader's settings, stock, or a customer's coins or inventory changing refreshes open shops. */
  const refresh = foundry.utils.debounce(refreshShops, 100);
  const onActorChange = (): void => {
    if (TraderShop.open.size) refresh();
  };
  const onItemChange = (item: { parent?: { documentName?: string } | null }): void => {
    if (item.parent?.documentName === 'Actor') onActorChange();
  };

  on('updateActor', onActorChange);
  for (const hook of ['createItem', 'updateItem', 'deleteItem']) on(hook, onItemChange);
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
