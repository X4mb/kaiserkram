import { dialogV2, escapeHtml, postChat, renderTemplate, speakerFor } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { CARD_CLASS, TEMPLATES } from './constants.js';
import {
  type FoundryUser,
  type WfrpActor,
  type WfrpItem,
  type WfrpScene,
  type WfrpTokenDoc,
} from './wfrp.js';
import { formatBP } from './money.js';
import { getBool, getHaggleMode, getNumber, HAGGLE_MODES, SETTINGS } from './settings.js';
import { registerHandler, requestGM, type ActionResult } from './socket.js';
import {
  buyQuote,
  haggleState,
  isForSale,
  saveHaggleState,
  standingOf,
  type HaggleState,
} from './trader.js';
import { ACTIONS, resolveParties } from './transactions.js';

function haggleSkillName(): string {
  return loc('NAME.Haggle', 'Haggle');
}

export function askToModifier(ask: number): number {
  return -Math.round(ask * getNumber(SETTINGS.HAGGLE_DIFFICULTY));
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
  const maxAsk = getNumber(SETTINGS.HAGGLE_MAX_ASK);
  const content = await renderTemplate(TEMPLATES.HAGGLE_DIALOG, {
    item: item.name,
    trader: trader.name,
    price: formatBP(quote.unit),
    maxAsk,
    ask: Math.min(10, maxAsk),
  });

  const ask = (await dialogV2().wait({
    window: { title: fmt('kaiserkram.trader.haggle.title', 'Haggle over {item}', { item: item.name }) },
    content,
    rejectClose: false,
    render: (_event: unknown, dialog: { element: HTMLElement }) => {
      const input = dialog.element.querySelector<HTMLInputElement>('input[name="ask"]');
      const update = () => {
        const v = Number(input?.value) || 0;
        const out = (sel: string, text: string) => {
          const el = dialog.element.querySelector(sel);
          if (el) el.textContent = text;
        };
        out('[data-out="ask"]', `${v}%`);
        out('[data-out="price"]', formatBP(Math.max(1, Math.round(quote.unit * (1 - v / 100)))));
        out('[data-out="modifier"]', String(askToModifier(v)));
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
          Number((button.form.elements.namedItem('ask') as HTMLInputElement).value),
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

type Outcome = { won: boolean; margin: number; traderSL: number | null };

async function judge(trader: WfrpActor, item: WfrpItem, payload: Record<string, unknown>): Promise<Outcome> {
  const sl = Number(payload.sl) || 0;
  if (getHaggleMode() === HAGGLE_MODES.OPPOSED) {
    const test = await trader.setupSkill(
      haggleSkillName(),
      { skipDialog: true, appendTitle: ` – ${item.name}` },
      { skipTargets: true },
    );
    if (test) {
      await test.roll();
      const traderSL = Number(test.result.SL) || 0;
      const net = sl - traderSL;
      // WFRP opposed tests: higher SL wins; on a tie the higher skill wins.
      const won = net > 0 || (net === 0 && Number(payload.target) > (Number(test.result.target) || 0));
      return { won, margin: Math.max(1, Math.abs(net)), traderSL };
    }
  }
  const won = Boolean(payload.succeeded);
  return { won, margin: (won ? Math.max(0, sl) : Math.max(0, -sl)) + 1, traderSL: null };
}

function tokenCenter(t: WfrpTokenDoc, scene: WfrpScene): { x: number; y: number } {
  const size = scene.grid.size;
  return { x: t.x + (t.width * size) / 2, y: t.y + (t.height * size) / 2 };
}

/** Other player characters standing within the bystander radius of the haggler, on the trader's scene. */
function bystandersOf(trader: WfrpActor, customer: WfrpActor): WfrpActor[] {
  const radius = getNumber(SETTINGS.HAGGLE_BYSTANDER_RADIUS);
  const traderToken = trader.getActiveTokens(false, true)[0];
  const scene = traderToken?.parent ?? (canvas as unknown as { scene: WfrpScene | null }).scene;
  if (!scene) return [];
  const own = scene.tokens.contents.find((t) => t.actor?.id === customer.id);
  if (!own) return [];
  const origin = tokenCenter(own, scene);
  const found = new Map<string, WfrpActor>();
  for (const t of scene.tokens.contents) {
    const a = t.actor;
    if (!a || a.id === customer.id || a.id === trader.id || !a.hasPlayerOwner || a.type !== 'character') continue;
    const c = tokenCenter(t, scene);
    const dist = (Math.hypot(c.x - origin.x, c.y - origin.y) / scene.grid.size) * scene.grid.distance;
    if (dist <= radius) found.set(a.id, a);
  }
  return [...found.values()];
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

  const ask = Math.min(Math.max(1, Number(payload.ask) || 0), getNumber(SETTINGS.HAGGLE_MAX_ASK));
  const { won, margin } = await judge(trader, item, payload);
  const standing = standingOf(state, customer.id);
  if (!standing.tried.includes(item.id)) standing.tried.push(item.id);
  const maxPenalty = getNumber(SETTINGS.HAGGLE_MAX_PENALTY);
  const before = buyQuote(trader, item, customer.id, state).unit;
  const vars: Record<string, unknown> = {
    customer: escapeHtml(customer.name),
    trader: escapeHtml(trader.name),
    item: escapeHtml(item.name),
    ask,
    margin,
  };

  let body: string;
  if (won) {
    const discount = Math.min(ask, getNumber(SETTINGS.HAGGLE_DISCOUNT_PER_SL) * margin);
    standing.deals[item.id] = Math.max(discount, standing.deals[item.id] ?? 0);
    state[customer.id] = standing;
    vars.discount = standing.deals[item.id];
    vars.price = formatBP(buyQuote(trader, item, customer.id, state).unit);
    body = fmt(
      'kaiserkram.trader.chat.haggleWon',
      '<b>{customer}</b> asked {trader} for {ask}% off <b>{item}</b> and got <b>{discount}%</b> off. Their price: <b>{price}</b>.',
      vars,
    );
  } else {
    const increase = Math.round(
      getNumber(SETTINGS.HAGGLE_PENALTY_PER_SL) * margin + (ask * getNumber(SETTINGS.HAGGLE_GREED)) / 100,
    );
    standing.penalty = Math.min(maxPenalty, standing.penalty + increase);
    state[customer.id] = standing;
    vars.penalty = standing.penalty;
    vars.price = formatBP(buyQuote(trader, item, customer.id, state).unit);
    vars.before = formatBP(before);
    body = fmt(
      'kaiserkram.trader.chat.haggleLost',
      '<b>{customer}</b> asked {trader} for {ask}% off <b>{item}</b> and caused offence. {trader} now charges them <b>+{penalty}%</b> on everything: {item} went from {before} to <b>{price}</b>.',
      vars,
    );

    const share = getNumber(SETTINGS.HAGGLE_BYSTANDER_SHARE);
    const bystanderIncrease = Math.round((increase * share) / 100);
    if (bystanderIncrease > 0) {
      const names: string[] = [];
      for (const b of bystandersOf(trader, customer)) {
        const s = standingOf(state, b.id);
        s.penalty = Math.min(maxPenalty, s.penalty + bystanderIncrease);
        state[b.id] = s;
        names.push(escapeHtml(b.name));
      }
      if (names.length) {
        body += ` ${fmt(
          'kaiserkram.trader.chat.haggleBystanders',
          'Standing with them, {names} also pay <b>+{increase}%</b> more.',
          { names: names.join(', '), increase: bystanderIncrease },
        )}`;
      }
    }
  }

  await saveHaggleState(trader, state);
  await postChat({ speaker: speakerFor(trader), content: `<div class="${CARD_CLASS}">${body}</div>` });
  return { ok: true };
}

export function registerHaggleHandler(): void {
  registerHandler(ACTIONS.HAGGLE, handleHaggle);
}

/** GM: forget every deal and grudge this trader holds. */
export async function resetHaggling(trader: WfrpActor): Promise<void> {
  await saveHaggleState(trader, {});
}
