import { MODULE_ID } from '../../core/constants.js';
import { dialogV2, escapeHtml, postChat, renderTemplate, resolveDocument, speakerFor } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { CARD_CLASS, FLAGS, TEMPLATES } from './constants.js';
import { g, type WfrpActor, type WfrpItem } from './wfrp.js';
import { canHaggle, resetHaggling, startHaggle } from './haggle.js';
import { bpToPrice, formatBP, parsePrice, purseOf, purseTotal } from './money.js';
import { getBool, SETTINGS } from './settings.js';
import { requestGM, showToPlayers } from './socket.js';
import {
  bookPriceBP,
  buyQuote,
  haggleState,
  isForSale,
  isInfinite,
  isTradeable,
  priceOverrideBP,
  saveHaggleState,
  sellQuote,
  stockOf,
  stockQuantity,
  traderConfig,
  type TraderConfig,
} from './trader.js';
import { ACTIONS } from './transactions.js';
import { loadCatalog } from './catalog.js';

/** The slice of ApplicationV2 this window relies on. */
type AppInstance = {
  element: HTMLElement;
  rendered: boolean;
  render(options?: unknown): Promise<unknown>;
  close(options?: unknown): Promise<unknown>;
  bringToFront?(): void;
  _prepareContext(options: unknown): Promise<Record<string, unknown>>;
  _onRender(context: unknown, options: unknown): Promise<void>;
};
type AppConstructor = new (options?: Record<string, unknown>) => AppInstance;

function appBase(): AppConstructor {
  const api = foundry.applications.api as unknown as {
    HandlebarsApplicationMixin(c: unknown): AppConstructor;
    ApplicationV2: unknown;
  };
  return api.HandlebarsApplicationMixin(api.ApplicationV2);
}

const OWNERSHIP = { NONE: 0, LIMITED: 1 } as const;

export type ShopTab = 'buy' | 'sell' | 'manage';

type ActionFn = (this: TraderShop, event: Event, target: HTMLElement) => unknown;

function notify(kind: 'info' | 'warn', message: string): void {
  (ui.notifications as unknown as Record<string, (m: string) => void>)[kind](message);
}

function dataId(target: HTMLElement): string {
  return target.closest<HTMLElement>('[data-item-id]')?.dataset.itemId ?? '';
}

async function enrich(html: string): Promise<string> {
  const editor = (foundry.applications.ux as unknown as {
    TextEditor: { implementation: { enrichHTML(s: string, o?: Record<string, unknown>): Promise<string> } };
  }).TextEditor.implementation;
  return editor.enrichHTML(html ?? '', { secrets: false });
}

/** Ask how many to buy/sell; resolves to null when cancelled. Skips the prompt when max is 1. */
async function askQuantity(title: string, max: number, unitLabel: string): Promise<number | null> {
  if (max <= 1) return 1;
  const content = await renderTemplate(TEMPLATES.QUANTITY_DIALOG, { max, unit: unitLabel });
  const qty = await dialogV2().wait({
    window: { title },
    content,
    rejectClose: false,
    buttons: [
      {
        action: 'ok',
        label: loc('kaiserkram.trader.common.confirm', 'Confirm'),
        default: true,
        callback: (_e: unknown, button: { form: HTMLFormElement }) =>
          Number((button.form.elements.namedItem('qty') as HTMLInputElement).value),
      },
      { action: 'cancel', label: loc('kaiserkram.trader.common.cancel', 'Cancel') },
    ],
  });
  if (typeof qty !== 'number' || !Number.isFinite(qty)) return null;
  return Math.min(max, Math.max(1, Math.floor(qty)));
}

/**
 * The shop window for one trader. It is a plain window, not the trader's actor sheet: the trader
 * stays an ordinary NPC with the system's own sheet, and players need no permission on it to shop.
 */
/** Window width for the Manage tab, with the trappings list beside the stock. */
const MANAGE_WIDTH = 1180;

