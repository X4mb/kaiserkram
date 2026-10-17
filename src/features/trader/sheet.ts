import { MODULE_ID } from '../../core/constants.js';
import { dialogV2, renderTemplate, resolveDocument } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { FLAGS, TEMPLATES } from './constants.js';
import { g, type WfrpActor, type WfrpItem } from './wfrp.js';
import { canHaggle, resetHaggling, startHaggle } from './haggle.js';
import { bpToPrice, formatBP, parsePrice, purseOf, purseTotal } from './money.js';
import { openRestockDialog, settlementChoices } from './restock.js';
import { getBool, SETTINGS } from './settings.js';
import { requestGM, showToPlayers } from './socket.js';
import {
  asSettlement,
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

/** The slice of ApplicationV2 / ActorSheetV2 this sheet relies on. */
type SheetInstance = {
  document: WfrpActor;
  element: HTMLElement;
  isEditable: boolean;
  rendered: boolean;
  render(options?: unknown): Promise<unknown>;
  close(options?: unknown): Promise<unknown>;
  _prepareContext(options: unknown): Promise<Record<string, unknown>>;
  _onRender(context: unknown, options: unknown): Promise<void>;
};
type SheetConstructor = new (options?: Record<string, unknown>) => SheetInstance;

function sheetBase(): SheetConstructor {
  const api = foundry.applications.api as unknown as { HandlebarsApplicationMixin(c: unknown): SheetConstructor };
  const sheets = foundry.applications.sheets as unknown as { ActorSheetV2: unknown };
  return api.HandlebarsApplicationMixin(sheets.ActorSheetV2);
}

const OWNERSHIP = { NONE: 0, LIMITED: 1 } as const;

type ActionFn = (this: TraderSheet, event: Event, target: HTMLElement) => unknown;

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

export class TraderSheet extends sheetBase() {
  /** Open trader sheets, so a customer's money/items changing can refresh them. */
  static readonly open = new Set<TraderSheet>();

  static DEFAULT_OPTIONS = {
    classes: [MODULE_ID, 'trader-sheet'],
    position: { width: 760, height: 720 },
    window: { resizable: true, icon: 'fa-solid fa-store' },
    form: { submitOnChange: false, closeOnSubmit: false },
    actions: {
      buy: TraderSheet.onBuy as ActionFn,
      haggle: TraderSheet.onHaggle as ActionFn,
      sell: TraderSheet.onSell as ActionFn,
      openItem: TraderSheet.onOpenItem as ActionFn,
      removeItem: TraderSheet.onRemoveItem as ActionFn,
      toggleOpen: TraderSheet.onToggleOpen as ActionFn,
      showPlayers: TraderSheet.onShowPlayers as ActionFn,
      restock: TraderSheet.onRestock as ActionFn,
      resetHaggle: TraderSheet.onResetHaggle as ActionFn,
      forgiveCustomer: TraderSheet.onForgiveCustomer as ActionFn,
      openActorSheet: TraderSheet.onOpenActorSheet as ActionFn,
    },
  };

  static PARTS = {
    main: { template: TEMPLATES.SHEET, scrollable: ['.trader-scroll'] },
  };

  /** Who the viewer is buying/selling as. */
  customerId: string | null = null;

  get trader(): WfrpActor {
    return this.document;
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
          description: await enrich(item.system?.description?.value ?? ''),
        };
      }),
    );

    const sellable =
      customer && config.buysFromPlayers
        ? customer.items.contents.filter(isTradeable).map((item) => ({
            id: item.id,
            name: item.name,
            img: item.img,
            qty: stockQuantity(item),
            offer: formatBP(sellQuote(trader, item, customer.id)),
          }))
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
      }))
      .filter((s) => s.penalty > 0 || s.deals);

    const customerStanding = customer ? state[customer.id] : undefined;

    return {
      ...context,
      isGM,
      trader: { name: trader.name, img: trader.img },
      config,
      purse: formatBP(purseTotal(purseOf(trader))),
      enforcePurse: getBool(SETTINGS.ENFORCE_PURSE),
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
      standings,
      haggleOn,
      settlements: settlementChoices(config.settlement),
    };
  }

  async _onRender(context: unknown, options: unknown): Promise<void> {
    await super._onRender(context, options);
    TraderSheet.open.add(this);
    const root = this.element;

    // DocumentSheetV2 disables every control on sheets the viewer can't edit, which is every
    // player on a trader. Shopping doesn't edit the trader, so turn the shop controls back on.
    root
      .querySelectorAll<HTMLButtonElement | HTMLSelectElement>(
        '.window-content button[data-action], .window-content select[data-customer-select]',
      )
      .forEach((el) => (el.disabled = false));

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

    // The window frame outlives re-renders, so only bind the drop target once.
    const content = root.querySelector<HTMLElement>('.window-content') ?? root;
    if (!content.dataset.traderDrop) {
      content.dataset.traderDrop = '1';
      content.addEventListener('dragover', (ev) => ev.preventDefault());
      content.addEventListener('drop', (ev) => void this.onDropItem(ev));
    }
  }

  async close(options?: unknown): Promise<unknown> {
    TraderSheet.open.delete(this);
    return super.close(options);
  }

  private async saveConfig(input: HTMLInputElement | HTMLSelectElement): Promise<void> {
    const key = input.dataset.config as keyof TraderConfig;
    const value =
      key === 'settlement'
        ? asSettlement(input.value)
        : input instanceof HTMLInputElement && input.type === 'checkbox'
          ? input.checked
          : Math.max(0, Number(input.value) || 0);
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

    if (owner) {
      // An item dragged out of a character's inventory is an offer to sell it.
      if (!owner.isOwner) return;
      this.customerId = owner.id;
      await this.sellItem(owner, item);
    } else if (this.isGM) {
      const copy = item.toObject();
      delete copy._id;
      await this.trader.createEmbeddedDocuments('Item', [copy]);
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

  static async onBuy(this: TraderSheet, _event: Event, target: HTMLElement): Promise<void> {
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

  static async onHaggle(this: TraderSheet, _event: Event, target: HTMLElement): Promise<void> {
    const item = this.trader.items.get(dataId(target));
    const customer = this.customer();
    if (item && customer) await startHaggle(this.trader, item, customer);
  }

  static async onSell(this: TraderSheet, _event: Event, target: HTMLElement): Promise<void> {
    const customer = this.customer();
    const item = customer?.items.get(dataId(target));
    if (customer && item) await this.sellItem(customer, item);
  }

  static onOpenItem(this: TraderSheet, _event: Event, target: HTMLElement): void {
    const item = this.trader.items.get(dataId(target)) as (WfrpItem & { sheet?: { render(o: unknown): void } }) | undefined;
    item?.sheet?.render({ force: true });
  }

  static async onRemoveItem(this: TraderSheet, _event: Event, target: HTMLElement): Promise<void> {
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
  static async onToggleOpen(this: TraderSheet): Promise<void> {
    const trader = this.trader;
    const open = !traderConfig(trader).open;
    const current = Number(trader.ownership?.default ?? OWNERSHIP.NONE);
    const update: Record<string, unknown> = { [`flags.${MODULE_ID}.${FLAGS.CONFIG}.open`]: open };
    if (open && current < OWNERSHIP.LIMITED) update['ownership.default'] = OWNERSHIP.LIMITED;
    if (!open && current === OWNERSHIP.LIMITED) update['ownership.default'] = OWNERSHIP.NONE;
    await trader.update(update);
  }

  /** Open the shop if needed, then pop this sheet open on every connected player's screen. */
  static async onShowPlayers(this: TraderSheet): Promise<void> {
    const trader = this.trader;
    if (!traderConfig(trader).open) await TraderSheet.onToggleOpen.call(this);
    showToPlayers(trader.uuid);
    const players = g().users.contents.filter((u) => u.active && !u.isGM).length;
    notify(
      'info',
      players
        ? fmt('kaiserkram.trader.gm.shownToPlayers', 'Showed {trader} to {count} player(s).', { trader: trader.name, count: players })
        : loc('kaiserkram.trader.gm.noPlayers', 'No players are connected; they can open the shop from its token or the Actors sidebar.'),
    );
  }

  static async onRestock(this: TraderSheet): Promise<void> {
    await openRestockDialog(this.trader);
  }

  static async onResetHaggle(this: TraderSheet): Promise<void> {
    const ok = await dialogV2().confirm({
      window: { title: loc('kaiserkram.trader.gm.resetHaggle', 'Reset haggling') },
      content: `<p>${loc('kaiserkram.trader.gm.resetConfirm', 'Forget every haggled deal and grudge this trader holds?')}</p>`,
      rejectClose: false,
    });
    if (ok) await resetHaggling(this.trader);
  }

  static async onForgiveCustomer(this: TraderSheet, _event: Event, target: HTMLElement): Promise<void> {
    const actorId = target.closest<HTMLElement>('[data-actor-id]')?.dataset.actorId;
    if (!actorId) return;
    const state = haggleState(this.trader);
    delete state[actorId];
    await saveHaggleState(this.trader, state);
  }

  /** GM: open the trader with the system's normal NPC sheet, for stats, money and anything else. */
  static onOpenActorSheet(this: TraderSheet): void {
    const classes = (CONFIG as unknown as {
      Actor: { sheetClasses: Record<string, Record<string, { id: string; cls: unknown; default?: boolean }>> };
    }).Actor.sheetClasses[this.trader.type] ?? {};
    const entries = Object.values(classes).filter((e) => !e.id.startsWith(`${MODULE_ID}.`));
    const entry = entries.find((e) => e.default) ?? entries[0];
    if (!entry) return;
    const Cls = entry.cls as new (arg: unknown) => { render(o: unknown): unknown };
    const isV2 = (Cls as unknown as { prototype: unknown }).prototype instanceof
      (foundry.applications.api as unknown as { ApplicationV2: new () => unknown }).ApplicationV2;
    const sheet = isV2 ? new Cls({ document: this.trader }) : new Cls(this.trader);
    sheet.render(isV2 ? { force: true } : true);
  }
}
