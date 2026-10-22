import { MODULE_ID } from '../../core/constants.js';
import { contextEntry, dialogV2, escapeHtml, expandObject, notify, on, toElement } from '../../core/foundryApi.js';
import { applyPurse, parsePrice, planCredit, purseOf } from './money.js';
import { getNumber, SETTINGS } from './settings.js';
import { fmt, loc } from '../../core/i18n.js';
import { DEFAULT_TRADER_IMAGE, FLAGS } from './constants.js';
import { openShop } from './shop.js';
import { onShowShop } from './socket.js';
import { isTrader, traderConfig } from './trader.js';
import { g, resolveActor, type WfrpActor } from './wfrp.js';

/**
 * Every way into a shop: the Actors sidebar (a Shops button and the context menu), the trader's
 * token (GM HUD button; players double-click it, and are told when it's closed), the "open for business"
 * chat card, and the GM's Show to players. A player opening the trader's actor sheet gets the
 * shop instead.
 */

type ItemData = Record<string, unknown> & { name: string; type: string };

/** Every WFRP4e basic skill, from the system's own helper or, failing that, its compendiums. */
async function basicSkills(): Promise<ItemData[]> {
  const utility = (game as unknown as { wfrp4e?: { utility?: { allBasicSkills?(): Promise<ItemData[]> } } }).wfrp4e?.utility;
  try {
    const skills = await utility?.allBasicSkills?.();
    if (skills?.length) return skills;
  } catch (err) {
    console.warn('[kaiserkram] trader: allBasicSkills failed, reading the compendiums instead', err);
  }
  type Pack = {
    documentName: string;
    getIndex(o: { fields: string[] }): Promise<Iterable<{ _id: string; name: string; type: string; system?: { advanced?: { value?: string } } }>>;
    getDocument(id: string): Promise<{ toObject(): ItemData } | null>;
  };
  const found = new Map<string, ItemData>();
  for (const pack of (game as unknown as { packs: { contents: Pack[] } }).packs.contents) {
    if (pack.documentName !== 'Item') continue;
    const index = await pack.getIndex({ fields: ['system.advanced.value'] });
    for (const entry of index) {
      if (entry.type !== 'skill' || entry.system?.advanced?.value !== 'bsc' || found.has(entry.name)) continue;
      const doc = await pack.getDocument(entry._id);
      if (doc) found.set(entry.name, doc.toObject());
    }
  }
  return [...found.values()];
}

function withoutId(item: ItemData): ItemData {
  const data = { ...item };
  delete data._id;
  return data;
}

/** Give `actor` every basic skill it lacks, so its tests (Haggle above all) use real skills. */
async function ensureBasicSkills(actor: WfrpActor): Promise<void> {
  const have = new Set(actor.items.contents.filter((i) => i.type === 'skill').map((i) => i.name));
  const missing = (await basicSkills()).filter((s) => !have.has(s.name)).map(withoutId);
  if (missing.length) await actor.createEmbeddedDocuments('Item', missing);
}

/** Set the actor's Haggle to `target` in total, by its advances on top of Fellowship. */
async function setHaggle(actor: WfrpActor, target: number): Promise<void> {
  const name = loc('NAME.Haggle', 'Haggle');
  const skill = actor.items.contents.find((i) => i.type === 'skill' && i.name === name);
  if (!skill) return;
  const fel = actor as unknown as { system?: { characteristics?: { fel?: { value?: number; initial?: number } } } };
  let felValue = Number(fel.system?.characteristics?.fel?.value) || 0;
  // A blank NPC has 0 in everything; give it an ordinary Fellowship so the skill isn't all advances.
  if (felValue === 0) {
    felValue = Math.min(target, 30);
    await (actor as unknown as { update(d: Record<string, unknown>): Promise<unknown> }).update({
      'system.characteristics.fel.initial': felValue,
    });
  }
  await skill.update({ 'system.advances.value': Math.max(0, Math.round(target - felValue)) });
}

