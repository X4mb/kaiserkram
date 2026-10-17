import type { Feature } from '../../core/feature.js';
import { registerCanvasDrop } from './canvasDrop.js';
import { deployFolderDirectly, deployParty } from './deploy.js';
import { registerTokenHudButton } from './hud.js';
import { createPartyTokenFromFolder } from './partyToken.js';
import { recallParty } from './recall.js';
import { registerPartyInventory } from './inventory.js';
import { upgradeMarkers } from './markerActor.js';
import { getPlayersControlMarker, registerPartySettings } from './settings.js';
import { on } from '../../core/foundryApi.js';

export const party: Feature = {
  id: 'party',
  group: 'general',
  legacyModuleId: 'deploy-party',
  legacyTitle: 'Deploy Party',

  init() {
    registerPartySettings();
    registerCanvasDrop();
    registerTokenHudButton();
    registerPartyInventory();
    on('canvasReady', () => {
      if (game.user?.isGM && getPlayersControlMarker()) void upgradeMarkers(canvas?.scene as never);
    });
  },

  api() {
    return { deployParty, deployFolderDirectly, createPartyTokenFromFolder, recallParty };
  },
};
