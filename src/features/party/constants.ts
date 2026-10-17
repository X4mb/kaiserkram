import { MODULE_PATH } from '../../core/constants.js';

/** Token flags, as dotted paths under flags.kaiserkram (i.e. flags.kaiserkram.party.<key>). */
export const FLAGS = {
  // Set on the party marker token.
  IS_PARTY_TOKEN: 'party.isPartyToken',
  FOLDER_UUID: 'party.folderUuid',
  FOLDER_NAME: 'party.folderName',

  // Set on each token spawned by a deploy, so it can find its way back.
  DEPLOY_BATCH_ID: 'party.deployBatchId',
  ORIGIN_MARKER_ID: 'party.originMarkerId',
  ORIGIN_FOLDER_UUID: 'party.originFolderUuid',
  ORIGIN_FOLDER_NAME: 'party.originFolderName',
} as const;

export const DEFAULT_TOKEN_IMAGE = `${MODULE_PATH}/assets/party-token.svg`;
