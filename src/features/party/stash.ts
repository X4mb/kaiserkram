import { MODULE_ID } from '../../core/constants.js';
import { activeGMId, escapeHtml, notify, toElement } from '../../core/foundryApi.js';
import { sendRequest } from './trade/client.js';
import { fmt, loc } from '../../core/i18n.js';
import { isPartyActor } from './inventory.js';
import { byCoinValue, isMoney, isTradeableItem, quantityOf, transferItem, type ActorLike, type ItemLike } from './trade/items.js';

/**
 * The party stash: the party marker's actor inventory beside one of your characters, to put
 * things in and take them out. Players own both actors, so moves happen right here.
 */

type Side = 'stash' | 'mine';

type AppInstance = {
  element: HTMLElement;
  rendered: boolean;
  render(options?: unknown): Promise<unknown>;
  close(options?: unknown): Promise<unknown>;
  bringToFront?(): void;
};
type AppCtor = new (options?: Record<string, unknown>) => AppInstance;
type StashWindow = AppInstance & { party: ActorLike; characterId: string | null };

const windows = new Map<string, StashWindow>();
let StashClass: (new (party: ActorLike) => StashWindow) | undefined;

/** Your characters that can use the stash: ones you own, the party itself excluded. */
function myCharacters(): ActorLike[] {
  const actors = (game.actors as unknown as { contents: (ActorLike & { type: string })[] }).contents;
  return actors.filter((a) => a.isOwner && !isPartyActor(a) && (game.user?.isGM ? a.hasPlayerOwner : true));
}

function characterOf(win: StashWindow): ActorLike | null {
  const choices = myCharacters();
  const preferred = win.characterId ?? (game.user as unknown as { character?: { id: string } | null }).character?.id ?? null;
  return choices.find((a) => a.id === preferred) ?? choices[0] ?? null;
}

function rows(actor: ActorLike | null, side: Side): { goods: string; money: string } {
  const items = (actor?.items.contents ?? []).filter((i) => isTradeableItem(i) && quantityOf(i) > 0);
  const label =
    side === 'stash' ? loc('kaiserkram.party.stash.take', 'Take') : loc('kaiserkram.party.stash.put', 'Put in');
  const icon = side === 'stash' ? 'fa-arrow-right' : 'fa-arrow-left';
  const row = (i: ItemLike, money: boolean) => {
    const qty = quantityOf(i);
    const amount =
      qty > 1
        ? `<input type="number" min="1" max="${qty}" step="1" value="${money ? qty : 1}" data-amount />`
        : '';
    return `<li class="kk-stash-item ${money ? 'coin' : ''}" draggable="true" data-item-id="${escapeHtml(i.id)}"
        data-uuid="${escapeHtml(i.uuid ?? '')}">
      <img src="${escapeHtml(i.img)}" alt="" />
      <span class="name">${escapeHtml(i.name)}</span>
      <span class="qty">${qty}</span>
      ${amount}
      <button type="button" data-action="move" data-side="${side}" data-tooltip="${escapeHtml(label)}"><i class="fa-solid ${icon}"></i></button>
    </li>`;
  };
  const byName = (a: ItemLike, b: ItemLike) => a.name.localeCompare(b.name);
  return {
    goods: items.filter((i) => !isMoney(i)).sort(byName).map((i) => row(i, false)).join(''),
    money: items.filter(isMoney).sort(byCoinValue).map((i) => row(i, true)).join(''),
  };
}

function column(win: StashWindow, side: Side): string {
  const actor = side === 'stash' ? win.party : characterOf(win);
  const { goods, money } = rows(actor, side);
  const empty = `<li class="empty">${escapeHtml(loc('kaiserkram.party.stash.empty', 'Nothing here.'))}</li>`;
  let header: string;
  if (side === 'stash') {
    header = `<h3>${escapeHtml(fmt('kaiserkram.party.stash.partyTitle', '{name} (party)', { name: win.party.name }))}</h3>`;
  } else {
    const choices = myCharacters();
    header = choices.length
      ? `<select data-character>${choices
          .map((a) => `<option value="${escapeHtml(a.id)}" ${a.id === actor?.id ? 'selected' : ''}>${escapeHtml(a.name)}</option>`)
          .join('')}</select>`
      : `<p class="hint">${escapeHtml(loc('kaiserkram.party.stash.noCharacter', 'You have no character to put things in or take them out with.'))}</p>`;
  }
  return `<section class="kk-stash-col" data-side="${side}">
    <header>${header}</header>
    <ul class="kk-stash-list">${goods || empty}</ul>
    ${money ? `<h4><i class="fa-solid fa-coins"></i> ${escapeHtml(loc('kaiserkram.party.trade.money', 'Money'))}</h4><ul class="kk-stash-list">${money}</ul>` : ''}
  </section>`;
}

