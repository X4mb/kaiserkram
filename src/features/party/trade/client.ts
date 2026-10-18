import { MODULE_ID } from '../../../core/constants.js';
import { dialogV2, escapeHtml, notify } from '../../../core/foundryApi.js';
import { fmt, loc } from '../../../core/i18n.js';
import { emitSocket } from '../../../core/socket.js';
import { handleRequest, setBroadcaster } from './authority.js';
import { isTradeableItem, quantityOf, type ActorLike } from './items.js';
import { REQUEST_OPS, type CloseReason, type RequestBody, type TradeMessage, type TradeRequest, type TradeSession, type TradeUpdate } from './types.js';

type UserLike = { id: string; isGM: boolean; isSelf?: boolean };

function me(): UserLike {
  return game.user as unknown as UserLike;
}

function activeGM(): UserLike | null {
  return (game.users as unknown as { activeGM?: UserLike | null }).activeGM ?? null;
}

/** Client → GM. The active GM handles its own requests directly (sockets don't echo to the sender). */
export function sendRequest(msg: RequestBody): void {
  const full = { ...msg, kind: 'trade', userId: me().id } as TradeRequest;
  const gm = activeGM();
  if (!gm) {
    notify().warn(loc('kaiserkram.party.trade.noGM', 'A GM needs to be online to trade.'));
    return;
  }
  if (gm.isSelf) void handleRequest(full);
  else emitSocket('party', full);
}

/** GM → everyone, including this client. */
function broadcast(msg: TradeUpdate): void {
  emitSocket('party', msg);
  handleUpdate(msg);
}

export function onTradeMessage(raw: unknown): void {
  const msg = raw as TradeMessage | undefined;
  if (msg?.kind !== 'trade') return;
  if (REQUEST_OPS.has(msg.op)) {
    if (activeGM()?.isSelf) void handleRequest(msg as TradeRequest);
    return;
  }
  handleUpdate(msg as TradeUpdate);
}

export function initTradeClient(): void {
  setBroadcaster(broadcast);
}

/** Propose a trade between `from` (yours) and `to`. */
export function proposeTrade(from: ActorLike, to: ActorLike): void {
  sendRequest({ op: 'propose', from: from.uuid, to: to.uuid });
  notify().info(fmt('kaiserkram.party.trade.proposed', 'Asking {name} to trade…', { name: to.name }));
}

/**
 * Give `to` something from `from` (yours), no questions asked of the receiver: pick goods and
 * amounts in a dialog, and the GM hands them over at once.
 */
export async function giveItems(from: ActorLike, to: ActorLike): Promise<void> {
  const items = from.items.contents.filter((i) => isTradeableItem(i) && quantityOf(i) > 0);
  if (!items.length) {
    notify().warn(fmt('kaiserkram.party.give.empty', '{name} has nothing to give.', { name: from.name }));
    return;
  }
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const row = (i: (typeof items)[number]) => `<li class="kk-give-item ${isMoney(i) ? 'coin' : ''}" data-item-id="${escapeHtml(i.id)}">
      <img src="${escapeHtml(i.img)}" alt="" />
      <span class="name">${escapeHtml(i.name)}</span>
      <input type="number" name="${escapeHtml(i.id)}" min="0" max="${quantityOf(i)}" step="1" value="0" />
      <span class="max">/ ${quantityOf(i)}</span>
    </li>`;
  const goods = items.filter((i) => !isMoney(i)).sort(byName).map(row).join('');
  const money = items
    .filter(isMoney)
    .sort((a, b) => Number(b.system?.coinValue?.value ?? 0) - Number(a.system?.coinValue?.value ?? 0))
    .map(row)
    .join('');
  const content = `<div class="kk-give">
    <p class="hint">${escapeHtml(
      fmt('kaiserkram.party.give.hint', 'Set how much of each to give {name}. It changes hands at once.', { name: to.name }),
    )}</p>
    ${goods ? `<ul class="kk-give-list">${goods}</ul>` : ''}
    ${money ? `<h4><i class="fa-solid fa-coins"></i> ${escapeHtml(loc('kaiserkram.party.trade.money', 'Money'))}</h4><ul class="kk-give-list">${money}</ul>` : ''}
  </div>`;
  const chosen = await dialogV2().wait({
    window: {
      title: fmt('kaiserkram.party.give.title', 'Give to {name}', { name: to.name }),
      icon: 'fa-solid fa-gift',
    },
    position: { width: 420 },
    classes: [`${MODULE_ID}-give`],
    content,
    rejectClose: false,
    buttons: [
      {
        action: 'give',
        label: loc('kaiserkram.party.give.button', 'Give'),
        icon: 'fa-solid fa-gift',
        default: true,
        callback: (_event: Event, button: HTMLButtonElement) => {
          const result: Record<string, number> = {};
          button.form?.querySelectorAll<HTMLInputElement>('.kk-give-item input').forEach((input) => {
            const qty = Math.min(Number(input.getAttribute('max')) || 0, Math.max(0, Math.floor(Number(input.value) || 0)));
            if (qty > 0) result[input.name] = qty;
          });
          return result;
        },
      },
      { action: 'cancel', label: loc('kaiserkram.party.trade.cancel', 'Cancel'), icon: 'fa-solid fa-ban' },
    ],
  });
  if (!chosen || typeof chosen !== 'object' || !Object.keys(chosen).length) return;
  sendRequest({ op: 'give', from: from.uuid, to: to.uuid, items: chosen as Record<string, number> });
}

