import { escapeHtml, postChat, resolveDocument } from '../../../core/foundryApi.js';
import { fmt, loc } from '../../../core/i18n.js';
import { isTradeableItem, quantityOf, transferItem, type ActorLike, type ItemLike } from './items.js';
import type { CloseReason, TradeRequest, TradeSession, TradeSide, TradeUpdate } from './types.js';

/**
 * The active GM's client holds every trade: players can't change each other's actors, so the
 * GM validates each step and performs the exchange. Clients only send requests and render state.
 */

type UserLike = { id: string; name: string; isGM: boolean; active: boolean; character?: { id: string } | null };

type Session = {
  id: string;
  status: 'pending' | 'open';
  sides: [SideState, SideState];
  timer?: ReturnType<typeof setTimeout>;
  /** Trades run one at a time, so two accepts can't both execute. */
  busy: boolean;
};

type SideState = { actorUuid: string; userId: string; items: Record<string, number>; accepted: boolean };

const INVITE_TIMEOUT_MS = 120_000;
const sessions = new Map<string, Session>();
let broadcast: (msg: TradeUpdate) => void = () => {};

export function setBroadcaster(fn: (msg: TradeUpdate) => void): void {
  broadcast = fn;
}

function users(): UserLike[] {
  return (game.users as unknown as { contents: UserLike[] }).contents;
}

function userById(id: string): UserLike | undefined {
  return users().find((u) => u.id === id);
}

async function actorOf(uuid: string): Promise<ActorLike | null> {
  const doc = await resolveDocument<ActorLike & { documentName?: string }>(uuid);
  return doc?.documentName === 'Actor' ? doc : null;
}

/**
 * Who answers for `actor`. A player-owned actor is answered only by its owning players (whoever
 * has it as their character first) and never falls back to the GM: if none of them is online,
 * there is nobody to ask. Only actors no player owns (NPCs) are answered by the GM.
 */
function deciderFor(actor: ActorLike): { user: UserLike } | { offline: true } | { nobody: true } {
  const owners = users().filter((u) => !u.isGM && actor.testUserPermission(u, 'OWNER'));
  if (owners.length) {
    const online = owners.filter((u) => u.active);
    const user = online.find((u) => u.character?.id === actor.id) ?? online[0];
    return user ? { user } : { offline: true };
  }
  const gm = (game.users as unknown as { activeGM?: UserLike | null }).activeGM ?? null;
  return gm ? { user: gm } : { nobody: true };
}

async function viewOf(side: SideState): Promise<TradeSide> {
  const actor = await actorOf(side.actorUuid);
  const user = userById(side.userId);
  const items = Object.entries(side.items).flatMap(([id, qty]) => {
    const item = actor?.items.get(id);
    return item ? [{ id, name: item.name, img: item.img, qty, max: quantityOf(item) }] : [];
  });
  return {
    actorUuid: side.actorUuid,
    actorName: actor?.name ?? '?',
    actorImg: actor?.img ?? '',
    userId: side.userId,
    userName: user?.name ?? '?',
    items,
    accepted: side.accepted,
  };
}

async function viewOfSession(s: Session): Promise<TradeSession> {
  return { id: s.id, status: s.status, sides: [await viewOf(s.sides[0]), await viewOf(s.sides[1])] };
}

function close(s: Session, reason: CloseReason, by?: string, message?: string): void {
  if (s.timer) clearTimeout(s.timer);
  sessions.delete(s.id);
  broadcast({ kind: 'trade', op: 'closed', id: s.id, users: s.sides.map((x) => x.userId), reason, by, message });
}

function sideOf(s: Session, userId: string): SideState | undefined {
  return s.sides.find((x) => x.userId === userId);
}

/** Every offered item must still be there, in at least the offered quantity. */
async function validate(side: SideState): Promise<string | null> {
  const actor = await actorOf(side.actorUuid);
  if (!actor) return loc('kaiserkram.party.trade.gone', 'One of the traders no longer exists.');
  for (const [id, qty] of Object.entries(side.items)) {
    const item = actor.items.get(id);
    if (!item || !isTradeableItem(item) || qty < 1 || qty > quantityOf(item)) {
      return fmt('kaiserkram.party.trade.changed', '{actor} no longer has what they offered.', { actor: actor.name });
    }
  }
  return null;
}

