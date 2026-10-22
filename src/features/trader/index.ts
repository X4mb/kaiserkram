import type { Feature } from '../../core/feature.js';
import { isActiveGM, on } from '../../core/foundryApi.js';
import { createTrader, openShopPicker, registerShopAccess } from './access.js';
import { STYLESHEET, TEMPLATES } from './constants.js';
import { registerHaggleHandler, resetHaggling, startHaggle } from './haggle.js';
import { registerTraderSettings } from './settings.js';
import { openShop, openShops, refreshShops } from './shop.js';
import { onActorChanges } from '../../core/refresh.js';
import { registerSocket } from './socket.js';
import { forgetItemInHaggles, isTrader } from './trader.js';
import type { WfrpActor } from './wfrp.js';
import { registerTransactionHandlers } from './transactions.js';

function registerHooks(): void {
  // The trader's settings or stock, or the shopper's coins or inventory, changed: redraw that shop.
  onActorChanges((changed) => {
    if (openShops.size) refreshShops(changed);
  }, { actors: true });
  registerShopAccess();
  // An item the trader no longer has can't be bought at a haggled price: forget its deals.
  on('deleteItem', ((item: { id: string; parent?: WfrpActor | null }) => {
    const owner = item.parent;
    if (!owner || !isActiveGM() || !isTrader(owner)) return;
    forgetItemInHaggles(owner, item.id).catch((err) => console.error('[kaiserkram] trader: clearing deals failed', err));
  }) as (...args: never[]) => unknown);
}

export const trader: Feature = {
  id: 'trader',
  group: 'wfrp4e',
  systems: ['wfrp4e'],
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
