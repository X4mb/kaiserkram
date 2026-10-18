import { escapeHtml, dialogV2, notify, on, toElement } from '../../../core/foundryApi.js';
import { loc } from '../../../core/i18n.js';
import type { ActorLike } from './items.js';
import { proposeTrade } from './client.js';

/**
 * Ways to start a trade: right-click another token (v14 token context menu), or the Trade button
 * on your own token's HUD, which trades with your target or a token standing nearby.
 */

type TokenLike = {
  id: string;
  name: string;
  visible?: boolean;
  actor?: ActorLike | null;
  document: { actor?: ActorLike | null; x: number; y: number; width: number; height: number };
};

const NEARBY_SQUARES = 3;

function placeables(): TokenLike[] {
  return (canvas as unknown as { tokens?: { placeables: TokenLike[]; controlled: TokenLike[] } } | null)?.tokens?.placeables ?? [];
}

function controlled(): TokenLike[] {
  return (canvas as unknown as { tokens?: { controlled: TokenLike[] } } | null)?.tokens?.controlled ?? [];
}

/** The actor you trade as: a token of yours you have selected, else your assigned character. */
function myTradingActor(exclude?: ActorLike | null): ActorLike | null {
  const selected = controlled().map((t) => t.actor).find((a) => a?.isOwner && a.id !== exclude?.id);
  if (selected) return selected;
  const character = (game.user as unknown as { character?: ActorLike | null }).character ?? null;
  return character && character.id !== exclude?.id ? character : null;
}

function startTrade(target: ActorLike | null | undefined): void {
  if (!target) return;
  const mine = myTradingActor(target);
  if (!mine) {
    notify().warn(loc('kaiserkram.party.trade.noActor', 'Select your token first (or have a character assigned) to trade.'));
    return;
  }
  proposeTrade(mine, target);
}

function center(t: TokenLike, size: number): { x: number; y: number } {
  return { x: t.document.x + (t.document.width * size) / 2, y: t.document.y + (t.document.height * size) / 2 };
}

/** Pick a partner for `token`: your target, the only token nearby, or one from a list. */
async function pickPartner(token: TokenLike): Promise<ActorLike | null> {
  const own = token.actor ?? null;
  const targets = [...((game.user as unknown as { targets?: Set<TokenLike> }).targets ?? [])];
  const targeted = targets.map((t) => t.actor).find((a) => a && a.id !== own?.id);
  if (targeted) return targeted;

  const size = (canvas as unknown as { dimensions?: { size: number } } | null)?.dimensions?.size ?? 100;
  const here = center(token, size);
  const seen = new Set<string>();
  const nearby = placeables().filter((t) => {
    const a = t.actor;
    if (!a || a.id === own?.id || t.visible === false || seen.has(a.id)) return false;
    const c = center(t, size);
    if (Math.hypot(c.x - here.x, c.y - here.y) / size > NEARBY_SQUARES) return false;
    seen.add(a.id);
    return true;
  });
  if (!nearby.length) {
    notify().info(loc('kaiserkram.party.trade.noneNearby', 'Nobody to trade with nearby. Target a token (T) and try again.'));
    return null;
  }
  if (nearby.length === 1) return nearby[0].actor ?? null;
  const id = await dialogV2().wait({
    window: { title: loc('kaiserkram.party.trade.pickTitle', 'Trade with whom?'), icon: 'fa-solid fa-handshake' },
    content: `<p>${escapeHtml(loc('kaiserkram.party.trade.pick', 'Choose who to offer a trade to.'))}</p>`,
    rejectClose: false,
    buttons: nearby.map((t) => ({ action: t.id, label: t.name })),
  });
  return nearby.find((t) => t.id === id)?.actor ?? null;
}

/** Your own token's HUD: a Trade button. */
function addHudButton(hud: unknown, html: unknown): void {
  const token = (hud as { object?: TokenLike }).object;
  if (!token?.actor?.isOwner) return;
  const root = toElement(html);
  const column = root?.querySelector('.col.left') ?? root?.querySelector('.col.right') ?? root;
  if (!column || column.querySelector('.kaiserkram-party-trade')) return;
  const button = document.createElement('div');
  button.classList.add('control-icon', 'kaiserkram-party-trade');
  button.setAttribute('role', 'button');
  button.title = loc('kaiserkram.party.trade.hud', 'Trade (with your target, or someone nearby)');
  button.innerHTML = '<i class="fa-solid fa-handshake"></i>';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void pickPartner(token).then((partner) => {
      if (partner) proposeTrade(token.actor!, partner);
    });
  });
  column.appendChild(button);
}

/** v14 token right-click menu: "Offer trade" on someone else's token. */
function addTokenMenuEntry(_app: unknown, options: Record<string, unknown>[]): void {
  const resolve = (target: unknown): ActorLike | null => {
    if (target instanceof HTMLElement) {
      const el = target.closest<HTMLElement>('[data-token-id], [data-object-id]') ?? target;
      const id = el.dataset.tokenId ?? el.dataset.objectId;
      return placeables().find((t) => t.id === id)?.actor ?? null;
    }
    const t = target as { actor?: ActorLike | null; document?: { actor?: ActorLike | null } } | null;
    return t?.actor ?? t?.document?.actor ?? null;
  };
  const label = loc('kaiserkram.party.trade.offer', 'Offer trade');
  const visible = (target: unknown) => {
    const actor = resolve(target);
    return !!actor && !!myTradingActor(actor) && !(actor.isOwner && !game.user?.isGM);
  };
  options.push({
    label,
    name: label,
    icon: '<i class="fa-solid fa-handshake"></i>',
    visible,
    condition: visible,
    onClick: (_event: unknown, target: unknown) => startTrade(resolve(target)),
    callback: (target: unknown) => startTrade(resolve(target)),
  });
}

export function registerTradeEntryPoints(): void {
  on('renderTokenHUD', addHudButton);
  on('getTokenPlaceableContextOptions', addTokenMenuEntry as (...args: never[]) => unknown);
}