function render(win: StashWindow): string {
  return `<div class="kk-stash">
    <div class="kk-stash-top">
      <p class="hint">${escapeHtml(
        loc('kaiserkram.party.stash.hint', 'Use the arrows to move an amount, or drag a whole stack to the other side.'),
      )}</p>
      <button type="button" data-action="sheet"><i class="fa-solid fa-user"></i> ${escapeHtml(
        loc('kaiserkram.party.stash.sheet', 'Party sheet'),
      )}</button>
    </div>
    <div class="kk-stash-cols">${column(win, 'stash')}${column(win, 'mine')}</div>
  </div>`;
}

/**
 * Move through the GM, one move at a time, so two players taking from the same stack can't both
 * take what's there. With no GM online, the move happens here.
 */
async function move(win: StashWindow, from: Side, itemId: string, qty?: number): Promise<void> {
  const source = from === 'stash' ? win.party : characterOf(win);
  const target = from === 'stash' ? characterOf(win) : win.party;
  const item = source?.items.get(itemId);
  if (!source || !target || !item) return;
  const have = quantityOf(item);
  const amount = Math.min(have, Math.max(1, Math.floor(qty ?? have)));
  if (activeGMId()) {
    sendRequest({ op: 'move', from: source.uuid, to: target.uuid, itemId, qty: amount });
    return;
  }
  await transferItem(item, amount, target);
  notify().info(
    fmt('kaiserkram.party.notifications.itemMoved', 'Moved {item} from {from} to {to}.', {
      item: amount > 1 ? `${amount}× ${item.name}` : item.name,
      from: source.name,
      to: target.name,
    }),
  );
}

function stashClass(): new (party: ActorLike) => StashWindow {
  if (StashClass) return StashClass;
  const Base = (foundry.applications.api as unknown as { ApplicationV2: AppCtor }).ApplicationV2;

  class PartyStash extends Base {
    party: ActorLike;
    characterId: string | null = null;

    static DEFAULT_OPTIONS = {
      classes: [`${MODULE_ID}-stash`],
      position: { width: 720, height: 'auto' },
      window: { icon: 'fa-solid fa-box-open', resizable: true },
      actions: { move: PartyStash.onMove, sheet: PartyStash.onSheet },
    };

    constructor(party: ActorLike) {
      super({ id: `${MODULE_ID}-stash-${party.id}` });
      this.party = party;
    }

    get title(): string {
      return fmt('kaiserkram.party.stash.title', 'Party stash: {name}', { name: this.party.name });
    }

    async _renderHTML(): Promise<string> {
      return render(this as unknown as StashWindow);
    }

    _replaceHTML(result: string, content: HTMLElement): void {
      content.innerHTML = result;
      const win = this as unknown as StashWindow;
      content.querySelector<HTMLSelectElement>('select[data-character]')?.addEventListener('change', (ev) => {
        win.characterId = (ev.currentTarget as HTMLSelectElement).value;
        void win.render();
      });
      content.querySelectorAll<HTMLElement>('.kk-stash-item[draggable="true"]').forEach((row) =>
        row.addEventListener('dragstart', (ev) => {
          const side = row.closest<HTMLElement>('.kk-stash-col')?.dataset.side;
          ev.dataTransfer?.setData(
            'text/plain',
            JSON.stringify({ type: 'Item', uuid: row.dataset.uuid, kaiserkramStash: { side, itemId: row.dataset.itemId } }),
          );
        }),
      );
      if (!content.dataset.stashDrop) {
        content.dataset.stashDrop = '1';
        content.addEventListener('dragover', (ev) => ev.preventDefault());
        content.addEventListener('drop', (ev) => void PartyStash.onDrop(win, ev));
      }
    }

    static async onMove(this: StashWindow, _event: Event, target: HTMLElement): Promise<void> {
      const row = target.closest<HTMLElement>('[data-item-id]');
      const side = target.dataset.side as Side | undefined;
      if (!row?.dataset.itemId || !side) return;
      const amount = row.querySelector<HTMLInputElement>('input[data-amount]');
      await move(this, side, row.dataset.itemId, amount ? Number(amount.value) : undefined);
    }

    static onSheet(this: StashWindow): void {
      void (this.party as ActorLike & { sheet?: { render(force: boolean): unknown } }).sheet?.render(true);
    }

    /** A whole stack dropped on the other column (from this window, or a sheet of the same actors). */
    static async onDrop(win: StashWindow, event: DragEvent): Promise<void> {
      const to = (event.target as HTMLElement | null)?.closest<HTMLElement>('.kk-stash-col')?.dataset.side as Side | undefined;
      if (!to) return;
      let data: { type?: string; uuid?: string; kaiserkramStash?: { side?: Side; itemId?: string } };
      try {
        data = JSON.parse(event.dataTransfer?.getData('text/plain') ?? '');
      } catch {
        return;
      }
      if (data.type !== 'Item') return;
      event.preventDefault();
      const from: Side = to === 'stash' ? 'mine' : 'stash';
      const source = from === 'stash' ? win.party : characterOf(win);
      const itemId =
        data.kaiserkramStash?.side === from
          ? data.kaiserkramStash.itemId
          : source?.items.contents.find((i) => i.uuid === data.uuid)?.id;
      if (itemId) await move(win, from, itemId);
    }

    async close(options?: unknown): Promise<unknown> {
      windows.delete(this.party.uuid);
      return super.close(options);
    }
  }

  StashClass = PartyStash as unknown as new (party: ActorLike) => StashWindow;
  return StashClass;
}

