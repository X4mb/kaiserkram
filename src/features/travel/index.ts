import type { Feature } from '../../core/feature.js';
import { isActiveGM, notify, on } from '../../core/foundryApi.js';
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

type Message = { kind: 'travel'; op: 'viewing'; sceneId: string | null } | { kind: 'travel'; op: 'report' };

type UserLike = { id: string; isGM: boolean; active: boolean };
type SceneLike = { id: string; name: string; activate(): Promise<unknown> };

/** Everyone must stay together this long, so someone clicking through doesn't move the party. */
const SETTLE_MS = 2000;

/**
 * Active GM only: the scene each user last reported viewing. `null` means a client without a
 * canvas: it can't travel, so it doesn't hold the others back.
 */
const viewing = new Map<string, string | null>();
let pending: { sceneId: string; timer: ReturnType<typeof setTimeout> } | null = null;
/** Whether this client was the active GM last time we looked (another GM can take over). */
let wasActiveGM = false;

function onlineUsers(): UserLike[] {
  return (game.users as unknown as { contents: UserLike[] }).contents.filter((u) => u.active);
}

function activeSceneId(): string | null {
  return (game.scenes as unknown as { active?: { id: string } | null }).active?.id ?? null;
}

function myScene(): string | null {
  return (canvas as unknown as { scene?: { id: string } | null } | null)?.scene?.id ?? null;
}

/**
 * The scene everyone online has reported viewing, if they all agree. Users who haven't reported
 * yet hold it back; users without a canvas don't. At least one player has to be there.
 */
function gatheredScene(online: UserLike[], reports: Map<string, string | null>): string | null {
  let scene: string | null = null;
  let player = false;
  for (const u of online) {
    if (!reports.has(u.id)) return null;
    const s = reports.get(u.id) ?? null;
    if (s === null) continue;
    if (scene !== null && s !== scene) return null;
    scene = s;
    if (!u.isGM) player = true;
  }
  return player ? scene : null;
}

function cancelPending(): void {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}

async function activate(sceneId: string): Promise<void> {
  const scene = (game.scenes as unknown as { get(id: string): SceneLike | undefined }).get(sceneId);
  if (!scene) return;
  await scene.activate();
  notify().info(fmt('kaiserkram.travel.gathered', 'Everyone is at {scene}, so it is now the active scene.', { scene: scene.name }));
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
      activate(sceneId).catch((err) => console.error('kaiserkram | travel: activating the scene failed', err));
    }, SETTLE_MS),
  };
}

function record(userId: string, sceneId: string | null): void {
  viewing.set(userId, sceneId);
  evaluate();
}

/** Tell the active GM which scene this client shows (the GM notes its own directly). */
function report(): void {
  if (isActiveGM()) record(game.user!.id, myScene());
  else emitSocket('travel', { kind: 'travel', op: 'viewing', sceneId: myScene() } satisfies Message);
}

/** Becoming the active GM (logging in, or another GM leaving) starts over: ask everyone where they are. */
function checkRole(): void {
  const now = isActiveGM();
  if (now === wasActiveGM) return;
  wasActiveGM = now;
  viewing.clear();
  cancelPending();
  if (!now) return;
  record(game.user!.id, myScene());
  emitSocket('travel', { kind: 'travel', op: 'report' } satisfies Message);
}

function onMessage(raw: unknown, senderId: string | undefined): void {
  const msg = raw as Message | undefined;
  if (msg?.kind !== 'travel' || !senderId) return;
  if (msg.op === 'report') report();
  // Whoever sent it, by Foundry's account: a client can only speak for itself.
  else if (isActiveGM()) record(senderId, msg.sceneId);
}

export const travel: Feature = {
  id: 'travel',
  group: 'general',

  init() {
    on('canvasReady', report);
    on('userConnected', ((user: { id: string }, connected: boolean) => {
      checkRole();
      if (connected) return;
      viewing.delete(user.id);
      evaluate();
    }) as (...args: never[]) => unknown);
  },

  ready() {
    registerSocketHandler('travel', onMessage);
    checkRole();
    report();
  },
};
