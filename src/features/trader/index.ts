import type { Feature } from '../../core/feature.js';
import { on } from '../../core/foundryApi.js';
import { createTrader, openShopPicker, registerShopAccess } from './access.js';
import { STYLESHEET, TEMPLATES } from './constants.js';
import { registerHaggleHandler, resetHaggling, startHaggle } from './haggle.js';
import { promptSettlement, restockFromTable } from './restock.js';
import { getBool, registerTraderSettings, SETTINGS } from './settings.js';
import { openShop, refreshShops, TraderShop } from './shop.js';
import { registerSocket } from './socket.js';
import { isTrader } from './trader.js';
import { registerTransactionHandlers } from './transactions.js';
import { g, type WfrpActor } from './wfrp.js';

/** GM: placing a trader on a scene asks which settlement size the trader is in (unless turned off). */
function onCreateToken(token: { actor: WfrpActor | null }, _options: unknown, userId: string): void {
  if (userId !== g().user.id || !g().user.isGM || !getBool(SETTINGS.ASK_SETTLEMENT)) return;
  if (!token.actor || !isTrader(token.actor)) return;
  void promptSettlement(token.actor, { offerRestock: true });
}

function registerHooks(): void {
  /** The trader's settings, stock, or a customer's coins or inventory changing refreshes open shops. */
  const refresh = foundry.utils.debounce(refreshShops, 100);
  const onActorChange = (): void => {
    if (TraderShop.open.size) refresh();
  };
  const onItemChange = (item: { parent?: { documentName?: string } | null }): void => {
    if (item.parent?.documentName === 'Actor') onActorChange();
  };

  on('createToken', onCreateToken as (...args: never[]) => unknown);
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
      promptSettlement,
      restockFromTable,
      resetHaggling,
      startHaggle,
    };
  },
};