async function execute(s: Session): Promise<void> {
  const [a, b] = s.sides;
  const problem = (await validate(a)) ?? (await validate(b));
  if (problem) {
    a.accepted = b.accepted = false;
    broadcast({ kind: 'trade', op: 'state', session: await viewOfSession(s) });
    close(s, 'failed', undefined, problem);
    return;
  }
  const actorA = (await actorOf(a.actorUuid))!;
  const actorB = (await actorOf(b.actorUuid))!;
  const summary = (side: SideState, actor: ActorLike) =>
    Object.entries(side.items)
      .map(([id, qty]) => `${qty}× ${escapeHtml(actor.items.get(id)?.name ?? '?')}`)
      .join(', ') || loc('kaiserkram.party.trade.nothing', 'nothing');
  const gaveA = summary(a, actorA);
  const gaveB = summary(b, actorB);

  for (const [id, qty] of Object.entries(a.items)) await transferItem(actorA.items.get(id)!, qty, actorB);
  for (const [id, qty] of Object.entries(b.items)) await transferItem(actorB.items.get(id)!, qty, actorA);

  await postChat({
    content: `<div class="kaiserkram-trade-card">${fmt(
      'kaiserkram.party.trade.chat',
      '<b>{a}</b> traded {gaveA} to <b>{b}</b> for {gaveB}.',
      { a: escapeHtml(actorA.name), b: escapeHtml(actorB.name), gaveA, gaveB },
    )}</div>`,
  });
  close(s, 'done');
}

/** Trades and gifts run through here one at a time, so two can't spend the same item. */
let queue: Promise<void> = Promise.resolve();

export function handleRequest(msg: TradeRequest): Promise<void> {
  const run = queue.then(() => handleOne(msg));
  queue = run.catch(() => {});
  return run;
}

/** Hand items over at once. Only the giver has to agree; whoever plays the receiver is told. */
async function give(sender: UserLike, msg: Extract<TradeRequest, { op: 'give' }>): Promise<void> {
  const fail = (text: string) => broadcast({ kind: 'trade', op: 'given', users: [sender.id], text, failed: true });
  const from = await actorOf(msg.from);
  const to = await actorOf(msg.to);
  if (!from || !to || from.uuid === to.uuid) return fail(loc('kaiserkram.party.trade.gone', 'One of the traders no longer exists.'));
  if (!from.testUserPermission(sender, 'OWNER')) {
    return fail(loc('kaiserkram.party.give.notYours', 'You can only give from a character you own.'));
  }
  const items: [ItemLike, number][] = [];
  for (const [id, raw] of Object.entries(msg.items ?? {})) {
    const item = from.items.get(id);
    const qty = Math.floor(Number(raw) || 0);
    if (qty < 1) continue;
    if (!item || !isTradeableItem(item) || qty > quantityOf(item)) {
      return fail(fmt('kaiserkram.party.trade.changed', '{actor} no longer has what they offered.', { actor: from.name }));
    }
    items.push([item, qty]);
  }
  if (!items.length) return fail(loc('kaiserkram.party.give.nothing', 'Choose something to give.'));
  const what = items.map(([item, qty]) => `${qty}× ${escapeHtml(item.name)}`).join(', ');
  for (const [item, qty] of items) await transferItem(item, qty, to);
  await postChat({
    content: `<div class="kaiserkram-trade-card">${fmt('kaiserkram.party.give.chat', '<b>{a}</b> gave {what} to <b>{b}</b>.', {
      a: escapeHtml(from.name),
      b: escapeHtml(to.name),
      what,
    })}</div>`,
  });
  const receivers = users().filter((u) => u.active && u.id !== sender.id && !u.isGM && to.testUserPermission(u, 'OWNER'));
  const plain = items.map(([item, qty]) => `${qty}× ${item.name}`).join(', ');
  broadcast({
    kind: 'trade',
    op: 'given',
    users: receivers.map((u) => u.id),
    text: fmt('kaiserkram.party.give.received', '{a} gave {b} {what}.', { a: from.name, b: to.name, what: plain }),
  });
  broadcast({
    kind: 'trade',
    op: 'given',
    users: [sender.id],
    text: fmt('kaiserkram.party.give.done', 'You gave {b} {what}.', { b: to.name, what: plain }),
  });
}

