import { MODULE_ID } from '../../core/constants.js';
import { expandObject } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';
import { DEFAULT_TOKEN_IMAGE, FLAGS } from './constants.js';
import { tokenCreator } from './views.js';
import { collectActorsInFolder } from './spawn.js';
import { getDefaultTokenImage, getIncludeSubfolders, getPartyTokenSize } from './settings.js';

/** Folders became real Documents in Foundry v11+; `type` names the kind of document they hold. */
export function isActorFolder(doc: unknown): doc is Folder {
  return doc instanceof Folder && doc.type === 'Actor';
}

/**
 * Creates a single marker token (no backing Actor needed) that stands in for every
 * actor inside `folder`. The folder's UUID is stored as a flag so Deploy can find it later.
 */
export async function createPartyTokenFromFolder(
  folder: Folder,
  point: { x: number; y: number },
  scene: Scene | null = (canvas?.scene as Scene | null) ?? null,
): Promise<TokenDocument | null> {
  if (!scene) return null;

  if (!game.user?.isGM) {
    ui.notifications?.warn(loc('kaiserkram.party.notifications.gmOnly', 'Only the GM can do that.'));
    return null;
  }

  const grid = scene.grid as unknown as { size: number };
  const gridSize = grid.size;
  const size = getPartyTokenSize();

  const created = (await tokenCreator(scene).createEmbeddedDocuments('Token', [
    {
      name: folder.name,
      width: size,
      height: size,
      x: point.x - (size * gridSize) / 2,
      y: point.y - (size * gridSize) / 2,
      texture: { src: getDefaultTokenImage() || DEFAULT_TOKEN_IMAGE },
      disposition: CONST.TOKEN_DISPOSITIONS.FRIENDLY,
      flags: {
        [MODULE_ID]: expandObject({
          [FLAGS.IS_PARTY_TOKEN]: true,
          [FLAGS.FOLDER_UUID]: folder.uuid,
          [FLAGS.FOLDER_NAME]: folder.name,
        }),
      },
    },
  ])) as TokenDocument[];

  if (!collectActorsInFolder(folder, getIncludeSubfolders()).length) {
    ui.notifications?.warn(
      loc(
        'kaiserkram.party.notifications.markerEmptyFolder',
        'The folder "{name}" has no actors to deploy yet — add some (or enable subfolders) before deploying this marker.',
      ).replace('{name}', folder.name),
    );
  }

  return created[0] ?? null;
}
