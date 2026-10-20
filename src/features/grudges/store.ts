import { MODULE_ID } from '../../core/constants.js';
import { escapeHtml, postChat } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { getSteadiness } from './settings.js';

/**
 * Grudges and favours are one-sided: what the holder feels about a target. They live on the
 * holder's actor (the token's actor for an unlinked NPC), so whoever owns the holder manages
 * them: players their own characters, the GM everyone.
 */

export type Kind = 'good' | 'bad';
export type LogEntry = { at: number; kind: Kind; delta: 1 | -1; reason?: string; by: string };
export type Relation = { target: string; name: string; img: string; good: number; bad: number; log: LogEntry[] };

export type HolderLike = {
  uuid: string;
  id: string;
  name: string;
  img: string;
  isOwner: boolean;
  getFlag(scope: string, key: string): unknown;
  setFlag(scope: string, key: string, value: unknown): Promise<unknown>;
};
export type TargetLike = { uuid: string; name: string; img: string };

const FLAG = 'grudges.relations';
const LOG_LIMIT = 20;
const MIN_CHANCE = 5;
const MAX_CHANCE = 95;

export function relationsOf(holder: HolderLike): Relation[] {
  const v = holder.getFlag(MODULE_ID, FLAG);
  return Array.isArray(v) ? (foundry.utils.deepClone(v) as Relation[]) : [];
}

export function relationTo(holder: HolderLike, targetUuid: string): Relation | undefined {
  return relationsOf(holder).find((r) => r.target === targetUuid);
}

/**
 * The chance (in %) that a decision goes the target's way: favour's share of all points, with
 * `steadiness` hidden points on each side to start with. So 0/0 is 50%, the first few points
 * barely move it, and a long history weighs most (at 5: 1/0 is 55%, 10/0 75%, 10/5 60%).
 */
export function chanceOf(rel: { good: number; bad: number } | undefined, steadiness = getSteadiness()): number {
  const good = (rel?.good ?? 0) + steadiness;
  const bad = (rel?.bad ?? 0) + steadiness;
  const chance = good + bad > 0 ? Math.round((100 * good) / (good + bad)) : 50;
  return Math.min(MAX_CHANCE, Math.max(MIN_CHANCE, chance));
}

/** Add (or take away) one point of favour or grudge. Counts never go below 0. */
export async function adjust(holder: HolderLike, target: TargetLike, kind: Kind, delta: 1 | -1, reason?: string): Promise<void> {
  const relations = relationsOf(holder);
  let rel = relations.find((r) => r.target === target.uuid);
  if (!rel) {
    if (delta < 0) return;
    rel = { target: target.uuid, name: target.name, img: target.img, good: 0, bad: 0, log: [] };
    relations.push(rel);
  }
  if (delta < 0 && rel[kind] <= 0) return;
  rel[kind] += delta;
  // Keep the name and picture current, for when the target can't be looked up later.
  rel.name = target.name;
  rel.img = target.img;
  const entry: LogEntry = { at: Date.now(), kind, delta, by: game.user?.name ?? '?' };
  if (reason?.trim()) entry.reason = reason.trim();
  rel.log = [entry, ...rel.log].slice(0, LOG_LIMIT);
  await holder.setFlag(MODULE_ID, FLAG, relations);
}

export async function forget(holder: HolderLike, targetUuid: string): Promise<void> {
  await holder.setFlag(MODULE_ID, FLAG, relationsOf(holder).filter((r) => r.target !== targetUuid));
}

/**
 * Roll d100 for a decision between holder and target: at or under the chance, it goes the
 * target's way. Only the user who rolled sees the result.
 */
export async function decide(holder: HolderLike, target: TargetLike): Promise<void> {
  const rel = relationTo(holder, target.uuid);
  const chance = chanceOf(rel);
  const RollCls = (globalThis as unknown as { Roll: new (f: string) => { evaluate(): Promise<{ total: number }> } }).Roll;
  const roll = await new RollCls('1d100').evaluate();
  const good = roll.total <= chance;
  const vars = {
    holder: escapeHtml(holder.name),
    target: escapeHtml(target.name),
    good: rel?.good ?? 0,
    bad: rel?.bad ?? 0,
    chance,
    roll: roll.total,
  };
  const outcome = good
    ? loc('kaiserkram.grudges.roll.good', 'In their favour')
    : loc('kaiserkram.grudges.roll.bad', 'Against them');
  await postChat({
    content: `<div class="kaiserkram-grudge-card ${good ? 'good' : 'bad'}">
      <p>${fmt('kaiserkram.grudges.roll.card', '<b>{holder}</b> towards <b>{target}</b>: {good} favour / {bad} grudge, <b>{chance}%</b> in their favour.', vars)}</p>
      <p class="outcome">${fmt('kaiserkram.grudges.roll.rolled', 'Rolled {roll}:', vars)} <b>${escapeHtml(outcome)}</b></p>
    </div>`,
    rolls: [roll],
    whisper: game.user ? [game.user.id] : [],
  });
}