const CLOSE_TEXT: Record<CloseReason, [string, string]> = {
  declined: ['kaiserkram.party.trade.closed.declined', '{by} declined the trade.'],
  cancelled: ['kaiserkram.party.trade.closed.cancelled', '{by} cancelled the trade.'],
  done: ['kaiserkram.party.trade.closed.done', 'Trade complete.'],
  failed: ['kaiserkram.party.trade.closed.failed', 'The trade did not go through.'],
  timeout: ['kaiserkram.party.trade.closed.timeout', 'No answer to the trade offer.'],
  left: ['kaiserkram.party.trade.closed.left', '{by} left, so the trade was cancelled.'],
  unknown: ['kaiserkram.party.trade.closed.unknown', 'That trade is no longer open.'],
};

function handleUpdate(msg: TradeUpdate): void {
  const myId = me().id;
  if (msg.op === 'given') {
    if (!msg.users.includes(myId)) return;
    if (msg.failed) notify().warn(msg.text);
    else notify().info(msg.text);
    return;
  }
  if (msg.op === 'closed') {
    if (!msg.users.includes(myId)) return;
    const window = windows.get(msg.id);
    if (window) {
      window.closedByServer = true;
      void window.close();
    }
    const [key, fallback] = CLOSE_TEXT[msg.reason];
    const text = msg.message ?? fmt(key, fallback, { by: msg.by ?? '?' });
    if (msg.reason === 'done') notify().info(text);
    else notify().warn(text);
    return;
  }
  const session = msg.session;
  const mine = session.sides.findIndex((s) => s.userId === myId);
  if (mine < 0) return;
  if (msg.op === 'invite') {
    if (mine === 1) void answerInvite(session);
    return;
  }
  // Until the invitation is answered, only the side that asked has a window ("Waiting for …").
  // The partner sees just the invitation; their window opens once they accept.
  if (session.status === 'pending' && mine === 1) return;
  openTradeWindow(session, mine as 0 | 1);
}

async function answerInvite(session: TradeSession): Promise<void> {
  const [them, us] = session.sides;
  const accept = await dialogV2().confirm({
    window: { title: loc('kaiserkram.party.trade.inviteTitle', 'Trade offer'), icon: 'fa-solid fa-handshake' },
    content: `<p>${escapeHtml(
      fmt('kaiserkram.party.trade.invite', '{who} ({user}) wants to trade with {you}.', {
        who: them.actorName,
        user: them.userName,
        you: us.actorName,
      }),
    )}</p>`,
    rejectClose: false,
    modal: false,
  });
  sendRequest({ op: 'respond', id: session.id, accept: accept === true });
}

// ---------------------------------------------------------------------------------------------
// The trade window

type AppInstance = {
  element: HTMLElement;
  rendered: boolean;
  render(options?: unknown): Promise<unknown>;
  close(options?: unknown): Promise<unknown>;
  bringToFront?(): void;
};
type AppCtor = new (options?: Record<string, unknown>) => AppInstance;

