import { MODULE_ID } from '../../core/constants.js';
import { escapeHtml, postChat, speakerFor } from '../../core/foundryApi.js';
import { fmt } from '../../core/i18n.js';
import { allOrNothing, sameGoods, type Undo } from '../../core/items.js';
import { CARD_CLASS } from './constants.js';
import {
  resolveActor,
  type FoundryUser,
  type WfrpActor,
  type WfrpItem,
} from './wfrp.js';
import { applyPurse, formatBP, planCredit, planPayment, purseOf, purseTotal } from './money.js';
import { getBool, SETTINGS } from './settings.js';
import { registerHandler, type ActionResult } from './socket.js';
import {
  buyQuote,
  haggleState,
  isForSale,
  isInfinite,
  isTradeable,
  isTrader,
  saveHaggleState,
  sellQuote,
  standingOf,
  stockQuantity,
  totalFor,
  traderConfig,
} from './trader.js';

export const ACTIONS = {
  BUY: 'buy',
  SELL: 'sell',
  HAGGLE: 'haggle',
} as const;

export type TradeParties = { trader: WfrpActor; customer: WfrpActor };

function fail(key: string, fallback: string, data: Record<string, unknown> = {}): ActionResult {
  return { ok: false, message: fmt(key, fallback, data) };
}

/** Resolve both sides of a trade and check the requesting user is allowed to make it. */
export async function resolveParties(
  payload: Record<string, unknown>,
  user: FoundryUser,
): Promise<TradeParties | ActionResult> {
  const trader = await resolveActor(String(payload.traderUuid ?? ''));
  const customer = await resolveActor(String(payload.customerUuid ?? ''));
  if (!trader || !isTrader(trader)) return fail('kaiserkram.trader.notifications.noTrader', 'That trader no longer exists.');
  if (!customer) return fail('kaiserkram.trader.notifications.noCustomer', 'Pick a character to trade with first.');
  if (!user.isGM && !customer.testUserPermission(user, 'OWNER')) {
    return fail('kaiserkram.trader.notifications.notYours', 'You can only trade for a character you own.');
  }
  if (!user.isGM && !traderConfig(trader).open) {
    return fail('kaiserkram.trader.notifications.closed', '{trader} isn\'t trading right now.', { trader: trader.name });
  }
  return { trader, customer };
}

function isResult(v: TradeParties | ActionResult): v is ActionResult {
  return 'ok' in v;
}

/** Item data for a copy of `item` that changes hands: no shop flags, nothing equipped. */
function transferData(item: WfrpItem, qty: number): Record<string, unknown> {
  const data = item.toObject();
  delete data._id;
  if (data.flags) delete data.flags[MODULE_ID];
  data.system.quantity = { value: qty };
  if (data.system.location) data.system.location.value = '';
  for (const key of ['equipped', 'worn']) {
    if (data.system[key] && typeof data.system[key] === 'object' && 'value' in data.system[key]) {
      data.system[key].value = false;
    }
  }
  return data;
}

/**
 * Put `qty` of `item` into `actor`'s inventory, stacking onto the same goods if they are there
 * (not just something of the same name: a sword with other qualities stays separate).
 */
async function receiveItem(
  actor: WfrpActor,
  item: WfrpItem,
  qty: number,
  undo: Undo,
  canStack: (i: WfrpItem) => boolean = isTradeable,
): Promise<void> {
  const match = actor.items.contents.find((i) => canStack(i) && sameGoods(i, item));
  if (match) {
    const before = stockQuantity(match);
    await match.update({ 'system.quantity.value': before + qty });
    undo.push(() => match.update({ 'system.quantity.value': before }));
  } else {
    const [created] = (await actor.createEmbeddedDocuments('Item', [transferData(item, qty)])) ?? [];
    if (created) undo.push(() => actor.deleteEmbeddedDocuments('Item', [created.id]));
  }
}

/** Remove `qty` of `item` from its owner, deleting the item when none are left. */
async function removeItem(actor: WfrpActor, item: WfrpItem, qty: number, undo: Undo): Promise<void> {
  const had = stockQuantity(item);
  const left = had - qty;
  if (left > 0) {
    await item.update({ 'system.quantity.value': left });
    undo.push(() => item.update({ 'system.quantity.value': had }));
  } else {
    const original = item.toObject();
    await actor.deleteEmbeddedDocuments('Item', [item.id]);
    undo.push(() => actor.createEmbeddedDocuments('Item', [original], { keepId: true }));
  }
}

function clampQty(v: unknown): number {
  return Math.max(1, Math.floor(Number(v) || 1));
}

