import { MODULE_ID } from '../../core/constants.js';
import { flags } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';
import { FLAGS } from './constants.js';
import { sceneTokens } from './views.js';
import { createPartyTokenFromFolder, isActorFolder } from './partyToken.js';

export function isPartyMarker(tokenDoc: TokenDocument): boolean {
  return Boolean(flags(tokenDoc).getFlag(MODULE_ID, FLAGS.IS_PARTY_TOKEN));
}

export function isDeployedMember(tokenDoc: TokenDocument): boolean {
  return Boolean(flags(tokenDoc).getFlag(MODULE_ID, FLAGS.DEPLOY_BATCH_ID));
}

/**
 * Finds the tokens a recall should act on. From the marker, that's every token still linked
 * to it (across all its deploys, not just the latest); from a deployed member, it's just the
 * siblings from that one deploy.
 */
function findDeployedMembers(tokenDoc: TokenDocument, scene: Scene): TokenDocument[] {
  if (isPartyMarker(tokenDoc)) {
    return sceneTokens(scene).tokens.contents.filter(
      (t) => flags(t).getFlag(MODULE_ID, FLAGS.ORIGIN_MARKER_ID) === tokenDoc.id,
    );
  }

  const batchId = flags(tokenDoc).getFlag(MODULE_ID, FLAGS.DEPLOY_BATCH_ID) as string | undefined;
  if (!batchId) return [];
  return sceneTokens(scene).tokens.contents.filter(
    (t) => flags(t).getFlag(MODULE_ID, FLAGS.DEPLOY_BATCH_ID) === batchId,
  );
}

async function confirmRecall(count: number): Promise<boolean> {
  const result = await foundry.applications.api.DialogV2.confirm({
    window: { title: loc('kaiserkram.party.recall.confirmTitle', 'Recall Party') },
    content: `<p>${loc(
      'kaiserkram.party.recall.confirmBody',
      'Recall {count} token(s)? They will be deleted from the scene — any HP, conditions, or other changes tracked on an unlinked token will be lost.',
    ).replace('{count}', String(count))}</p>`,
    rejectClose: false,
    modal: true,
  });
  return result === true;
}

/**
 * Undoes a deploy: deletes the deployed tokens linked to `tokenDoc` (which may be the party
 * marker itself, or one of the deployed members) and brings the marker back — reusing it in
 * place if it's still on the scene, otherwise recreating one from the source folder.
 */
export async function recallParty(tokenDoc: TokenDocument): Promise<void> {
  if (!game.user?.isGM) {
    ui.notifications?.warn(loc('kaiserkram.party.notifications.gmOnly', 'Only the GM can do that.'));
    return;
  }

  const scene = tokenDoc.parent as Scene | null;
  if (!scene) return;

  const members = findDeployedMembers(tokenDoc, scene);
  if (!members.length) {
    ui.notifications?.warn(
      loc('kaiserkram.party.notifications.nothingToRecall', 'Nothing from this party is currently deployed.'),
    );
    return;
  }

  if (!(await confirmRecall(members.length))) return;

  const grid = scene.grid as unknown as { size: number };
  const gridSize = grid.size;
  let sumX = 0;
  let sumY = 0;
  for (const member of members) {
    sumX += member.x + (member.width * gridSize) / 2;
    sumY += member.y + (member.height * gridSize) / 2;
  }
  const centroid = { x: sumX / members.length, y: sumY / members.length };

  const markerId = isPartyMarker(tokenDoc)
    ? tokenDoc.id
    : (flags(tokenDoc).getFlag(MODULE_ID, FLAGS.ORIGIN_MARKER_ID) as string | undefined);
  const marker = markerId ? sceneTokens(scene).tokens.get(markerId) : undefined;

  const memberIds = members.map((m) => m.id).filter((id): id is string => Boolean(id));
  await sceneTokens(scene).deleteEmbeddedDocuments('Token', memberIds);

  if (marker) {
    await marker.update({
      x: centroid.x - (marker.width * gridSize) / 2,
      y: centroid.y - (marker.height * gridSize) / 2,
      hidden: false,
    });
  } else {
    const folderUuid = (
      isPartyMarker(tokenDoc)
        ? flags(tokenDoc).getFlag(MODULE_ID, FLAGS.FOLDER_UUID)
        : flags(tokenDoc).getFlag(MODULE_ID, FLAGS.ORIGIN_FOLDER_UUID)
    ) as string | undefined;
    const folder = folderUuid ? ((await fromUuid(folderUuid)) as unknown) : null;
    if (isActorFolder(folder)) {
      await createPartyTokenFromFolder(folder, centroid, scene);
    } else {
      ui.notifications?.warn(
        loc(
          'kaiserkram.party.notifications.markerGone',
          'The party marker and its source folder are both gone; the deployed tokens were removed without a new marker.',
        ),
      );
    }
  }

  ui.notifications?.info(
    loc('kaiserkram.party.notifications.recalled', 'Recalled {count} token(s).').replace('{count}', String(members.length)),
  );
}
