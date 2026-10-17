import type { Feature } from '../../core/feature.js';
import { registerCanvasDrop } from './canvasDrop.js';
import { deployFolderDirectly, deployParty } from './deploy.js';
import { registerTokenHudButton } from './hud.js';
import { createPartyTokenFromFolder } from './partyToken.js';
import { recallParty } from './recall.js';
import { registerPartySettings } from './settings.js';

export const party: Feature = {
  id: 'party',
  group: 'general',
  legacyModuleId: 'deploy-party',
  legacyTitle: 'Deploy Party',

  init() {
    registerPartySettings();
    registerCanvasDrop();
    registerTokenHudButton();
  },

  api() {
    return { deployParty, deployFolderDirectly, createPartyTokenFromFolder, recallParty };
  },
};
