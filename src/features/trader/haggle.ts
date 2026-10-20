import { dialogV2, escapeHtml, postChat, renderTemplate, speakerFor } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { CARD_CLASS, TEMPLATES } from './constants.js';
import { type FoundryUser, type WfrpActor, type WfrpItem } from './wfrp.js';
import { formatBP } from './money.js';
import { getBool, getNumber, SETTINGS } from './settings.js';
import { registerHandler, requestGM, type ActionResult } from './socket.js';
import { buyQuote, haggleState, isForSale, saveHaggleState, standingOf, type HaggleState } from './trader.js';
import { ACTIONS, resolveParties } from './transactions.js';

/** Largest discount a player can ask for, in %. */
export const MAX_ASK = 80;

function haggleSkillName(): string {
  return loc('NAME.Haggle', 'Haggle');
}

export function clampAsk(ask: unknown): number {
  return Math.min(MAX_ASK, Math.max(5, Math.round((Number(ask) || 0) / 5) * 5));
}

/** How sharply the curve bends: higher keeps small asks cheaper and makes big ones steeper. */
const CURVE = 2;

/**
 * Test modifier for the player's Haggle: never a bonus. Asks up to the GM's free amount (10% by
 * default) are a plain test; above it the penalty grows exponentially, so small asks cost little
 * and big ones a lot, reaching 16 × the GM's difficulty at the maximum ask (5 by default: 20% is
 * −4, 40% −17, 60% −40, 80% −80).
 */
export function askToModifier(ask: number): number {
  const perStep = Math.max(0, getNumber(SETTINGS.HAGGLE_STEP) || 0);
  const free = Math.min(MAX_ASK - 5, Math.max(0, getNumber(SETTINGS.HAGGLE_FREE) || 0));
  const over = clampAsk(ask) - free;
  if (over <= 0) return 0;
  const atMax = perStep * (MAX_ASK / 5);
  const share = (Math.exp((CURVE * over) / (MAX_ASK - free)) - 1) / (Math.exp(CURVE) - 1);
  return -Math.round(atMax * share) || 0;
}

/** Whether `customerId` may haggle over `itemId` with this trader right now. */
export function canHaggle(state: HaggleState, customerId: string, itemId: string): boolean {
  if (!getBool(SETTINGS.HAGGLE_ENABLED)) return false;
  if (getBool(SETTINGS.HAGGLE_RETRY)) return true;
  return !standingOf(state, customerId).tried.includes(itemId);
}

/** Player side: ask how much off, roll Haggle, and hand the result to the GM to settle. */
export async function startHaggle(trader: WfrpActor, item: WfrpItem, customer: WfrpActor): Promise<void> {
  if (!canHaggle(haggleState(trader), customer.id, item.id)) {
    const notify = ui.notifications as unknown as { warn(m: string): void };
    notify.warn(
      fmt('kaiserkram.trader.notifications.alreadyHaggled', '{trader} won\'t haggle over {item} with you again.', {
        trader: trader.name,
        item: item.name,
      }),
    );
    return;
  }

  const quote = buyQuote(trader, item, customer.id);
  const content = await renderTemplate(TEMPLATES.HAGGLE_DIALOG, {
    item: item.name,
    trader: trader.name,
    price: formatBP(quote.unit),
    maxAsk: MAX_ASK,
    ask: 10,
  });

  const ask = (await dialogV2().wait({
    window: { title: fmt('kaiserkram.trader.haggle.title', 'Haggle over {item}', { item: item.name }) },
    content,
    rejectClose: false,
    render: (_event: unknown, dialog: { element: HTMLElement }) => {
      const input = dialog.element.querySelector<HTMLInputElement>('input[name="ask"]');
      const update = () => {
        const v = clampAsk(input?.value);
        const out = (sel: string, text: string) => {
          const el = dialog.element.querySelector(sel);
          if (el) el.textContent = text;
        };
        const mod = askToModifier(v);
        out('[data-out="ask"]', `${v}%`);
        out('[data-out="price"]', formatBP(Math.max(1, Math.round(quote.unit * (1 - v / 100)))));
        out('[data-out="modifier"]', mod === 0 ? '±0' : String(mod));
      };
      input?.addEventListener('input', update);
      update();
    },
    buttons: [
      {
        action: 'haggle',
        label: loc('kaiserkram.trader.haggle.roll', 'Roll Haggle'),
        icon: 'fa-solid fa-scale-balanced',
        default: true,
        callback: (_event: unknown, button: { form: HTMLFormElement }) =>
          clampAsk((button.form.elements.namedItem('ask') as HTMLInputElement).value),
      },
      { action: 'cancel', label: loc('kaiserkram.trader.common.cancel', 'Cancel') },
    ],
  })) as number | string | null;
  if (typeof ask !== 'number' || ask <= 0) return;

  const test = await customer.setupSkill(
    haggleSkillName(),
    { appendTitle: ` – ${item.name}`, fields: { modifier: askToModifier(ask) } },
    { skipTargets: true },
  );
  if (!test) return;
  await test.roll();

  await requestGM(ACTIONS.HAGGLE, {
    traderUuid: trader.uuid,
    customerUuid: customer.uuid,
    itemId: item.id,
    ask,
    sl: Number(test.result.SL) || 0,
    succeeded: test.succeeded,
    target: Number(test.result.target) || 0,
  });
}