export class TraderShop extends appBase() {
  /** One window per trader on this client. */
  static readonly open = new Map<string, TraderShop>();

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, 'trader-shop'],
    position: { width: 820, height: 760 },
    window: { resizable: true, icon: 'fa-solid fa-store' },
    actions: {
      // Not `tab`: ApplicationV2 handles that action itself (its own tab groups) before ours.
      shopTab: TraderShop.onTab as ActionFn,
      buy: TraderShop.onBuy as ActionFn,
      haggle: TraderShop.onHaggle as ActionFn,
      sell: TraderShop.onSell as ActionFn,
      openItem: TraderShop.onOpenItem as ActionFn,
      removeItem: TraderShop.onRemoveItem as ActionFn,
      toggleOpen: TraderShop.onToggleOpen as ActionFn,
      showPlayers: TraderShop.onShowPlayers as ActionFn,
      resetHaggle: TraderShop.onResetHaggle as ActionFn,
      forgiveCustomer: TraderShop.onForgiveCustomer as ActionFn,
      allowRetry: TraderShop.onAllowRetry as ActionFn,
      openActorSheet: TraderShop.onOpenActorSheet as ActionFn,
      addFromCatalog: TraderShop.onAddFromCatalog as ActionFn,
    },
  };

  static PARTS = {
    main: { template: TEMPLATES.SHOP, scrollable: ['.shop-body'] },
  };

  /** Who the viewer is buying/selling as. */
  customerId: string | null = null;

  tab: ShopTab = 'buy';

  /** What the Manage tab's trappings list is filtered to, across re-renders. */
  catalogQuery = '';
  private widened = false;
  catalogCategory = '';

  readonly trader: WfrpActor;

  constructor(trader: WfrpActor, options: Record<string, unknown> = {}) {
    super({ id: `${MODULE_ID}-shop-${trader.id}`, ...options });
    this.trader = trader;
  }

  get title(): string {
    return this.trader.name;
  }

  get isGM(): boolean {
    return g().user.isGM;
  }

  /** Characters this user may trade as: their own for players, every player character for the GM. */
  customerChoices(): WfrpActor[] {
    const actors = g().actors.contents.filter((a) => a.id !== this.trader.id);
    if (this.isGM) return actors.filter((a) => a.type === 'character' && a.hasPlayerOwner);
    return actors.filter((a) => a.isOwner && (a.type === 'character' || a.type === 'npc'));
  }

  customer(): WfrpActor | null {
    const choices = this.customerChoices();
    const preferred = this.customerId ?? g().user.character?.id ?? null;
    return choices.find((a) => a.id === preferred) ?? choices[0] ?? null;
  }

  async _prepareContext(options: unknown): Promise<Record<string, unknown>> {
    const context = await super._prepareContext(options);
    const trader = this.trader;
    if (!this.isGM && this.tab === 'manage') this.tab = 'buy';
    const config = traderConfig(trader);
    const customer = this.customer();
    const state = haggleState(trader);
    const isGM = this.isGM;
    const haggleOn = getBool(SETTINGS.HAGGLE_ENABLED);

    const stock = await Promise.all(
      (isGM ? trader.items.contents.filter(isTradeable) : stockOf(trader)).map(async (item) => {
        const quote = buyQuote(trader, item, customer?.id ?? null, state);
        const infinite = isInfinite(item);
        const qty = stockQuantity(item);
        const override = priceOverrideBP(item);
        return {
          id: item.id,
          name: item.name,
          img: item.img,
          type: item.type,
          qty,
          infinite,
          qtyLabel: infinite ? '∞' : String(qty),
          soldOut: !infinite && qty <= 0,
          forSale: isForSale(item),
          book: formatBP(bookPriceBP(item)),
          list: formatBP(quote.list),
          price: formatBP(quote.unit),
          deal: quote.deal,
          penalty: quote.penalty,
          adjusted: quote.unit !== quote.list,
          cheaper: quote.unit < quote.list,
          override: override === null ? '' : formatBP(override),
          canHaggle: Boolean(customer) && haggleOn && canHaggle(state, customer?.id ?? '', item.id),
          // Only the Buy tab shows descriptions; enriching is the slow part of a render.
          description: this.tab === 'buy' ? await enrich(item.system?.description?.value ?? '') : '',
        };
      }),
    );

    // With the purse enforced, the trader can only pay for what its coins cover.
    const traderCoins = purseTotal(purseOf(trader));
    const enforcePurse = getBool(SETTINGS.ENFORCE_PURSE);
    const sellable =
      customer && config.buysFromPlayers
        ? customer.items.contents.filter(isTradeable).map((item) => {
            const offer = sellQuote(trader, item, customer.id, state);
            return {
              id: item.id,
              name: item.name,
              img: item.img,
              qty: stockQuantity(item),
              offer: formatBP(offer),
              cantAfford: enforcePurse && offer > traderCoins,
            };
          })
        : [];

    const standings = Object.entries(state)
      .map(([actorId, s]) => ({
        actorId,
        name: g().actors.get(actorId)?.name ?? actorId,
        penalty: Number(s.penalty) || 0,
        deals: Object.entries(s.deals ?? {})
          .filter(([, pct]) => pct > 0)
          .map(([itemId, pct]) => `${trader.items.get(itemId)?.name ?? '?'} −${pct}%`)
          .join(', '),
        // Items haggled over without winning a deal: these block another try.
        tried: (s.tried ?? [])
          .filter((itemId) => !((s.deals ?? {})[itemId] > 0))
          .map((itemId) => trader.items.get(itemId)?.name ?? '?')
          .join(', '),
        canRetry: (s.tried ?? []).length > 0,
      }))
      .filter((s) => s.penalty > 0 || s.deals || s.tried);

    const customerStanding = customer ? state[customer.id] : undefined;
    const catalog = isGM && this.tab === 'manage' ? await loadCatalog() : null;

    const forSale = stock.filter((s) => s.forSale && (isGM || !s.soldOut));
    return {
      ...context,
      isGM,
      tab: this.tab,
      tabs: {
        buy: this.tab === 'buy',
        sell: this.tab === 'sell',
        manage: this.tab === 'manage',
      },
      canTrade: isGM || config.open,
      forSale,
      forSaleCount: forSale.length,
      trader: { name: trader.name, img: trader.img },
      config,
      purse: formatBP(purseTotal(purseOf(trader))),
      enforcePurse,
      customers: this.customerChoices().map((a) => ({ id: a.id, name: a.name, selected: a.id === customer?.id })),
      customer: customer
        ? {
            id: customer.id,
            name: customer.name,
            img: customer.img,
            purse: formatBP(purseTotal(purseOf(customer))),
            penalty: Number(customerStanding?.penalty) || 0,
          }
        : null,
      stock,
      hasStock: stock.length > 0,
      sellable,
      sellableCount: sellable.length,
      standings,
      haggleOn,
      catalog: catalog
        ? {
            source: catalog.source,
            count: catalog.categories.reduce((n, c) => n + c.items.length, 0),
            query: this.catalogQuery,
            categories: catalog.categories.map((c) => ({
              ...c,
              selected: c.name === this.catalogCategory,
              items: c.items.map((i) => ({ ...i, search: i.name.toLowerCase() })),
            })),
          }
        : null,
    };
  }

  async _onRender(context: unknown, options: unknown): Promise<void> {
    await super._onRender(context, options);
    TraderShop.open.set(this.trader.uuid, this);
    const root = this.element;

    root.querySelector<HTMLSelectElement>('select[data-customer-select]')?.addEventListener('change', (ev) => {
      this.customerId = (ev.currentTarget as HTMLSelectElement).value;
      void this.render();
    });

    if (this.isGM) {
      root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-config]').forEach((input) =>
        input.addEventListener('change', () => void this.saveConfig(input)),
      );
      root.querySelectorAll<HTMLInputElement>('[data-item-field]').forEach((input) =>
        input.addEventListener('change', () => void this.saveItemField(input)),
      );
    }

    if (this.isGM) this.bindCatalog(root);

    // The window frame outlives re-renders, so only bind the drop target once.
    const content = root.querySelector<HTMLElement>('.window-content') ?? root;
    if (!content.dataset.traderDrop) {
      content.dataset.traderDrop = '1';
      content.addEventListener('dragover', (ev) => ev.preventDefault());
      content.addEventListener('drop', (ev) => void this.onDropItem(ev));
    }
  }

  /** The trappings list: remember the filters, filter rows in place, drag rows out. */
  private bindCatalog(root: HTMLElement): void {
    const box = root.querySelector<HTMLElement>('.trader-catalog');
    if (!box) return;
    // The side panel needs room; widen the window once when the GM first sees it.
    const pos = (this as unknown as { position?: { width?: number }; setPosition?(p: Record<string, unknown>): void });
    if (!this.widened && (pos.position?.width ?? 0) < MANAGE_WIDTH) {
      this.widened = true;
      pos.setPosition?.({ width: Math.min(MANAGE_WIDTH, window.innerWidth - 40) });
    }
    const search = box.querySelector<HTMLInputElement>('input[data-catalog-search]');
    const category = box.querySelector<HTMLSelectElement>('select[data-catalog-category]');
    const apply = () => {
      const q = this.catalogQuery.trim().toLowerCase();
      box.querySelectorAll<HTMLElement>('.catalog-item').forEach((row) => {
        const match =
          (!q || (row.dataset.name ?? '').includes(q)) &&
          (!this.catalogCategory || row.dataset.category === this.catalogCategory);
        row.hidden = !match;
      });
      box.querySelectorAll<HTMLElement>('.catalog-group').forEach((group) => {
        group.hidden = !group.querySelector('.catalog-item:not([hidden])');
      });
    };
    search?.addEventListener('input', () => {
      this.catalogQuery = search.value;
      apply();
    });
    category?.addEventListener('change', () => {
      this.catalogCategory = category.value;
      apply();
    });
    box.querySelectorAll<HTMLElement>('.catalog-item[draggable="true"]').forEach((row) =>
      row.addEventListener('dragstart', (ev) => {
        ev.dataTransfer?.setData('text/plain', JSON.stringify({ type: 'Item', uuid: row.dataset.uuid }));
      }),
    );
    apply();
  }

  /** Add `item` to the stock: onto a same-named stack if there is one, else as a new item. */
  private async addToStock(item: WfrpItem): Promise<void> {
    const qty = Math.max(1, stockQuantity(item));
    const stack = this.trader.items.contents.find((i) => i.name === item.name && i.type === item.type && isTradeable(i));
    if (stack && stack.type !== 'container') {
      await stack.update({ 'system.quantity.value': stockQuantity(stack) + qty });
      return;
    }
    const copy = item.toObject();
    delete copy._id;
    if (copy.flags) delete copy.flags[MODULE_ID];
    await this.trader.createEmbeddedDocuments('Item', [copy]);
  }

  static async onAddFromCatalog(this: TraderShop, _event: Event, target: HTMLElement): Promise<void> {
    const uuid = target.closest<HTMLElement>('[data-uuid]')?.dataset.uuid;
    const item = uuid ? await resolveDocument<WfrpItem>(uuid) : null;
    if (item && isTradeable(item)) await this.addToStock(item);
  }

  async close(options?: unknown): Promise<unknown> {
    TraderShop.open.delete(this.trader.uuid);
    return super.close(options);
  }

  static onTab(this: TraderShop, _event: Event, target: HTMLElement): void {
    const tab = target.dataset.shopTab as ShopTab | undefined;
    if (!tab || tab === this.tab) return;
    this.tab = tab;
    void this.render();
  }

  private async saveConfig(input: HTMLInputElement | HTMLSelectElement): Promise<void> {
    const key = input.dataset.config as keyof TraderConfig;
    const value =
      input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : Math.max(0, Number(input.value) || 0);
    await this.trader.setFlag(MODULE_ID, `${FLAGS.CONFIG}.${key}`, value);
  }

  private async saveItemField(input: HTMLInputElement): Promise<void> {
    const item = this.trader.items.get(dataId(input));
    if (!item) return;
    switch (input.dataset.itemField) {
      case 'qty':
        await item.update({ 'system.quantity.value': Math.max(0, Math.floor(Number(input.value) || 0)) });
        break;
      case 'override': {
        const bp = parsePrice(input.value);
        if (bp === null) await item.unsetFlag(MODULE_ID, FLAGS.PRICE_OVERRIDE);
        else await item.setFlag(MODULE_ID, FLAGS.PRICE_OVERRIDE, bp);
        break;
      }
      case 'book': {
        const bp = parsePrice(input.value);
        if (bp !== null) await item.update({ 'system.price': bpToPrice(bp) });
        break;
      }
      case 'infinite':
        await item.setFlag(MODULE_ID, FLAGS.INFINITE, input.checked);
        break;
      case 'forSale':
        await item.setFlag(MODULE_ID, FLAGS.NOT_FOR_SALE, !input.checked);
        break;
    }
  }

  private async onDropItem(event: DragEvent): Promise<void> {
    const raw = event.dataTransfer?.getData('text/plain');
    if (!raw) return;
    let data: { type?: string; uuid?: string };
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (data.type !== 'Item' || !data.uuid) return;
    event.preventDefault();
    event.stopPropagation();

    const item = await resolveDocument<WfrpItem & { parent?: WfrpActor | null }>(data.uuid);
    if (!item || !isTradeable(item)) return;
    const owner = item.parent ?? null;
    if (owner?.id === this.trader.id) return;

    // The GM stocks the shop by dropping items (from anywhere, an actor included) unless they are
    // on the Sell tab selling as a character. For anyone else, an item from their own
    // inventory is an offer to sell it.
    if (this.isGM && (!owner || this.tab !== 'sell')) {
      await this.addToStock(item);
      return;
    }
    if (owner?.isOwner) {
      this.customerId = owner.id;
      this.tab = 'sell';
      await this.sellItem(owner, item);
    }
  }

  private async sellItem(customer: WfrpActor, item: WfrpItem): Promise<void> {
    const trader = this.trader;
    if (!traderConfig(trader).buysFromPlayers) {
      notify('warn', fmt('kaiserkram.trader.notifications.doesntBuy', '{trader} doesn\'t buy from customers.', {
        trader: trader.name,
      }));
      return;
    }
    const offer = sellQuote(trader, item, customer.id);
    const qty = await askQuantity(
      fmt('kaiserkram.trader.sell.title', 'Sell {item}', { item: item.name }),
      stockQuantity(item),
      formatBP(offer),
    );
    if (!qty) return;
    const ok = await dialogV2().confirm({
      window: { title: fmt('kaiserkram.trader.sell.title', 'Sell {item}', { item: item.name }) },
      content: `<p>${fmt('kaiserkram.trader.sell.confirm', 'Sell {qty}× {item} to {trader} for {total}?', {
        qty,
        item: item.name,
        trader: trader.name,
        total: formatBP(offer * qty),
      })}</p>`,
      rejectClose: false,
    });
    if (!ok) return;
    await requestGM(ACTIONS.SELL, {
      traderUuid: trader.uuid,
      customerUuid: customer.uuid,
      itemId: item.id,
      qty,
    });
  }

  static async onBuy(this: TraderShop, _event: Event, target: HTMLElement): Promise<void> {
    const item = this.trader.items.get(dataId(target));
    const customer = this.customer();
    if (!item || !customer) return;
    const quote = buyQuote(this.trader, item, customer.id);
    const max = isInfinite(item) ? 99 : stockQuantity(item);
    const qty = await askQuantity(
      fmt('kaiserkram.trader.buy.title', 'Buy {item}', { item: item.name }),
      max,
      formatBP(quote.unit),
    );
    if (!qty) return;
    await requestGM(ACTIONS.BUY, {
      traderUuid: this.trader.uuid,
      customerUuid: customer.uuid,
      itemId: item.id,
      qty,
    });
  }

  static async onHaggle(this: TraderShop, _event: Event, target: HTMLElement): Promise<void> {
    const item = this.trader.items.get(dataId(target));
    const customer = this.customer();
    if (item && customer) await startHaggle(this.trader, item, customer);
  }

  static async onSell(this: TraderShop, _event: Event, target: HTMLElement): Promise<void> {
    const customer = this.customer();
    const item = customer?.items.get(dataId(target));
    if (customer && item) await this.sellItem(customer, item);
  }

  static onOpenItem(this: TraderShop, _event: Event, target: HTMLElement): void {
    const item = this.trader.items.get(dataId(target)) as (WfrpItem & { sheet?: { render(o: unknown): void } }) | undefined;
    item?.sheet?.render({ force: true });
  }

  static async onRemoveItem(this: TraderShop, _event: Event, target: HTMLElement): Promise<void> {
    const item = this.trader.items.get(dataId(target));
    if (!item) return;
    const ok = await dialogV2().confirm({
      window: { title: loc('kaiserkram.trader.gm.removeItem', 'Remove from stock') },
      content: `<p>${fmt('kaiserkram.trader.gm.removeConfirm', 'Remove {item} from the trader\'s inventory?', { item: item.name })}</p>`,
      rejectClose: false,
    });
    if (ok) await this.trader.deleteEmbeddedDocuments('Item', [item.id]);
  }

  /** Opening the shop also lets players see the sheet (Limited ownership); closing takes that back. */
  static async onToggleOpen(this: TraderShop): Promise<void> {
    const trader = this.trader;
    const open = !traderConfig(trader).open;
    const current = Number(trader.ownership?.default ?? OWNERSHIP.NONE);
    const update: Record<string, unknown> = { [`flags.${MODULE_ID}.${FLAGS.CONFIG}.open`]: open };
    if (open && current < OWNERSHIP.LIMITED) update['ownership.default'] = OWNERSHIP.LIMITED;
    if (!open && current === OWNERSHIP.LIMITED) update['ownership.default'] = OWNERSHIP.NONE;
    await trader.update(update);
    if (open) await announceShop(trader);
    else await announceClosed(trader);
  }

  /** Open the shop if needed, then pop this sheet open on every connected player's screen. */
  static async onShowPlayers(this: TraderShop): Promise<void> {
    const trader = this.trader;
    if (!traderConfig(trader).open) await TraderShop.onToggleOpen.call(this);
    else await announceShop(trader);
    showToPlayers(trader.uuid);
    const players = g().users.contents.filter((u) => u.active && !u.isGM).length;
    notify(
      'info',
      players
        ? fmt('kaiserkram.trader.gm.shownToPlayers', 'Showed {trader} to {count} player(s).', { trader: trader.name, count: players })
        : loc('kaiserkram.trader.gm.noPlayers', 'No players are connected; they can open the shop from its token or the Actors sidebar.'),
    );
  }

  static async onResetHaggle(this: TraderShop): Promise<void> {
    const ok = await dialogV2().confirm({
      window: { title: loc('kaiserkram.trader.gm.resetHaggle', 'Reset haggling') },
      content: `<p>${loc('kaiserkram.trader.gm.resetConfirm', 'Forget every haggled deal and grudge this trader holds?')}</p>`,
      rejectClose: false,
    });
    if (ok) await resetHaggling(this.trader);
  }

  /** GM: let this character haggle again over everything they have tried; their deals stay. */
  static async onAllowRetry(this: TraderShop, _event: Event, target: HTMLElement): Promise<void> {
    const actorId = target.closest<HTMLElement>('[data-actor-id]')?.dataset.actorId;
    if (!actorId) return;
    const state = haggleState(this.trader);
    if (!state[actorId]) return;
    state[actorId] = { ...state[actorId], tried: [] };
    await saveHaggleState(this.trader, state);
  }

  static async onForgiveCustomer(this: TraderShop, _event: Event, target: HTMLElement): Promise<void> {
    const actorId = target.closest<HTMLElement>('[data-actor-id]')?.dataset.actorId;
    if (!actorId) return;
    const state = haggleState(this.trader);
    delete state[actorId];
    await saveHaggleState(this.trader, state);
  }

  /** GM: the trader's own sheet (the system's NPC sheet), for stats, money and anything else. */
  static onOpenActorSheet(this: TraderShop): void {
    this.trader.sheet?.render({ force: true });
  }
}

