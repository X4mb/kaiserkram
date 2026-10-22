import type { Feature } from '../../core/feature.js';
import { registerCanvasDrop } from './canvasDrop.js';
import { deployFolderDirectly, deployParty } from './deploy.js';
import { registerTokenHudButton } from './hud.js';
import { createPartyTokenFromFolder } from './partyToken.js';
import { recallParty } from './recall.js';
import { registerMarkerFollow } from './follow.js';
import { registerPartyInventory } from './inventory.js';
import { upgradeMarkers } from './markerActor.js';
import { getPlayersControlMarker, getTrading, registerPartySettings } from './settings.js';
import { MODULE_PATH } from '../../core/constants.js';
import { isActiveGM, on } from '../../core/foundryApi.js';
import { onActorChanges } from '../../core/refresh.js';
import { registerSocketHandler } from '../../core/socket.js';
import { onItemChanged, onUserLeft } from './trade/authority.js';
import { giveItems, initTradeClient, onTradeMessage, proposeTrade, refreshTradeWindows } from './trade/client.js';
import { registerTradeEntryPoints } from './trade/entry.js';
import { addStashHudButton, openStash, refreshStashWindows, routeMarkerDoubleClick } from './stash.js';

/** Trading between characters: entry points, and keeping open trade windows current. */
function registerTrading(): void {
  registerTradeEntryPoints();
  onActorChanges(refreshTradeWindows);
  // The GM: a deal whose offered item changes, or goes, has to be agreed again.
  const itemChanged = ((item: Parameters<typeof onItemChanged>[0]) => {
    if (isActiveGM()) void onItemChanged(item);
  }) as (...args: never[]) => unknown;
  on('updateItem', itemChanged);
  on('deleteItem', itemChanged);
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
  onActorChanges(refreshStashWindows);
}

export const party: Feature = {
  id: 'party',
  group: 'general',
  styles: [`${MODULE_PATH}/styles/party.css`],

  init() {
    registerPartySettings();
    registerCanvasDrop();
    registerTokenHudButton();
    registerPartyInventory();
    registerStash();
    registerMarkerFollow();
    on('canvasReady', () => {
      // One GM does it, or two GMs online would both create marker actors.
      if (isActiveGM() && getPlayersControlMarker()) void upgradeMarkers(canvas?.scene as never);
    });
    // The GM runs stash moves too, so the channel is open even with trading off.
    initTradeClient();
    if (getTrading()) registerTrading();
  },

  ready() {
    registerSocketHandler('party', onTradeMessage);
  },

  api() {
    return { deployParty, deployFolderDirectly, createPartyTokenFromFolder, recallParty, proposeTrade, giveItems, openStash };
  },
};