async function handleOne(msg: TradeRequest): Promise<void> {
  const sender = userById(msg.userId);
  if (!sender) return;

  if (msg.op === 'give') {
    try {
      await give(sender, msg);
    } catch (err) {
      console.error('[kaiserkram] party: give failed', err);
      broadcast({
        kind: 'trade',
        op: 'given',
        users: [sender.id],
        text: loc('kaiserkram.party.give.error', "Giving failed; see the GM's console."),
        failed: true,
      });
    }
    return;
  }

  if (msg.op === 'propose') {
    const from = await actorOf(msg.from);
    const to = await actorOf(msg.to);
    const fail = (message: string) =>
      broadcast({ kind: 'trade', op: 'closed', id: '', users: [sender.id], reason: 'failed', message });
    if (!from || !to || from.uuid === to.uuid) return fail(loc('kaiserkram.party.trade.gone', 'One of the traders no longer exists.'));
    if (!from.testUserPermission(sender, 'OWNER')) {
      return fail(loc('kaiserkram.party.trade.notYours', 'You can only trade as a character you own.'));
    }
    const answer = deciderFor(to);
    if ('offline' in answer) {
      return fail(fmt('kaiserkram.party.trade.offline', "{name}'s player isn't online.", { name: to.name }));
    }
    if ('nobody' in answer) return fail(loc('kaiserkram.party.trade.nobody', 'Nobody is online to answer for that character.'));
    const decider = answer.user;
    if (decider.id === sender.id) {
      return fail(loc('kaiserkram.party.trade.self', 'You answer for both characters; just drag the items across.'));
    }
    const s: Session = {
      id: foundry.utils.randomID(),
      status: 'pending',
      sides: [
        { actorUuid: from.uuid, userId: sender.id, items: {}, accepted: false },
        { actorUuid: to.uuid, userId: decider.id, items: {}, accepted: false },
      ],
      busy: false,
    };
    sessions.set(s.id, s);
    const view = await viewOfSession(s);
    s.timer = setTimeout(() => {
      if (sessions.get(s.id)?.status === 'pending') close(s, 'timeout');
    }, INVITE_TIMEOUT_MS);
    broadcast({ kind: 'trade', op: 'invite', session: view });
    broadcast({ kind: 'trade', op: 'state', session: view });
    return;
  }

  const s = sessions.get(msg.id);
  if (!s) {
    broadcast({ kind: 'trade', op: 'closed', id: msg.id, users: [sender.id], reason: 'unknown' });
    return;
  }
  const side = sideOf(s, sender.id);
  if (!side) return;

  switch (msg.op) {
    case 'respond':
      if (s.status !== 'pending' || side !== s.sides[1]) return;
      if (!msg.accept) return close(s, 'declined', sender.name);
      if (s.timer) clearTimeout(s.timer);
      s.status = 'open';
      break;
    case 'cancel':
      return close(s, 'cancelled', sender.name);
    case 'offer': {
      if (s.status !== 'open') return;
      const actor = await actorOf(side.actorUuid);
      const items: Record<string, number> = {};
      for (const [id, raw] of Object.entries(msg.items ?? {})) {
        const item = actor?.items.get(id);
        if (!item || !isTradeableItem(item)) continue;
        const qty = Math.min(quantityOf(item), Math.max(1, Math.floor(Number(raw) || 0)));
        if (qty >= 1) items[id] = qty;
      }
      side.items = items;
      // Any change to the deal needs both sides to agree again.
      s.sides[0].accepted = s.sides[1].accepted = false;
      break;
    }
    case 'accept':
      if (s.status !== 'open' || s.busy) return;
      side.accepted = Boolean(msg.accepted);
      if (s.sides[0].accepted && s.sides[1].accepted) {
        s.busy = true;
        try {
          await execute(s);
        } catch (err) {
          console.error('[kaiserkram] party: trade failed', err);
          close(s, 'failed', undefined, loc('kaiserkram.party.trade.error', 'The trade failed; see the GM\'s console.'));
        }
        return;
      }
      break;
  }
  broadcast({ kind: 'trade', op: 'state', session: await viewOfSession(s) });
}

/** A participant left: end their trades. */
export function onUserLeft(userId: string): void {
  const name = userById(userId)?.name;
  for (const s of [...sessions.values()]) if (s.sides.some((x) => x.userId === userId)) close(s, 'left', name);
}