type TradeWindow = AppInstance & { session: TradeSession; mine: 0 | 1; closedByServer: boolean };

const windows = new Map<string, TradeWindow>();
let TradeWindowClass: (new (session: TradeSession, mine: 0 | 1) => TradeWindow) | undefined;

function myActor(win: TradeWindow): ActorLike | null {
  const fromUuidSync = (foundry.utils as unknown as { fromUuidSync(u: string): unknown }).fromUuidSync;
  try {
    return fromUuidSync(win.session.sides[win.mine].actorUuid) as ActorLike | null;
  } catch {
    return null;
  }
}

function offerMap(win: TradeWindow): Record<string, number> {
  return Object.fromEntries(win.session.sides[win.mine].items.map((i) => [i.id, i.qty]));
}

function sendOffer(win: TradeWindow, items: Record<string, number>): void {
  sendRequest({ op: 'offer', id: win.session.id, items });
}

function renderSide(win: TradeWindow, index: 0 | 1): string {
  const side = win.session.sides[index];
  const isMine = index === win.mine;
  const title = isMine
    ? loc('kaiserkram.party.trade.youOffer', 'You offer')
    : fmt('kaiserkram.party.trade.theyOffer', '{name} offers', { name: side.actorName });
  const rows = side.items
    .map(
      (i) => `<li class="kk-trade-item" data-item-id="${escapeHtml(i.id)}">
        <img src="${escapeHtml(i.img)}" alt="" />
        <span class="name">${escapeHtml(i.name)}</span>
        ${
          isMine
            ? `<input type="number" min="1" max="${i.max}" step="1" value="${i.qty}" data-qty />
               <span class="max">/ ${i.max}</span>
               <button type="button" data-action="remove" data-tooltip="${escapeHtml(loc('kaiserkram.party.trade.remove', 'Take back'))}"><i class="fa-solid fa-xmark"></i></button>`
            : `<span class="qty">×${i.qty}</span>`
        }
      </li>`,
    )
    .join('');
  const status = side.accepted
    ? `<span class="kk-trade-accepted"><i class="fa-solid fa-check"></i> ${escapeHtml(loc('kaiserkram.party.trade.accepted', 'Accepted'))}</span>`
    : '';
  return `<section class="kk-trade-side ${isMine ? 'mine' : 'theirs'}">
    <header><img src="${escapeHtml(side.actorImg)}" alt="" /><div><h3>${escapeHtml(title)}</h3>
      <span class="hint">${escapeHtml(side.actorName)} · ${escapeHtml(side.userName)}</span></div>${status}</header>
    <ul class="kk-trade-list">${rows || `<li class="empty">${escapeHtml(loc('kaiserkram.party.trade.empty', 'Nothing yet.'))}</li>`}</ul>
  </section>`;
}

/** Coins are items of type `money` (WFRP4e); they get amount boxes instead of drag rows. */
function isMoney(item: { type: string }): boolean {
  return item.type === 'money';
}

/** Your inventory beside the offer: goods to drag (or click) in, and money to type an amount of. */
function renderInventory(win: TradeWindow): string {
  const offered = offerMap(win);
  const items = (myActor(win)?.items.contents ?? []).filter((i) => isTradeableItem(i) && quantityOf(i) > 0);
  const goods = items
    .filter((i) => !isMoney(i))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((i) => {
      const left = quantityOf(i) - (offered[i.id] ?? 0);
      return `<li class="kk-trade-item kk-trade-good ${left <= 0 ? 'all-offered' : ''}" draggable="true"
          data-item-id="${escapeHtml(i.id)}" data-uuid="${escapeHtml((i as { uuid?: string }).uuid ?? '')}"
          data-action="addOne" data-tooltip="${escapeHtml(loc('kaiserkram.party.trade.addOne', 'Click to add one, or drag into your offer'))}">
        <img src="${escapeHtml(i.img)}" alt="" />
        <span class="name">${escapeHtml(i.name)}</span>
        <span class="qty">${left}</span>
      </li>`;
    })
    .join('');
  const money = items
    .filter(isMoney)
    .sort((a, b) => Number(b.system?.coinValue?.value ?? 0) - Number(a.system?.coinValue?.value ?? 0))
    .map(
      (i) => `<li class="kk-trade-item kk-trade-coin" data-item-id="${escapeHtml(i.id)}">
        <img src="${escapeHtml(i.img)}" alt="" />
        <span class="name">${escapeHtml(i.name)}</span>
        <input type="number" min="0" max="${quantityOf(i)}" step="1" value="${offered[i.id] ?? 0}" data-coin />
        <span class="max">/ ${quantityOf(i)}</span>
      </li>`,
    )
    .join('');
  return `<section class="kk-trade-side kk-trade-inventory">
    <header><div><h3>${escapeHtml(loc('kaiserkram.party.trade.inventory', 'Your inventory'))}</h3>
      <span class="hint">${escapeHtml(loc('kaiserkram.party.trade.dropHint', 'Drag items into your offer, or click one to add it.'))}</span></div></header>
    <ul class="kk-trade-list kk-trade-goods">${goods || `<li class="empty">${escapeHtml(loc('kaiserkram.party.trade.noGoods', 'Nothing to trade.'))}</li>`}</ul>
    ${
      money
        ? `<h4 class="kk-trade-money-title"><i class="fa-solid fa-coins"></i> ${escapeHtml(loc('kaiserkram.party.trade.money', 'Money'))}</h4>
           <ul class="kk-trade-list kk-trade-money">${money}</ul>`
        : ''
    }
  </section>`;
}

