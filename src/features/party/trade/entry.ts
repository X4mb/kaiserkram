import { escapeHtml, dialogV2, notify, on, toElement } from '../../../core/foundryApi.js';
import { fmt, loc } from '../../../core/i18n.js';
import { getTrading } from '../settings.js';
import { addTokenMenuEntries, type MenuToken, type TokenMenuEntry } from '../../../core/tokenMenu.js';
import type { ActorLike } from './items.js';
import { giveItems, proposeTrade } from './client.js';

/**
 * Ways to start a trade:
 *  - right-click someone else's token: Foundry opens neither the Token HUD nor a context menu on
 *    tokens a player doesn't own, so these go in the shared token menu (core/tokenMenu.ts);
 *  - the Trade tool in the token controls, and the Trade button on your own token's HUD, which
 *    trade with your target or a token standing nearby;
 *  - the v14 token context menu, where a core build offers one.
 * Each also offers Give: a one-way handover the receiver doesn't have to accept.
 */

type Mode = 'trade' | 'give';

/** Start `mode` between your `from` and `to`. */
function act(mode: Mode, from: ActorLike, to: ActorLike): void {
  if (mode === 'give') void giveItems(from, to);
  else proposeTrade(from, to);
}

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

function startTrade(target: ActorLike | null | undefined, mode: Mode = 'trade'): void {
  if (!target) return;
  const mine = myTradingActor(target);
  if (!mine) {
    notify().warn(loc('kaiserkram.party.trade.noActor', 'Select your token first (or have a character assigned) to trade.'));
    return;
  }
  act(mode, mine, target);
}

function center(t: TokenLike, size: number): { x: number; y: number } {
  return { x: t.document.x + (t.document.width * size) / 2, y: t.document.y + (t.document.height * size) / 2 };
}

/** Pick a partner for `token`: your target, the only token nearby, or one from a list. */
async function pickPartner(token: TokenLike, mode: Mode = 'trade'): Promise<ActorLike | null> {
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
  const give = mode === 'give';
  const id = await dialogV2().wait({
    window: {
      title: give
        ? loc('kaiserkram.party.give.pickTitle', 'Give to whom?')
        : loc('kaiserkram.party.trade.pickTitle', 'Trade with whom?'),
      icon: give ? 'fa-solid fa-gift' : 'fa-solid fa-handshake',
    },
    content: `<p>${escapeHtml(
      give
        ? loc('kaiserkram.party.give.pick', 'Choose who to give something to.')
        : loc('kaiserkram.party.trade.pick', 'Choose who to offer a trade to.'),
    )}</p>`,
    rejectClose: false,
    buttons: nearby.map((t) => ({ action: t.id, label: t.name })),
  });
  return nearby.find((t) => t.id === id)?.actor ?? null;
}

const HUD_BUTTONS: { mode: Mode; cls: string; icon: string; title: () => string }[] = [
  {
    mode: 'trade',
    cls: 'kaiserkram-party-trade',
    icon: 'fa-handshake',
    title: () => loc('kaiserkram.party.trade.hud', 'Trade (with your target, or someone nearby)'),
  },
  {
    mode: 'give',
    cls: 'kaiserkram-party-give',
    icon: 'fa-gift',
    title: () => loc('kaiserkram.party.give.hud', 'Give (to your target, or someone nearby)'),
  },
];