/** Open (or bring forward) the shop window for `trader` on this client. */
export function openShop(trader: WfrpActor, tab?: ShopTab): TraderShop {
  const shop = TraderShop.open.get(trader.uuid) ?? new TraderShop(trader);
  if (tab) shop.tab = tab;
  void shop.render({ force: true });
  shop.bringToFront?.();
  return shop;
}

/** Re-render every open shop, e.g. after the trader's or a customer's items or coins changed. */
export function refreshShops(): void {
  for (const shop of TraderShop.open.values()) if (shop.rendered) void shop.render();
}

/** Chat card telling everyone the shop is open, with a button that opens it. */
/** Chat card when the GM closes the shop. */
export async function announceClosed(trader: WfrpActor): Promise<void> {
  const text = fmt('kaiserkram.trader.chat.closed', '{trader} has closed for business.', { trader: escapeHtml(trader.name) });
  await postChat({ speaker: speakerFor(trader), content: `<div class="${CARD_CLASS}"><p>${text}</p></div>` });
}

export async function announceShop(trader: WfrpActor): Promise<void> {
  const text = fmt('kaiserkram.trader.chat.open', '{trader} is open for business.', { trader: escapeHtml(trader.name) });
  const button = escapeHtml(loc('kaiserkram.trader.chat.enter', 'Enter the shop'));
  await postChat({
    speaker: speakerFor(trader),
    content: `<div class="${CARD_CLASS}"><p>${text}</p><button type="button" data-${MODULE_ID}-shop="${escapeHtml(
      trader.uuid,
    )}"><i class="fa-solid fa-store"></i> ${button}</button></div>`,
  });
}
