import { MODULE_ID } from '../../core/constants.js';
import { expandObject, flags, notify } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';
import { FLAGS } from './constants.js';
import { collectActorsInFolder } from './spawn.js';
import { getIncludeSubfolders } from './settings.js';

/**
 * A token without an actor can only be controlled by the GM. To let players move a party
 * marker and see from it, each folder's markers are backed by one linked actor that every
 * player owns, with vision copied from one of the folder's members.
 */

type ActorLike = Actor & { id: string; img?: string; folder?: { id: string } | null };
type ActorCollection = { contents: ActorLike[] };
type FolderLike = { id: string; type: string };
type DocClass = { create(data: Record<string, unknown>): Promise<unknown> };

const OWNER = 3;

/** Actor types that suit a stand-in, most suitable first; falls back to whatever the system has. */
const PREFERRED_TYPES = ['party', 'group', 'npc', 'creature', 'character'];

function actorType(): string | null {
  // `game.documentTypes.Actor` is a list of type names (an object keyed by type in older cores).
  const raw = (game as unknown as { documentTypes?: { Actor?: string[] | Record<string, unknown> } }).documentTypes?.Actor;
  const types = (Array.isArray(raw) ? raw : Object.keys(raw ?? {})).filter((t) => t !== 'base');
  return PREFERRED_TYPES.find((t) => types.includes(t)) ?? types[0] ?? null;
}

function actors(): ActorLike[] {
  return (game.actors as unknown as ActorCollection).contents;
}

function documentClass(name: 'Actor' | 'Folder'): DocClass {
  return (CONFIG as unknown as Record<string, { documentClass: DocClass }>)[name].documentClass;
}

/** One Actor folder holds every marker actor, so they stay out of the party folders themselves. */
async function markerFolder(): Promise<string | null> {
  const folders = (game.folders as unknown as { contents: FolderLike[] }).contents;
  const existing = folders.find((f) => f.type === 'Actor' && flags(f).getFlag(MODULE_ID, FLAGS.MARKER_ACTOR_FOLDER));
  if (existing) return existing.id;
  const created = (await documentClass('Folder').create({
    name: loc('kaiserkram.party.markerFolder', 'Party Markers'),
    type: 'Actor',
    flags: { [MODULE_ID]: expandObject({ [FLAGS.MARKER_ACTOR_FOLDER]: true }) },
  })) as FolderLike | null;
  return created?.id ?? null;
}

/** Vision for the marker: the first member whose token can see, else plain sight. */
function visionFrom(folder: Folder): Record<string, unknown> {
  for (const member of collectActorsInFolder(folder, getIncludeSubfolders())) {
    const proto = (member as unknown as { prototypeToken?: { sight?: { enabled?: boolean }; detectionModes?: unknown } })
      .prototypeToken;
    if (proto?.sight?.enabled) {
      return {
        sight: foundry.utils.deepClone(proto.sight),
        detectionModes: foundry.utils.deepClone(proto.detectionModes ?? []),
      };
    }
  }
  return { sight: { enabled: true } };
}

/** Get (or create) the actor behind `folder`'s party markers. Returns null if the system has no actor types. */
export async function markerActorFor(folder: Folder, img: string): Promise<ActorLike | null> {
  const existing = actors().find((a) => flags(a).getFlag(MODULE_ID, FLAGS.MARKER_ACTOR_FOR) === folder.uuid);
  if (existing) return existing;

  const type = actorType();
  if (!type) return null;
  const vision = visionFrom(folder);
  return (await documentClass('Actor').create({
    name: folder.name,
    type,
    img,
    folder: await markerFolder(),
    ownership: { default: OWNER },
    prototypeToken: { name: folder.name, actorLink: true, texture: { src: img }, ...vision },
    flags: { [MODULE_ID]: expandObject({ [FLAGS.MARKER_ACTOR_FOR]: folder.uuid }) },
  })) as ActorLike | null;
}

/** Token data that hands a marker to its actor, so players can control it and see from it. */
export async function playerMarkerData(folder: Folder, img: string): Promise<Record<string, unknown>> {
  let actor: ActorLike | null = null;
  try {
    actor = await markerActorFor(folder, img);
  } catch (err) {
    console.error(`${MODULE_ID} | party: could not create the actor behind the party marker`, err);
  }
  if (!actor) {
    notify().warn(
      loc(
        'kaiserkram.party.notifications.noMarkerActor',
        'Could not create an actor for the party marker, so only the GM can move it. See the console for details.',
      ),
    );
    return {};
  }
  return { actorId: actor.id, actorLink: true, ...visionFrom(folder) };
}

type SceneLike = {
  tokens: { contents: TokenDocument[] };
  updateEmbeddedDocuments(type: 'Token', updates: Record<string, unknown>[]): Promise<unknown>;
};

/** GM: give markers placed before "players control the marker" was on (or by the old module) their actor. */
export async function upgradeMarkers(scene: SceneLike | null | undefined): Promise<void> {
  if (!scene || !game.user?.isGM) return;
  const updates: Record<string, unknown>[] = [];
  for (const token of scene.tokens.contents) {
    const t = token as TokenDocument & { id: string; actorId?: string | null; texture?: { src?: string } };
    if (!flags(t).getFlag(MODULE_ID, FLAGS.IS_PARTY_TOKEN) || t.actorId) continue;
    const uuid = flags(t).getFlag(MODULE_ID, FLAGS.FOLDER_UUID) as string | undefined;
    const folder = uuid ? ((await fromUuid(uuid)) as unknown) : null;
    if (!(folder instanceof Folder)) continue;
    const data = await playerMarkerData(folder, t.texture?.src ?? '');
    if (Object.keys(data).length) updates.push({ _id: t.id, ...data });
  }
  if (updates.length) await scene.updateEmbeddedDocuments('Token', updates);
}