function renderWindow(win: TradeWindow): string {
  const { session, mine } = win;
  const other = session.sides[mine === 0 ? 1 : 0];
  const footer =
    session.status === 'pending'
      ? `<p class="kk-trade-wait"><i class="fa-solid fa-hourglass-half"></i> ${escapeHtml(
          fmt('kaiserkram.party.trade.waiting', 'Waiting for {user} to answer…', { user: other.userName }),
        )}</p>
         <button type="button" data-action="cancel"><i class="fa-solid fa-ban"></i> ${escapeHtml(loc('kaiserkram.party.trade.cancel', 'Cancel'))}</button>`
      : `<p class="hint">${escapeHtml(
          loc('kaiserkram.party.trade.acceptHint', 'The trade happens once both sides accept. Any change resets both.'),
        )}</p>
         <button type="button" data-action="accept" class="${session.sides[mine].accepted ? 'active' : ''}">
           <i class="fa-solid fa-handshake"></i> ${escapeHtml(
             session.sides[mine].accepted
               ? loc('kaiserkram.party.trade.unaccept', 'Withdraw acceptance')
               : loc('kaiserkram.party.trade.accept', 'Accept trade'),
           )}</button>
         <button type="button" data-action="cancel"><i class="fa-solid fa-ban"></i> ${escapeHtml(loc('kaiserkram.party.trade.cancel', 'Cancel'))}</button>`;
  const inventory = session.status === 'open' ? renderInventory(win) : '';
  return `<div class="kk-trade">
    <div class="kk-trade-sides ${inventory ? 'with-inventory' : ''}">${inventory}${renderSide(win, mine)}${renderSide(win, mine === 0 ? 1 : 0)}</div>
    <footer class="kk-trade-footer">${footer}</footer>
  </div>`;
}