function card(trader: WfrpActor, body: string): Promise<void> {
  return postChat({
    speaker: speakerFor(trader),
    content: `<div class="${CARD_CLASS}">${body}</div>`,
  });
}

async function handleBuy(payload: Record<string, unknown>, user: FoundryUser): Promise<ActionResult> {
  const parties = await resolveParties(payload, user);
  if (isResult(parties)) return parties;
  const { trader, customer } = parties;

  const item = trader.items.get(String(payload.itemId ?? ''));
  if (!item || !isForSale(item)) return fail('kaiserkram.trader.notifications.notForSale', 'That item isn\'t for sale.');
  const qty = clampQty(payload.qty);
  const infinite = isInfinite(item);
  if (!infinite && stockQuantity(item) < qty) {
    return fail('kaiserkram.trader.notifications.notEnoughStock', '{trader} only has {count} of {item}.', {
      trader: trader.name,
      count: stockQuantity(item),
      item: item.name,
    });
  }

  const state = haggleState(trader);
  const quote = buyQuote(trader, item, customer.id, state);
  const total = totalFor(quote, qty);
  const customerPurse = purseOf(customer);
  const paid = planPayment(customerPurse, total);
  if (!paid) {
    return fail('kaiserkram.trader.notifications.cantAfford', '{customer} can\'t afford {total} (has {has}).', {
      customer: customer.name,
      total: formatBP(total),
      has: formatBP(purseTotal(customerPurse)),
    });
  }

  // All of it or none: if a step fails, the ones before it are put back.
  await allOrNothing(async (undo) => {
    await applyPurse(customer, customerPurse, paid, undo);
    const traderPurse = purseOf(trader);
    await applyPurse(trader, traderPurse, planCredit(traderPurse, total), undo);
    await receiveItem(customer, item, qty, undo);
    if (!infinite) await removeItem(trader, item, qty, undo);
    if (quote.deal) {
      const standing = standingOf(state, customer.id);
      delete standing.deals[item.id];
      state[customer.id] = standing;
      await saveHaggleState(trader, state);
    }
  });

  await card(
    trader,
    fmt('kaiserkram.trader.chat.bought', '<b>{customer}</b> bought {qty}× <b>{item}</b> from {trader} for <b>{total}</b>.', {
      customer: escapeHtml(customer.name),
      qty,
      item: escapeHtml(item.name),
      trader: escapeHtml(trader.name),
      total: formatBP(total),
    }),
  );
  return { ok: true };
}

async function handleSell(payload: Record<string, unknown>, user: FoundryUser): Promise<ActionResult> {
  const parties = await resolveParties(payload, user);
  if (isResult(parties)) return parties;
  const { trader, customer } = parties;

  if (!traderConfig(trader).buysFromPlayers) {
    return fail('kaiserkram.trader.notifications.doesntBuy', '{trader} doesn\'t buy from customers.', { trader: trader.name });
  }
  const item = customer.items.get(String(payload.itemId ?? ''));
  if (!item || !isTradeable(item)) return fail('kaiserkram.trader.notifications.cantSell', 'That can\'t be sold.');
  const qty = Math.min(clampQty(payload.qty), stockQuantity(item));
  if (qty < 1) return fail('kaiserkram.trader.notifications.cantSell', 'That can\'t be sold.');

  const total = (await sellQuote(trader, item)) * qty;
  const traderPurse = purseOf(trader);
  const traderPaid = getBool(SETTINGS.ENFORCE_PURSE) ? planPayment(traderPurse, total) : null;
  if (getBool(SETTINGS.ENFORCE_PURSE) && !traderPaid) {
    return fail('kaiserkram.trader.notifications.traderCantAfford', '{trader} can\'t afford {total} right now.', {
      trader: trader.name,
      total: formatBP(total),
    });
  }
  await allOrNothing(async (undo) => {
    if (traderPaid) await applyPurse(trader, traderPurse, traderPaid, undo);
    const customerPurse = purseOf(customer);
    await applyPurse(customer, customerPurse, planCredit(customerPurse, total), undo);
    await receiveItem(trader, item, qty, undo, isForSale);
    await removeItem(customer, item, qty, undo);
  });

  await card(
    trader,
    fmt('kaiserkram.trader.chat.sold', '<b>{customer}</b> sold {qty}× <b>{item}</b> to {trader} for <b>{total}</b>.', {
      customer: escapeHtml(customer.name),
      qty,
      item: escapeHtml(item.name),
      trader: escapeHtml(trader.name),
      total: formatBP(total),
    }),
  );
  return { ok: true };
}

export function registerTransactionHandlers(): void {
  registerHandler(ACTIONS.BUY, handleBuy);
  registerHandler(ACTIONS.SELL, handleSell);
}
