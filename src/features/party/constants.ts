import { MODULE_PATH } from '../../core/constants.js';

/** Token flags, as dotted paths under flags.kaiserkram (i.e. flags.kaiserkram.party.<key>). */
export const FLAGS = {
  // Set on the party marker token.
  IS_PARTY_TOKEN: 'party.isPartyToken',
  FOLDER_UUID: 'party.folderUuid',
  FOLDER_NAME: 'party.folderName',
  /** When someone last moved the marker by hand (server time): for a while it stays there, and Recall gathers there. */
  MARKER_PLACED: 'party.markerPlaced',

  // Set on each token spawned by a deploy, so it can find its way back.
  DEPLOY_BATCH_ID: 'party.deployBatchId',
  ORIGIN_MARKER_ID: 'party.originMarkerId',
  ORIGIN_FOLDER_UUID: 'party.originFolderUuid',
  ORIGIN_FOLDER_NAME: 'party.originFolderName',

  // Set on the actor that backs party markers for one folder, and on the folder holding those actors.
  MARKER_ACTOR_FOR: 'party.markerActorFor',
  MARKER_ACTOR_FOLDER: 'party.markerActorFolder',
} as const;

/** Update option for the module's own marker moves (following, recall), so they don't count as placing it. */
export const OWN_MOVE = 'kaiserkramPartyMove';

export const DEFAULT_TOKEN_IMAGE = `${MODULE_PATH}/assets/party-token.svg`;
