import { MODULE_ID } from '../../core/constants.js';
import { notify, settings } from '../../core/foundryApi.js';
import { fmt } from '../../core/i18n.js';
import { sceneById, users } from './state.js';

/**
 * Travel without a vote: when the GM and every player online are all looking at the same scene,
 * and it isn't the active one, the active GM makes it active. Which scene each user is viewing
 * arrives as user activity rather than a document update (no hook to listen to), so the GM's
 * client checks every couple of seconds, and only acts once it held for two checks in a row.
 */

export const AUTO_SETTING = 'travelAutoActivate';
const CHECK_MS = 2000;

let timer: ReturnType<typeof setInterval> | null = null;
let candidate: string | null = null;

export function registerAutoSetting(): void {
  settings().register(MODULE_ID, AUTO_SETTING, {
    name: 'kaiserkram.travel.SETTINGS.auto.name',
    hint: 'kaiserkram.travel.SETTINGS.auto.hint',
    scope: 'world',
    config: true,
    type: Boolean,
    default: true,
  });
}

type Viewer = { id: string; isGM: boolean; active: boolean; viewedScene?: string | null };

/** The one scene everyone online is viewing, if they all view the same one and a player is among them. */
export function commonScene(viewers: Viewer[]): string | null {
  const online = viewers.filter((u) => u.active);
  if (!online.some((u) => !u.isGM)) return null;
  const first = online[0]?.viewedScene ?? null;
  return first && online.every((u) => u.viewedScene === first) ? first : null;
}

async function check(): Promise<void> {
  const activeGM = (game.users as unknown as { activeGM?: { isSelf?: boolean } | null }).activeGM;
  if (!activeGM?.isSelf || !settings().get(MODULE_ID, AUTO_SETTING)) {
    candidate = null;
    return;
  }
  const sceneId = commonScene(users() as Viewer[]);
  const active = (game.scenes as unknown as { active?: { id: string } | null }).active?.id ?? null;
  if (!sceneId || sceneId === active) {
    candidate = null;
    return;
  }
  // Seen twice in a row: everyone has settled there, not just clicked through.
  if (candidate !== sceneId) {
    candidate = sceneId;
    return;
  }
  candidate = null;
  const scene = sceneById(sceneId);
  if (!scene) return;
  await scene.activate();
  notify().info(fmt('kaiserkram.travel.autoTravelled', 'Everyone is at {scene}, so it is now the active scene.', { scene: scene.name }));
}

/** GM clients, once a scene is drawn (nothing to compare before that). */
export function startAutoTravel(): void {
  if (timer || !game.user?.isGM) return;
  timer = setInterval(() => void check().catch((err) => console.error(`${MODULE_ID} | travel: auto check failed`, err)), CHECK_MS);
}
