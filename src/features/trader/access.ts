import { MODULE_ID } from '../../core/constants.js';
import { dialogV2, expandObject, notify, on, toElement } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { DEFAULT_TRADER_IMAGE, FLAGS } from './constants.js';
import { openShop } from './shop.js';
import { onShowShop } from './socket.js';
import { isTrader, traderConfig } from './trader.js';
import { g, resolveActor, type WfrpActor } from './wfrp.js';

/**
 * Every way into a shop: the Actors sidebar (a Shops button and the context menu), the trader's
 * token (GM HUD button; players double-click it once the shop is open), the "open for business"
 * chat card, and the GM's Show to players. A player opening the trader's actor sheet gets the
 * shop instead.
 */

/** GM: create a new NPC that is a trader. */
export async function createTrader(data: Record<string, unknown> = {}): Promise<WfrpActor | null> {
  const cls = (CONFIG as unknown as { Actor: { documentClass: { create(d: unknown): Promise<unknown> } } }).Actor
    .documentClass;
  const actor = (await cls.create(
    foundry.utils.mergeObject(
      {
        name: loc('kaiserkram.trader.sheet.newTrader', 'Trader'),
        type: 'npc',
        img: DEFAULT_TRADER_IMAGE,
        prototypeToken: { texture: { src: DEFAULT_TRADER_IMAGE } },
        flags: { [MODULE_ID]: expandObject({ [FLAGS.IS_TRADER]: true }) },
      },
      data,
    ),
  )) as WfrpActor | null;
  if (actor) openShop(actor, 'manage');
  return actor;
}

async function setTrader(actor: WfrpActor, on: boolean): Promise<void> {
  if (on) {
    await actor.setFlag(MODULE_ID, FLAGS.IS_TRADER, true);
    openShop(actor, 'manage');
  } else {
    await actor.unsetFlag(MODULE_ID, FLAGS.IS_TRADER);
  }
}

/** Traders this user may visit: every trader for the GM, open shops for players. */
function visitableTraders(): WfrpActor[] {
  const traders = g().actors.contents.filter((a) => isTrader(a));
  return g().user.isGM ? traders : traders.filter((a) => traderConfig(a).open);
}

/** Open a shop: straight away if there is only one, else pick from a list. */
export async function openShopPicker(): Promise<void> {
  const traders = visitableTraders().sort((a, b) => a.name.localeCompare(b.name));
  if (!traders.length) {
    notify().info(
      g().user.isGM
        ? loc('kaiserkram.trader.notifications.noTradersGM', 'There are no traders yet. Use Create Trader, or right-click an NPC → Make Trader.')
        : loc('kaiserkram.trader.notifications.noOpenShops', 'No shop is open right now.'),
    );
    return;
  }
  if (traders.length === 1) {
    openShop(traders[0]);
    return;
  }
  const id = await dialogV2().wait({
    window: { title: loc('kaiserkram.trader.shops.title', 'Shops'), icon: 'fa-solid fa-store' },
    content: `<p>${loc('kaiserkram.trader.shops.pick', 'Which shop?')}</p>`,
    rejectClose: false,
    buttons: traders.map((t) => ({
      action: t.id,
      label: g().user.isGM && !traderConfig(t).open ? `${t.name} (${loc('kaiserkram.trader.sheet.closed', 'Closed')})` : t.name,
      icon: 'fa-solid fa-store',
    })),
  });
  const trader = typeof id === 'string' ? g().actors.get(id) : undefined;
  if (trader) openShop(trader);
}

function headerButton(className: string, icon: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.innerHTML = `<i class="fa-solid ${icon}"></i> ${label}`;
  button.addEventListener('click', onClick);
  return button;
}

function addDirectoryButtons(_app: unknown, html: unknown): void {
  const actions = toElement(html)?.querySelector('.header-actions');
  if (!actions) return;
  const shopsClass = `${MODULE_ID}-trader-shops`;
  if (!actions.querySelector(`.${shopsClass}`)) {
    actions.append(headerButton(shopsClass, 'fa-store', loc('kaiserkram.trader.shops.button', 'Shops'), () => void openShopPicker()));
  }
  const createClass = `${MODULE_ID}-trader-create`;
  if (g().user.isGM && !actions.querySelector(`.${createClass}`)) {
    actions.append(
      headerButton(createClass, 'fa-plus', loc('kaiserkram.trader.sheet.createTrader', 'Create Trader'), () => void createTrader()),
    );
  }
}