function tradeWindowClass(): new (session: TradeSession, mine: 0 | 1) => TradeWindow {
  if (TradeWindowClass) return TradeWindowClass;
  const Base = (foundry.applications.api as unknown as { ApplicationV2: AppCtor }).ApplicationV2;

  class TradeWindowApp extends Base {
    session: TradeSession;
    mine: 0 | 1;
    closedByServer = false;

    static DEFAULT_OPTIONS = {
      classes: [`${MODULE_ID}-trade`],
      position: { width: 900, height: 'auto' },
      window: { icon: 'fa-solid fa-handshake', resizable: true },
      actions: {
        addOne: TradeWindowApp.onAddOne,
        remove: TradeWindowApp.onRemove,
        accept: TradeWindowApp.onAccept,
        cancel: TradeWindowApp.onCancel,
      },
    };

    constructor(session: TradeSession, mine: 0 | 1) {
      super({ id: `${MODULE_ID}-trade-${session.id}` });
      this.session = session;
      this.mine = mine;
    }

    get title(): string {
      return fmt('kaiserkram.party.trade.title', 'Trade with {name}', {
        name: this.session.sides[this.mine === 0 ? 1 : 0].actorName,
      });
    }

    async _renderHTML(): Promise<string> {
      return renderWindow(this as unknown as TradeWindow);
    }

    _replaceHTML(result: string, content: HTMLElement): void {
      content.innerHTML = result;
      const win = this as unknown as TradeWindow;
      content.querySelectorAll<HTMLInputElement>('input[data-qty]').forEach((input) =>
        input.addEventListener('change', () => {
          const id = input.closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
          if (!id) return;
          sendOffer(win, { ...offerMap(win), [id]: Number(input.value) || 1 });
        }),
      );
      content.querySelectorAll<HTMLInputElement>('input[data-coin]').forEach((input) =>
        input.addEventListener('change', () => {
          const id = input.closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
          if (!id) return;
          const items = offerMap(win);
          const qty = Math.max(0, Math.floor(Number(input.value) || 0));
          if (qty > 0) items[id] = qty;
          else delete items[id];
          sendOffer(win, items);
        }),
      );
      // Rows are the browser's own drag sources; the drop below (or a character sheet) takes them.
      content.querySelectorAll<HTMLElement>('.kk-trade-good[draggable="true"]').forEach((row) =>
        row.addEventListener('dragstart', (ev) => {
          const uuid = row.dataset.uuid;
          if (uuid) ev.dataTransfer?.setData('text/plain', JSON.stringify({ type: 'Item', uuid }));
        }),
      );
      if (!content.dataset.tradeDrop) {
        content.dataset.tradeDrop = '1';
        content.addEventListener('dragover', (ev) => ev.preventDefault());
        content.addEventListener('drop', (ev) => TradeWindowApp.onDrop(win, ev));
      }
    }

    /** Click a good in your inventory: offer one more of it (up to what you have). */
    static onAddOne(this: TradeWindow, _event: Event, target: HTMLElement): void {
      const id = target.closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
      const item = id ? myActor(this)?.items.get(id) : undefined;
      if (!id || !item) return;
      const items = offerMap(this);
      items[id] = Math.min(quantityOf(item), (items[id] ?? 0) + 1);
      sendOffer(this, items);
    }

    static onRemove(this: TradeWindow, _event: Event, target: HTMLElement): void {
      const id = target.closest<HTMLElement>('[data-item-id]')?.dataset.itemId;
      if (!id) return;
      const items = offerMap(this);
      delete items[id];
      sendOffer(this, items);
    }

    static onAccept(this: TradeWindow): void {
      sendRequest({ op: 'accept', id: this.session.id, accepted: !this.session.sides[this.mine].accepted });
    }

    static onCancel(this: TradeWindow): void {
      void this.close();
    }

    static onDrop(win: TradeWindow, event: DragEvent): void {
      let data: { type?: string; uuid?: string };
      try {
        data = JSON.parse(event.dataTransfer?.getData('text/plain') ?? '');
      } catch {
        return;
      }
      if (data.type !== 'Item' || !data.uuid || win.session.status !== 'open') return;
      const actor = myActor(win);
      const item = actor?.items.contents.find((i) => (i as unknown as { uuid?: string }).uuid === data.uuid);
      if (!item || !isTradeableItem(item)) return;
      event.preventDefault();
      const items = offerMap(win);
      items[item.id] = Math.min(quantityOf(item), (items[item.id] ?? 0) + 1);
      sendOffer(win, items);
    }

    async close(options?: unknown): Promise<unknown> {
      windows.delete(this.session.id);
      // Closing the window yourself ends the trade for both sides.
      if (!this.closedByServer) sendRequest({ op: 'cancel', id: this.session.id });
      return super.close(options);
    }
  }

  TradeWindowClass = TradeWindowApp as unknown as new (session: TradeSession, mine: 0 | 1) => TradeWindow;
  return TradeWindowClass;
}

function openTradeWindow(session: TradeSession, mine: 0 | 1): void {
  let win = windows.get(session.id);
  if (!win) {
    const Cls = tradeWindowClass();
    win = new Cls(session, mine);
    windows.set(session.id, win);
  }
  win.session = session;
  win.mine = mine;
  void win.render({ force: true });
}

/** All trade windows this client has open (for refreshing when inventories change). */
export function refreshTradeWindows(): void {
  for (const win of windows.values()) if (win.rendered) void win.render();
}
