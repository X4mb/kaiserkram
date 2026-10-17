import { MODULE_ID } from '../../core/constants.js';
import { settings as s } from '../../core/foundryApi.js';
import { DEFAULT_TOKEN_IMAGE } from './constants.js';

export const SETTINGS = {
  DEPLOY_ON_DROP: 'partyDeployOnDrop',
  SHIFT_AFTER_DEPLOY: 'partyShiftAfterDeployBehavior',
  INCLUDE_SUBFOLDERS: 'partyIncludeSubfolders',
  AFTER_DEPLOY: 'partyAfterDeployBehavior',
  SPACING: 'partyTokenSpacing',
  PARTY_TOKEN_SIZE: 'partyTokenSize',
  DEFAULT_IMAGE: 'partyDefaultTokenImage',
} as const;

export const AFTER_DEPLOY_BEHAVIORS = {
  KEEP: 'keep',
  HIDE: 'hide',
  DELETE: 'delete',
} as const;

const BEHAVIOR_CHOICES = {
  [AFTER_DEPLOY_BEHAVIORS.KEEP]: 'kaiserkram.party.SETTINGS.afterDeployBehavior.keep',
  [AFTER_DEPLOY_BEHAVIORS.HIDE]: 'kaiserkram.party.SETTINGS.afterDeployBehavior.hide',
  [AFTER_DEPLOY_BEHAVIORS.DELETE]: 'kaiserkram.party.SETTINGS.afterDeployBehavior.delete',
};

/** Names, hints and choices are i18n keys; Foundry localizes them when it shows the settings. */
export function registerPartySettings(): void {
  s().register(MODULE_ID, SETTINGS.DEPLOY_ON_DROP, {
    name: 'kaiserkram.party.SETTINGS.deployOnDrop.name',
    hint: 'kaiserkram.party.SETTINGS.deployOnDrop.hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: false,
  });

  s().register(MODULE_ID, SETTINGS.SHIFT_AFTER_DEPLOY, {
    name: 'kaiserkram.party.SETTINGS.shiftAfterDeployBehavior.name',
    hint: 'kaiserkram.party.SETTINGS.shiftAfterDeployBehavior.hint',
    scope: 'world',
    config: true,
    type: String,
    choices: BEHAVIOR_CHOICES,
    default: AFTER_DEPLOY_BEHAVIORS.HIDE,
  });

  s().register(MODULE_ID, SETTINGS.INCLUDE_SUBFOLDERS, {
    name: 'kaiserkram.party.SETTINGS.includeSubfolders.name',
    hint: 'kaiserkram.party.SETTINGS.includeSubfolders.hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });

  s().register(MODULE_ID, SETTINGS.AFTER_DEPLOY, {
    name: 'kaiserkram.party.SETTINGS.afterDeployBehavior.name',
    hint: 'kaiserkram.party.SETTINGS.afterDeployBehavior.hint',
    scope: 'world',
    config: true,
    type: String,
    choices: BEHAVIOR_CHOICES,
    default: AFTER_DEPLOY_BEHAVIORS.DELETE,
  });

  s().register(MODULE_ID, SETTINGS.SPACING, {
    name: 'kaiserkram.party.SETTINGS.tokenSpacing.name',
    hint: 'kaiserkram.party.SETTINGS.tokenSpacing.hint',
    scope: 'world',
    config: true,
    type: Number,
    range: { min: 0.5, max: 5, step: 0.25 },
    default: 1,
  });

  s().register(MODULE_ID, SETTINGS.PARTY_TOKEN_SIZE, {
    name: 'kaiserkram.party.SETTINGS.partyTokenSize.name',
    hint: 'kaiserkram.party.SETTINGS.partyTokenSize.hint',
    scope: 'world',
    config: true,
    type: Number,
    range: { min: 0.5, max: 4, step: 0.5 },
    default: 1,
  });

  s().register(MODULE_ID, SETTINGS.DEFAULT_IMAGE, {
    name: 'kaiserkram.party.SETTINGS.defaultTokenImage.name',
    hint: 'kaiserkram.party.SETTINGS.defaultTokenImage.hint',
    scope: 'world',
    config: true,
    type: String,
    filePicker: 'image',
    default: DEFAULT_TOKEN_IMAGE,
  });
}

export function getDeployOnDrop(): boolean {
  return Boolean(s().get(MODULE_ID, SETTINGS.DEPLOY_ON_DROP));
}

export function getShiftAfterDeployBehavior(): string {
  return String(s().get(MODULE_ID, SETTINGS.SHIFT_AFTER_DEPLOY) ?? AFTER_DEPLOY_BEHAVIORS.HIDE);
}

export function getIncludeSubfolders(): boolean {
  return Boolean(s().get(MODULE_ID, SETTINGS.INCLUDE_SUBFOLDERS));
}

export function getAfterDeployBehavior(): string {
  return String(s().get(MODULE_ID, SETTINGS.AFTER_DEPLOY) ?? AFTER_DEPLOY_BEHAVIORS.HIDE);
}

export function getSpacing(): number {
  const v = Number(s().get(MODULE_ID, SETTINGS.SPACING));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export function getPartyTokenSize(): number {
  const v = Number(s().get(MODULE_ID, SETTINGS.PARTY_TOKEN_SIZE));
  return Number.isFinite(v) && v > 0 ? v : 1;
}

export function getDefaultTokenImage(): string {
  const v = s().get(MODULE_ID, SETTINGS.DEFAULT_IMAGE);
  return typeof v === 'string' && v.length > 0 ? v : DEFAULT_TOKEN_IMAGE;
}