type ContextOption = {
  name: string;
  icon: string;
  condition: (li: HTMLElement) => boolean;
  callback: (li: HTMLElement) => unknown;
};

function actorFromRow(li: HTMLElement): WfrpActor | undefined {
  const id = li.dataset.entryId ?? li.dataset.documentId;
  return id ? g().actors.get(id) : undefined;
}

function addActorContextOptions(_app: unknown, options: ContextOption[]): void {
  options.push(
    {
      name: 'kaiserkram.trader.context.openShop',
      icon: '<i class="fa-solid fa-store"></i>',
      condition: (li) => {
        const a = actorFromRow(li);
        return !!a && isTrader(a) && (g().user.isGM || traderConfig(a).open);
      },
      callback: (li) => {
        const a = actorFromRow(li);
        if (a) openShop(a);
      },
    },
    {
      name: 'kaiserkram.trader.context.makeTrader',
      icon: '<i class="fa-solid fa-scale-balanced"></i>',
      condition: (li) => {
        const a = actorFromRow(li);
        return g().user.isGM && !!a && a.type === 'npc' && !isTrader(a);
      },
      callback: (li) => {
        const a = actorFromRow(li);
        if (a) void setTrader(a, true);
      },
    },
    {
      name: 'kaiserkram.trader.context.stopTrader',
      icon: '<i class="fa-solid fa-ban"></i>',
      condition: (li) => {
        const a = actorFromRow(li);
        return g().user.isGM && !!a && isTrader(a);
      },
      callback: (li) => {
        const a = actorFromRow(li);
        if (a) void setTrader(a, false);
      },
    },
  );
}

function addTokenHudButton(hud: unknown, html: unknown): void {
  if (!g().user.isGM) return;
  const actor = (hud as { object?: { actor?: WfrpActor | null } }).object?.actor;
  if (!actor || !isTrader(actor)) return;
  const root = toElement(html);
  const column = root?.querySelector('.col.right') ?? root?.querySelector('.col.left') ?? root;
  if (!column || column.querySelector(`.${MODULE_ID}-trader-hud`)) return;
  const button = document.createElement('div');
  button.classList.add('control-icon', `${MODULE_ID}-trader-hud`);
  button.setAttribute('role', 'button');
  button.title = loc('kaiserkram.trader.hud.shop', 'Open shop window');
  button.innerHTML = '<i class="fa-solid fa-store"></i>';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openShop(actor);
  });
  column.appendChild(button);
}

/** Players who open a trader's actor sheet (sidebar click, token double-click) get the shop instead. */
function redirectSheet(app: unknown): void {
  if (g().user.isGM) return;
  const a = app as { document?: WfrpActor; actor?: WfrpActor; object?: WfrpActor; close(): unknown };
  const actor = a.document ?? a.actor ?? a.object;
  if (!actor || (actor as { documentName?: string }).documentName !== 'Actor' || !isTrader(actor)) return;
  void a.close();
  if (traderConfig(actor).open) openShop(actor);
  else notify().info(fmt('kaiserkram.trader.notifications.closed', "{trader} isn't trading right now.", { trader: actor.name }));
}

function bindChatButtons(_message: unknown, html: unknown): void {
  const root = toElement(html);
  root?.querySelectorAll<HTMLElement>(`[data-${MODULE_ID}-shop]`).forEach((button) =>
    button.addEventListener('click', async () => {
      const trader = await resolveActor(button.getAttribute(`data-${MODULE_ID}-shop`) ?? '');
      if (!trader || !isTrader(trader)) return;
      if (g().user.isGM || traderConfig(trader).open) openShop(trader);
      else notify().info(fmt('kaiserkram.trader.notifications.closed', "{trader} isn't trading right now.", { trader: trader.name }));
    }),
  );
}

export function registerShopAccess(): void {
  on('renderActorDirectory', addDirectoryButtons);
  on('getActorContextOptions', addActorContextOptions as (...args: never[]) => unknown);
  on('renderTokenHUD', addTokenHudButton);
  on('renderActorSheetV2', redirectSheet);
  on('renderActorSheet', redirectSheet);
  on('renderChatMessageHTML', bindChatButtons);
  onShowShop((uuid) => {
    void resolveActor(uuid).then((trader) => {
      if (trader && isTrader(trader)) openShop(trader);
    });
  });
}
