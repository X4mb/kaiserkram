import type { Feature } from '../../core/feature.js';
import { notify, on } from '../../core/foundryApi.js';
import { fmt } from '../../core/i18n.js';
import { emitSocket, registerSocketHandler } from '../../core/socket.js';

/**
 * Travel together: once every user logged in (players and GMs) is viewing the same scene, and it
 * isn't the active one, the active GM makes it active. Nobody is moved anywhere before that.
 *
 * Foundry's own record of what other users view (User#viewedScene) can lag behind, e.g. when an
 * activation redraws everyone's canvas, so each client reports its own scene here whenever its
 * canvas is drawn, and the active GM decides only from those reports.
 */

type Message =
  | { kind: 'travel'; op: 'viewing'; userId: string; sceneId: string | null }
  | { kind: 'travel'; op: 'report' };

type UserLike = { id: string; name: string; isGM: boolean; active: boolean };
type SceneLike = { id: string; name: string; activate(): Promise<unknown> };

/** Everyone must stay together this long, so someone clicking through doesn't move the party. */
const SETTLE_MS = 2000;

/** Active GM only: the scene each user last reported viewing. */
const viewing = new Map<string, string | null>();
let pending: { sceneId: string; timer: ReturnType<typeof setTimeout> } | null = null;

function isActiveGM(): boolean {
  return Boolean((game.users as unknown as { activeGM?: { isSelf?: boolean } | null }).activeGM?.isSelf);
}

function onlineUsers(): UserLike[] {
  return (game.users as unknown as { contents: UserLike[] }).contents.filter((u) => u.active);
}

function activeSceneId(): string | null {
  return (game.scenes as unknown as { active?: { id: string } | null }).active?.id ?? null;
}

function myScene(): string | null {
  return (canvas as unknown as { scene?: { id: string } | null } | null)?.scene?.id ?? null;
}

/** The scene every online user reported viewing, if it is the same for all and a player is among them. */
export function gatheredScene(online: UserLike[], reports: Map<string, string | null>): string | null {
  if (!online.some((u) => !u.isGM)) return null;
  const first = reports.get(online[0].id) ?? null;
  if (!first) return null;
  return online.every((u) => reports.get(u.id) === first) ? first : null;
}

function cancelPending(): void {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}

/** Active GM: start (or call off) the short wait before making the gathered scene active. */
function evaluate(): void {
  if (!isActiveGM()) return;
  const sceneId = gatheredScene(onlineUsers(), viewing);
  if (!sceneId || sceneId === activeSceneId()) return cancelPending();
  if (pending?.sceneId === sceneId) return;
  cancelPending();
  pending = {
    sceneId,
    timer: setTimeout(() => {
      pending = null;
      // Still everyone, still there?
      if (gatheredScene(onlineUsers(), viewing) !== sceneId || sceneId === activeSceneId()) return;
      const scene = (game.scenes as unknown as { get(id: string): SceneLike | undefined }).get(sceneId);
      if (!scene) return;
      void scene.activate().then(() =>
        notify().info(fmt('kaiserkram.travel.gathered', 'Everyone is at {scene}, so it is now the active scene.', { scene: scene.name })),
      );
    }, SETTLE_MS),
  };
}

function record(userId: string, sceneId: string | null): void {
  viewing.set(userId, sceneId);
  evaluate();
}

/** Tell the active GM which scene this client shows (the GM notes its own directly). */
function report(): void {
  const userId = game.user?.id;
  if (!userId) return;
  if (isActiveGM()) record(userId, myScene());
  else emitSocket('travel', { kind: 'travel', op: 'viewing', userId, sceneId: myScene() } satisfies Message);
}

function onMessage(raw: unknown): void {
  const msg = raw as Message | undefined;
  if (msg?.kind !== 'travel') return;
  if (msg.op === 'report') report();
  else if (isActiveGM()) record(msg.userId, msg.sceneId);
}

export const travel: Feature = {
  id: 'travel',
  group: 'general',

  init() {
    on('canvasReady', report);
    on('userConnected', ((user: { id: string }, connected: boolean) => {
      if (connected) return;
      viewing.delete(user.id);
      evaluate();
    }) as (...args: never[]) => unknown);
  },

  ready() {
    registerSocketHandler('travel', onMessage);
    report();
    // A GM arriving (or taking over) asks everyone where they are.
    if (isActiveGM()) emitSocket('travel', { kind: 'travel', op: 'report' } satisfies Message);
  },
};