/** Your own token's HUD: Trade and Give buttons. */
function addHudButton(hud: unknown, html: unknown): void {
  const token = (hud as { object?: TokenLike }).object;
  if (!token?.actor?.isOwner) return;
  const root = toElement(html);
  const column = root?.querySelector('.col.left') ?? root?.querySelector('.col.right') ?? root;
  if (!column) return;
  for (const { mode, cls, icon, title } of HUD_BUTTONS) {
    if (column.querySelector(`.${cls}`)) continue;
    const button = document.createElement('div');
    button.classList.add('control-icon', cls);
    button.setAttribute('role', 'button');
    button.title = title();
    button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void pickPartner(token, mode).then((partner) => {
        if (partner) act(mode, token.actor!, partner);
      });
    });
    column.appendChild(button);
  }
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
  const visible = (target: unknown) => {
    const actor = resolve(target);
    return !!actor && !!myTradingActor(actor) && !(actor.isOwner && !game.user?.isGM);
  };
  const entries: [Mode, string, string][] = [
    ['trade', loc('kaiserkram.party.trade.offer', 'Offer trade'), 'fa-handshake'],
    ['give', loc('kaiserkram.party.give.menu', 'Give something'), 'fa-gift'],
  ];
  for (const [mode, label, icon] of entries) {
    options.push({
      label,
      name: label,
      icon: `<i class="fa-solid ${icon}"></i>`,
      visible,
      condition: visible,
      onClick: (_event: unknown, target: unknown) => startTrade(resolve(target), mode),
      callback: (target: unknown) => startTrade(resolve(target), mode),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Right-click on a token you don't own (the shared token menu)

function tokenMenuEntries(): TokenMenuEntry[] {
  // Offered only while trading is on, and when you have a character to trade as.
  const can = (t: MenuToken) => getTrading() && !!t.actor && !!myTradingActor(t.actor as ActorLike);
  return [
    {
      id: 'trade',
      icon: 'fa-handshake',
      label: (t) => fmt('kaiserkram.party.trade.offerTo', 'Offer {name} a trade', { name: t.actor?.name ?? t.name }),
      visible: can,
      onClick: (t) => startTrade(t.actor as ActorLike, 'trade'),
    },
    {
      id: 'give',
      icon: 'fa-gift',
      label: (t) => fmt('kaiserkram.party.give.giveTo', 'Give {name} something', { name: t.actor?.name ?? t.name }),
      visible: can,
      onClick: (t) => startTrade(t.actor as ActorLike, 'give'),
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Trade tool in the token controls

/** Your token to trade from: the selected one, else your character's token on this scene. */
function myToken(): TokenLike | null {
  const selected = controlled().find((t) => t.actor?.isOwner);
  if (selected) return selected;
  const character = (game.user as unknown as { character?: ActorLike | null }).character;
  return character ? (placeables().find((t) => t.actor?.id === character.id) ?? null) : null;
}

function tradeFromToolbar(mode: Mode = 'trade'): void {
  const token = myToken();
  if (!token?.actor) {
    notify().warn(loc('kaiserkram.party.trade.noActor', 'Select your token first (or have a character assigned) to trade.'));
    return;
  }
  void pickPartner(token, mode).then((partner) => {
    if (partner) act(mode, token.actor!, partner);
  });
}

type Tool = Record<string, unknown>;
type Control = { name?: string; tools: Record<string, Tool> | Tool[] };

function addTradeTool(controls: Record<string, Control> | Control[]): void {
  if (!getTrading()) return;
  const tokens = Array.isArray(controls)
    ? controls.find((c) => c.name === 'token' || c.name === 'tokens')
    : (controls.tokens ?? controls.token);
  if (!tokens) return;
  const tools: [Mode, string, string, string][] = [
    ['trade', 'kaiserkramPartyTrade', loc('kaiserkram.party.trade.tool', 'Trade (with your target, or someone nearby)'), 'fa-handshake'],
    ['give', 'kaiserkramPartyGive', loc('kaiserkram.party.give.tool', 'Give (to your target, or someone nearby)'), 'fa-gift'],
  ];
  tools.forEach(([mode, name, title, icon], i) => {
    const tool: Tool = {
      name,
      title,
      icon: `fa-solid ${icon}`,
      order: 101 + i,
      button: true,
      visible: true,
      // v13+: onChange(event, active); older cores: onClick().
      onChange: () => tradeFromToolbar(mode),
    };
    if (Array.isArray(tokens.tools)) tokens.tools.push({ ...tool, onClick: () => tradeFromToolbar(mode) });
    else tokens.tools[name] = tool;
  });
}

export function registerTradeEntryPoints(): void {
  on('renderTokenHUD', addHudButton);
  on('getTokenPlaceableContextOptions', addTokenMenuEntry as (...args: never[]) => unknown);
  on('getSceneControlButtons', addTradeTool as (...args: never[]) => unknown);
  addTokenMenuEntries(tokenMenuEntries());
}