/** GM, from Create Trader: ask for the name, Haggle and starting coins, then create it. */
async function promptCreateTrader(): Promise<WfrpActor | null> {
  const content = `<div class="kaiserkram-create-trader">
    <div class="form-group"><label>${escapeHtml(loc('kaiserkram.trader.create.name', 'Name'))}</label>
      <input type="text" name="name" value="${escapeHtml(loc('kaiserkram.trader.sheet.newTrader', 'Trader'))}" autofocus /></div>
    <div class="form-group"><label>${escapeHtml(loc('kaiserkram.trader.create.haggle', 'Haggle'))}</label>
      <input type="number" name="haggle" min="0" max="120" step="1" value="40" /></div>
    <div class="form-group"><label>${escapeHtml(loc('kaiserkram.trader.create.purse', 'Starting coins'))}</label>
      <input type="text" name="purse" value="10 gc" placeholder="10 gc 5 ss" /></div>
    <p class="hint">${escapeHtml(
      loc(
        'kaiserkram.trader.create.hint',
        'Haggle is the skill total the trader rolls against. It gets every basic skill; the coins are what it can pay players for their goods.',
      ),
    )}</p>
  </div>`;
  const values = (await dialogV2().wait({
    window: { title: loc('kaiserkram.trader.sheet.createTrader', 'Create Trader'), icon: 'fa-solid fa-store' },
    content,
    rejectClose: false,
    buttons: [
      {
        action: 'create',
        label: loc('kaiserkram.trader.create.button', 'Create'),
        icon: 'fa-solid fa-plus',
        default: true,
        callback: (_event: unknown, button: { form: HTMLFormElement }) => {
          const field = (n: string) => (button.form.elements.namedItem(n) as HTMLInputElement | null)?.value ?? '';
          return { name: field('name').trim(), haggle: Number(field('haggle')), purse: field('purse') };
        },
      },
      { action: 'cancel', label: loc('kaiserkram.trader.common.cancel', 'Cancel') },
    ],
  })) as { name: string; haggle: number; purse: string } | string | null;
  if (!values || typeof values !== 'object') return null;
  const purse = values.purse.trim() ? parsePrice(values.purse) : 0;
  if (purse === null) {
    notify().warn(fmt('kaiserkram.trader.create.badPurse', 'Could not read "{text}" as coins; the trader starts with none.', { text: values.purse }));
  }
  return createTrader(values.name ? { name: values.name } : {}, {
    haggle: Number.isFinite(values.haggle) ? Math.max(0, values.haggle) : undefined,
    purseBP: purse ?? 0,
  });
}

/** GM: create a new NPC that is a trader, with every basic skill. */
export async function createTrader(
  data: Record<string, unknown> = {},
  options: { haggle?: number; purseBP?: number } = {},
): Promise<WfrpActor | null> {
  const cls = (CONFIG as unknown as {
    Actor: { documentClass: { create(d: unknown, o?: Record<string, unknown>): Promise<unknown> } };
  }).Actor.documentClass;
  // The skills go in with the actor: WFRP4e asks "Add basic skills?" when an NPC is created
  // without items, unless told to skip that.
  const skills = await basicSkills().catch((err) => {
    console.error('[kaiserkram] trader: reading the basic skills failed', err);
    return [] as ItemData[];
  });
  const actor = (await cls.create(
    foundry.utils.mergeObject(
      {
        name: loc('kaiserkram.trader.sheet.newTrader', 'Trader'),
        type: 'npc',
        img: DEFAULT_TRADER_IMAGE,
        prototypeToken: { texture: { src: DEFAULT_TRADER_IMAGE } },
        // Prices are set on the trader itself, so changing the defaults later leaves it alone.
        flags: {
          [MODULE_ID]: expandObject({
            [FLAGS.IS_TRADER]: true,
            [`${FLAGS.CONFIG}.markup`]: getNumber(SETTINGS.DEFAULT_MARKUP),
            [`${FLAGS.CONFIG}.sellRate`]: getNumber(SETTINGS.DEFAULT_SELL_RATE),
          }),
        },
        items: skills.map(withoutId),
      },
      data,
    ),
    { skipItems: true },
  )) as WfrpActor | null;
  if (!actor) return null;
  try {
    await ensureBasicSkills(actor);
    if (options.haggle !== undefined) await setHaggle(actor, options.haggle);
    if (options.purseBP) {
      const before = purseOf(actor);
      await applyPurse(actor, before, planCredit(before, options.purseBP));
    }
  } catch (err) {
    console.error('[kaiserkram] trader: setting up the new trader failed', err);
  }
  openShop(actor, 'manage');
  return actor;
}

async function setTrader(actor: WfrpActor, on: boolean): Promise<void> {
  if (on) {
    await actor.setFlag(MODULE_ID, FLAGS.IS_TRADER, true);
    await ensureBasicSkills(actor).catch((err) => console.error('[kaiserkram] trader: adding basic skills failed', err));
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
      headerButton(createClass, 'fa-plus', loc('kaiserkram.trader.sheet.createTrader', 'Create Trader'), () => void promptCreateTrader()),
    );
  }
}