export function openStash(party: ActorLike): void {
  let win = windows.get(party.uuid);
  if (!win) {
    win = new (stashClass())(party);
    windows.set(party.uuid, win);
  }
  void win.render({ force: true });
  win.bringToFront?.();
}

/** Redraw stash windows showing one of the `changed` actors (the party, or the character beside it). */
export function refreshStashWindows(changed: Set<string>): void {
  for (const win of windows.values()) {
    if (win.rendered && (changed.has(win.party.uuid) || changed.has(characterOf(win)?.uuid ?? ''))) void win.render();
  }
}

/** Token HUD of a party marker: a Party stash button for everyone who owns it. */
export function addStashHudButton(hud: unknown, html: unknown): void {
  const actor = (hud as { object?: { actor?: ActorLike | null } }).object?.actor;
  if (!actor || !isPartyActor(actor) || !actor.isOwner) return;
  const root = toElement(html);
  const column = root?.querySelector('.col.left') ?? root?.querySelector('.col.right') ?? root;
  if (!column || column.querySelector(`.${MODULE_ID}-party-stash`)) return;
  const button = document.createElement('div');
  button.classList.add('control-icon', `${MODULE_ID}-party-stash`);
  button.setAttribute('role', 'button');
  button.title = loc('kaiserkram.party.stash.hud', 'Party stash');
  button.innerHTML = '<i class="fa-solid fa-box-open"></i>';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openStash(actor);
  });
  column.appendChild(button);
}

type TokenProto = { _onClickLeft2?(event: unknown): unknown; actor?: ActorLike | null } & Record<symbol, unknown>;
const PATCHED = Symbol('kaiserkramStashDoubleClick');

/**
 * A player double-clicking the party marker gets the stash rather than the actor sheet (the
 * stash window has a button for the sheet). GMs keep the sheet. Patched on the token class in
 * use (a system's own Token subclass included) before any token is drawn.
 */
export function routeMarkerDoubleClick(): void {
  const proto = (CONFIG as unknown as { Token?: { objectClass?: { prototype: TokenProto } } }).Token?.objectClass?.prototype;
  if (!proto || Object.hasOwn(proto, PATCHED) || typeof proto._onClickLeft2 !== 'function') return;
  const original = proto._onClickLeft2;
  proto._onClickLeft2 = function (this: TokenProto, event: unknown) {
    const actor = this.actor;
    if (!game.user?.isGM && actor && actor.isOwner && isPartyActor(actor)) {
      openStash(actor);
      return;
    }
    return original.call(this, event);
  };
  proto[PATCHED] = true;
}
