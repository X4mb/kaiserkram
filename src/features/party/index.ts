import type { Feature } from '../../core/feature.js';
import { registerCanvasDrop } from './canvasDrop.js';
import { deployFolderDirectly, deployParty } from './deploy.js';
import { registerTokenHudButton } from './hud.js';
import { createPartyTokenFromFolder } from './partyToken.js';
import { recallParty } from './recall.js';
import { registerPartyInventory } from './inventory.js';
import { upgradeMarkers } from './markerActor.js';
import { getPlayersControlMarker, getTrading, registerPartySettings } from './settings.js';
import { MODULE_PATH } from '../../core/constants.js';
import { on } from '../../core/foundryApi.js';
import { registerSocketHandler } from '../../core/socket.js';
import { onUserLeft } from './trade/authority.js';
import { giveItems, initTradeClient, onTradeMessage, proposeTrade, refreshTradeWindows } from './trade/client.js';
import { registerTradeEntryPoints } from './trade/entry.js';
import { addStashHudButton, openStash, refreshStashWindows, routeMarkerDoubleClick } from './stash.js';

/** Trading between characters: entry points, and keeping open trade windows current. */
function registerTrading(): void {
  initTradeClient();
  registerTradeEntryPoints();
  const refresh = foundry.utils.debounce(refreshTradeWindows, 100);
  for (const hook of ['createItem', 'updateItem', 'deleteItem']) on(hook, refresh);
  on('userConnected', ((user: { id: string }, connected: boolean) => {
    if (!connected) onUserLeft(user.id);
  }) as (...args: never[]) => unknown);
}

/** The party stash window: its HUD button, and keeping open stash windows current. */
function registerStash(): void {
  on('renderTokenHUD', addStashHudButton as (...args: never[]) => unknown);
  // Before tokens are drawn: each token's mouse handler keeps the click function it was made with.
  on('setup', routeMarkerDoubleClick);
  on('canvasInit', routeMarkerDoubleClick);
  const refresh = foundry.utils.debounce(refreshStashWindows, 100);
  for (const hook of ['createItem', 'updateItem', 'deleteItem']) on(hook, refresh);
}

export const party: Feature = {
  id: 'party',
  group: 'general',
  legacyModuleId: 'deploy-party',
  legacyTitle: 'Deploy Party',
  styles: [`${MODULE_PATH}/styles/party.css`],

  init() {
    registerPartySettings();
    registerCanvasDrop();
    registerTokenHudButton();
    registerPartyInventory();
    registerStash();
    on('canvasReady', () => {
      if (game.user?.isGM && getPlayersControlMarker()) void upgradeMarkers(canvas?.scene as never);
    });
    if (getTrading()) registerTrading();
  },

  ready() {
    if (getTrading()) registerSocketHandler('party', onTradeMessage);
  },

  api() {
    return { deployParty, deployFolderDirectly, createPartyTokenFromFolder, recallParty, proposeTrade, giveItems, openStash };
  },
};