function actorFromRow(li: HTMLElement): WfrpActor | undefined {
  // The clicked element may be a child of the entry; look upward for the id carrier.
  const entry = li.closest<HTMLElement>('[data-entry-id], [data-document-id]') ?? li;
  const id = entry.dataset.entryId ?? entry.dataset.documentId;
  return id ? g().actors.get(id) : undefined;
}

function addActorContextOptions(_app: unknown, options: Record<string, unknown>[]): void {
  options.push(
    contextEntry({
      label: loc('kaiserkram.trader.context.openShop', 'Open Shop'),
      icon: '<i class="fa-solid fa-store"></i>',
      visible: (li) => {
        const a = actorFromRow(li);
        return !!a && isTrader(a) && (g().user.isGM || traderConfig(a).open);
      },
      onClick: (li) => {
        const a = actorFromRow(li);
        if (a) openShop(a);
      },
    }),
    contextEntry({
      label: loc('kaiserkram.trader.context.makeTrader', 'Make Trader'),
      icon: '<i class="fa-solid fa-scale-balanced"></i>',
      visible: (li) => {
        const a = actorFromRow(li);
        return g().user.isGM && !!a && a.type === 'npc' && !isTrader(a);
      },
      onClick: (li) => {
        const a = actorFromRow(li);
        if (a) void setTrader(a, true);
      },
    }),
    contextEntry({
      label: loc('kaiserkram.trader.context.stopTrader', 'Stop Being a Trader'),
      icon: '<i class="fa-solid fa-ban"></i>',
      visible: (li) => {
        const a = actorFromRow(li);
        return g().user.isGM && !!a && isTrader(a);
      },
      onClick: (li) => {
        const a = actorFromRow(li);
        if (a) void setTrader(a, false);
      },
    }),
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

function enterOrSayClosed(actor: WfrpActor): void {
  if (traderConfig(actor).open) openShop(actor);
  else notify().info(fmt('kaiserkram.trader.notifications.closed', "{trader} isn't trading right now.", { trader: actor.name }));
}

type TokenProto = {
  _canView?(user: unknown, event: unknown): boolean;
  _onClickLeft2?(event: unknown): unknown;
  actor?: WfrpActor | null;
  document?: { hidden?: boolean };
} & Record<symbol, unknown>;
const PATCHED = Symbol('kaiserkramTraderDoubleClick');

/**
 * A player double-clicking a trader's token enters the shop, or is told it's closed. Foundry
 * only passes a double-click on for tokens the player may view, and a closed shop takes that
 * away, so both checks are patched on the token class in use before any token is drawn (each
 * token's mouse handler keeps the functions it was made with).
 */
function routeTraderDoubleClick(): void {
  const proto = (CONFIG as unknown as { Token?: { objectClass?: { prototype: TokenProto } } }).Token?.objectClass?.prototype;
  if (!proto || Object.hasOwn(proto, PATCHED) || typeof proto._onClickLeft2 !== 'function' || typeof proto._canView !== 'function') return;
  // Only tokens the player may see at all: a hidden trader stays hidden.
  const forPlayer = (token: TokenProto) =>
    !g().user.isGM && !!token.actor && !token.document?.hidden && isTrader(token.actor);
  const canView = proto._canView;
  proto._canView = function (this: TokenProto, user: unknown, event: unknown) {
    return forPlayer(this) || canView.call(this, user, event);
  };
  const clickLeft2 = proto._onClickLeft2;
  proto._onClickLeft2 = function (this: TokenProto, event: unknown) {
    if (forPlayer(this)) return enterOrSayClosed(this.actor!);
    return clickLeft2.call(this, event);
  };
  proto[PATCHED] = true;
}

/** Players who open a trader's actor sheet (sidebar click, token double-click) get the shop instead. */
function redirectSheet(app: unknown): void {
  if (g().user.isGM) return;
  const a = app as { document?: WfrpActor; actor?: WfrpActor; object?: WfrpActor; close(): unknown };
  const actor = a.document ?? a.actor ?? a.object;
  if (!actor || (actor as { documentName?: string }).documentName !== 'Actor' || !isTrader(actor)) return;
  void a.close();
  enterOrSayClosed(actor);
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
  on('setup', routeTraderDoubleClick);
  on('canvasInit', routeTraderDoubleClick);
  on('renderActorSheetV2', redirectSheet);
  on('renderActorSheet', redirectSheet);
  on('renderChatMessageHTML', bindChatButtons);
  onShowShop((uuid) => {
    void resolveActor(uuid).then((trader) => {
      if (trader && isTrader(trader)) openShop(trader);
    });
  });
}