type Outcome = { won: boolean; sl: number; traderSL: number | null };

/**
 * An opposed Haggle test: the player's (already rolled, with the ask's modifier) against the
 * trader's, rolled here without a modifier. Higher SL wins; on a tie the higher skill wins.
 * If the trader can't roll, the player's own test decides.
 */
async function judge(trader: WfrpActor, item: WfrpItem, payload: Record<string, unknown>): Promise<Outcome> {
  const sl = Number(payload.sl) || 0;
  const test = await trader.setupSkill(
    haggleSkillName(),
    { skipDialog: true, appendTitle: ` – ${item.name}` },
    { skipTargets: true },
  );
  if (test) {
    await test.roll();
    const traderSL = Number(test.result.SL) || 0;
    const won = sl > traderSL || (sl === traderSL && Number(payload.target) > (Number(test.result.target) || 0));
    return { won, sl, traderSL };
  }
  return { won: Boolean(payload.succeeded), sl, traderSL: null };
}

async function handleHaggle(payload: Record<string, unknown>, user: FoundryUser): Promise<ActionResult> {
  const parties = await resolveParties(payload, user);
  if ('ok' in parties) return parties;
  const { trader, customer } = parties;
  const item = trader.items.get(String(payload.itemId ?? ''));
  if (!item || !isForSale(item)) {
    return { ok: false, message: loc('kaiserkram.trader.notifications.notForSale', 'That item isn\'t for sale.') };
  }
  const state = haggleState(trader);
  if (!canHaggle(state, customer.id, item.id)) {
    return {
      ok: false,
      message: fmt('kaiserkram.trader.notifications.alreadyHaggled', '{trader} won\'t haggle over {item} with you again.', {
        trader: trader.name,
        item: item.name,
      }),
    };
  }

  const ask = clampAsk(payload.ask);
  const { won, sl, traderSL } = await judge(trader, item, payload);
  const standing = standingOf(state, customer.id);
  if (!standing.tried.includes(item.id)) standing.tried.push(item.id);
  if (won) standing.deals[item.id] = Math.max(ask, standing.deals[item.id] ?? 0);
  state[customer.id] = standing;

  const vars: Record<string, unknown> = {
    customer: escapeHtml(customer.name),
    trader: escapeHtml(trader.name),
    item: escapeHtml(item.name),
    ask,
    price: formatBP(buyQuote(trader, item, customer.id, state).unit),
    rolls: traderSL === null ? `${sl} SL` : `${sl} SL vs ${traderSL} SL`,
  };
  const body = won
    ? fmt(
        'kaiserkram.trader.chat.haggleWon',
        '<b>{customer}</b> talked {trader} down by <b>{ask}%</b> on <b>{item}</b> ({rolls}). Their price: <b>{price}</b>.',
        vars,
      )
    : fmt(
        'kaiserkram.trader.chat.haggleLost',
        '<b>{customer}</b> asked {trader} for {ask}% off <b>{item}</b>, but {trader} wouldn\'t budge ({rolls}). The price stays <b>{price}</b>.',
        vars,
      );

  await saveHaggleState(trader, state);
  await postChat({ speaker: speakerFor(trader), content: `<div class="${CARD_CLASS}">${body}</div>` });
  return { ok: true };
}

export function registerHaggleHandler(): void {
  registerHandler(ACTIONS.HAGGLE, handleHaggle);
}

/** GM: forget every deal this trader has made. */
export async function resetHaggling(trader: WfrpActor): Promise<void> {
  await saveHaggleState(trader, {});
}
