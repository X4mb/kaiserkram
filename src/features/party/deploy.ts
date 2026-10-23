import { MODULE_ID } from '../../core/constants.js';
import { flags } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';
import { FLAGS } from './constants.js';
import { createPartyTokenFromFolder } from './partyToken.js';
import { findDeployedMembers } from './recall.js';
import { collectActorsInFolder, spawnActorsAround } from './spawn.js';
import { AFTER_DEPLOY_BEHAVIORS, getAfterDeployBehavior, getIncludeSubfolders } from './settings.js';

export interface DeployPartyOptions {
  /** Overrides the "after deploying" setting for this one deploy. */
  afterDeployBehavior?: string;
}

/** Markers being deployed right now: a second click meanwhile would spawn everyone twice. */
const deploying = new Set<string>();

export async function deployParty(tokenDoc: TokenDocument, options: DeployPartyOptions = {}): Promise<void> {
  const key = tokenDoc.uuid;
  if (deploying.has(key)) return;
  deploying.add(key);
  try {
    await deployOnce(tokenDoc, options);
  } finally {
    deploying.delete(key);
  }
}

async function deployOnce(tokenDoc: TokenDocument, options: DeployPartyOptions): Promise<void> {
  if (!game.user?.isGM) {
    ui.notifications?.warn(loc('kaiserkram.party.notifications.gmOnly', 'Only the GM can do that.'));
    return;
  }

  const folderUuid = flags(tokenDoc).getFlag(MODULE_ID, FLAGS.FOLDER_UUID) as string | undefined;
  const folder = folderUuid ? ((await fromUuid(folderUuid)) as Folder | null) : null;

  if (!(folder instanceof Folder)) {
    const name = (flags(tokenDoc).getFlag(MODULE_ID, FLAGS.FOLDER_NAME) as string | undefined) ?? tokenDoc.name ?? '';
    ui.notifications?.warn(
      loc('kaiserkram.party.notifications.folderMissing', 'The source folder for "{name}" no longer exists.').replace(
        '{name}',
        name,
      ),
    );
    return;
  }

  const scene = tokenDoc.parent as Scene | null;
  if (!scene) return;

  const actors = collectActorsInFolder(folder, getIncludeSubfolders());
  if (!actors.length) {
    ui.notifications?.warn(
      loc('kaiserkram.party.notifications.folderEmpty', 'The folder "{name}" has no actors to deploy.').replace(
        '{name}',
        folder.name,
      ),
    );
    return;
  }

  // Deploying again only tops up: actors that already have a token out from this marker stay put.
  const alreadyDeployedIds = new Set(
    findDeployedMembers(tokenDoc, scene)
      .map((t) => (t as TokenDocument & { actorId?: string | null }).actorId)
      .filter((id): id is string => Boolean(id)),
  );
  const newActors = actors.filter((a) => !a.id || !alreadyDeployedIds.has(a.id));
  if (!newActors.length) {
    ui.notifications?.info(
      loc('kaiserkram.party.notifications.allDeployed', 'Everyone from "{name}" is already deployed.').replace(
        '{name}',
        folder.name,
      ),
    );
    return;
  }

  const grid = scene.grid as unknown as { size: number };
  const gridSize = grid.size;
  const center = {
    x: tokenDoc.x + (tokenDoc.width * gridSize) / 2,
    y: tokenDoc.y + (tokenDoc.height * gridSize) / 2,
  };
  const batchId = foundry.utils.randomID();

  await spawnActorsAround(scene, newActors, center, {
    hidden: tokenDoc.hidden,
    extraFlags: () => ({
      [FLAGS.DEPLOY_BATCH_ID]: batchId,
      [FLAGS.ORIGIN_MARKER_ID]: tokenDoc.id,
      [FLAGS.ORIGIN_FOLDER_UUID]: folder.uuid,
      [FLAGS.ORIGIN_FOLDER_NAME]: folder.name,
    }),
  });
  await applyAfterDeployBehavior(tokenDoc, options.afterDeployBehavior);

  ui.notifications?.info(
    loc('kaiserkram.party.notifications.deployed', 'Deployed {count} token(s) from "{name}".')
      .replace('{count}', String(newActors.length))
      .replace('{name}', folder.name),
  );
}

/**
 * Creates a marker for `folder` at `point` and deploys it immediately, applying
 * `afterDeployBehavior` (falling back to the usual setting) to decide what happens
 * to the marker afterward. Used by the "deploy immediately on drop" flow.
 */
export async function deployFolderDirectly(
  folder: Folder,
  point: { x: number; y: number },
  scene: Scene | null = (canvas?.scene as Scene | null) ?? null,
  afterDeployBehavior?: string,
): Promise<void> {
  // deployParty warns about an empty folder itself; don't warn twice.
  const marker = await createPartyTokenFromFolder(folder, point, scene, { warnIfEmpty: false });
  if (!marker) return;

  await deployParty(marker, { afterDeployBehavior });
}

async function applyAfterDeployBehavior(tokenDoc: TokenDocument, override?: string): Promise<void> {
  const behavior = override ?? getAfterDeployBehavior();
  if (behavior === AFTER_DEPLOY_BEHAVIORS.DELETE) {
    await tokenDoc.delete();
    return;
  }
  // A fresh deploy starts following the party again, wherever the marker was put before.
  const unplace = { [`flags.${MODULE_ID}.${FLAGS.MARKER_PLACED}`]: 0 };
  if (behavior === AFTER_DEPLOY_BEHAVIORS.HIDE) await tokenDoc.update({ hidden: true, ...unplace });
  else if (flags(tokenDoc).getFlag(MODULE_ID, FLAGS.MARKER_PLACED)) await tokenDoc.update(unplace);
}
