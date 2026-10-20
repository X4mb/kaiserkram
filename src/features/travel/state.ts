import { MODULE_ID } from '../../core/constants.js';
import { notify, settings } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { emitSocket } from '../../core/socket.js';

/**
 * The vote lives in a world setting that only the active GM writes; every client renders from it
 * (a world setting's onChange runs everywhere). Players ask the GM through the socket.
 */

export type Vote = { sceneId: string; by: string; votes: Record<string, boolean>; at: number };
export type Request =
  | { kind: 'travel'; op: 'propose'; userId: string; sceneId: string }
  | { kind: 'travel'; op: 'vote'; userId: string; yes: boolean }
  | { kind: 'travel'; op: 'cancel'; userId: string };

export const SETTING = 'travelVote';

type UserLike = { id: string; name: string; isGM: boolean; active: boolean; isSelf?: boolean };
type SceneLike = { id: string; name: string; thumb?: string | null; activate(): Promise<unknown>; view(): Promise<unknown> };

export function users(): UserLike[] {
  return (game.users as unknown as { contents: UserLike[] }).contents;
}

export function onlinePlayers(): UserLike[] {
  return users().filter((u) => u.active && !u.isGM);
}

export function sceneById(id: string | undefined): SceneLike | undefined {
  return id ? (game.scenes as unknown as { get(id: string): SceneLike | undefined }).get(id) : undefined;
}

export function currentVote(): Vote | null {
  const v = settings().get(MODULE_ID, SETTING) as Partial<Vote> | null | undefined;
  return v?.sceneId && sceneById(v.sceneId) ? (v as Vote) : null;
}

/** Everyone online (players only) has said yes. */
export function allReady(vote: Vote): boolean {
  const players = onlinePlayers();
  return players.length > 0 && players.every((u) => vote.votes[u.id] === true);
}

function activeGM(): UserLike | null {
  return (game.users as unknown as { activeGM?: UserLike | null }).activeGM ?? null;
}

async function save(vote: Vote | null): Promise<void> {
  await settings().set(MODULE_ID, SETTING, vote ?? {});
}

/** Players → the active GM (who handles its own requests directly; sockets don't echo). */
export function request(body: { op: 'propose'; sceneId: string } | { op: 'vote'; yes: boolean } | { op: 'cancel' }): void {
  const gm = activeGM();
  if (!gm) {
    notify().warn(loc('kaiserkram.travel.noGM', 'A GM needs to be online for a travel vote.'));
    return;
  }
  const msg = { ...body, kind: 'travel', userId: game.user?.id ?? '' } as Request;
  if (gm.isSelf) void handleRequest(msg);
  else emitSocket('travel', msg);
}

export function onTravelMessage(raw: unknown): void {
  const msg = raw as Request | undefined;
  if (msg?.kind !== 'travel') return;
  if (activeGM()?.isSelf) void handleRequest(msg);
}

/** Active GM only. */
export async function handleRequest(msg: Request): Promise<void> {
  const sender = users().find((u) => u.id === msg.userId);
  if (!sender) return;
  const vote = currentVote();
  switch (msg.op) {
    case 'propose': {
      const scene = sceneById(msg.sceneId);
      if (!scene) return;
      // The same scene again keeps the votes so far; another one starts over.
      if (vote?.sceneId === scene.id) {
        if (!sender.isGM) vote.votes[sender.id] = true;
        return save(vote);
      }
      const votes: Record<string, boolean> = {};
      if (!sender.isGM) votes[sender.id] = true;
      return save({ sceneId: scene.id, by: sender.id, votes, at: Date.now() });
    }
    case 'vote':
      if (!vote || sender.isGM) return;
      vote.votes[sender.id] = Boolean(msg.yes);
      return save(vote);
    case 'cancel':
      if (!vote || !(sender.isGM || sender.id === vote.by)) return;
      return save(null);
  }
}

/** GM: make the voted scene active for everyone and close the vote. */
export async function approve(): Promise<void> {
  const vote = currentVote();
  const scene = sceneById(vote?.sceneId);
  if (!vote || !scene || !game.user?.isGM) return;
  await save(null);
  await scene.activate();
  notify().info(fmt('kaiserkram.travel.travelled', 'The party travels to {scene}.', { scene: scene.name }));
}

/** GM: a scene became active some other way; a vote for it is settled. */
export async function settleIfActive(sceneId: string): Promise<void> {
  if (!activeGM()?.isSelf) return;
  if (currentVote()?.sceneId === sceneId) await save(null);
}

export function proposerName(vote: Vote): string {
  return users().find((u) => u.id === vote.by)?.name ?? '?';
}
