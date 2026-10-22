import { injectStylesheet } from './assets.js';
import { MODULE_PATH } from './constants.js';
import { escapeHtml, on } from './foundryApi.js';

/**
 * A right-click menu for tokens the player doesn't own. Foundry opens neither the Token HUD nor
 * a context menu on those, so the canvas right-click is caught here and the entries features
 * registered are shown. Nothing is bound until a feature adds an entry.
 */

export type MenuToken = {
  id: string;
  name: string;
  visible?: boolean;
  actor?: { id: string; uuid: string; name: string; isOwner: boolean } | null;
  bounds?: { contains(x: number, y: number): boolean };
};

export type TokenMenuEntry = {
  id: string;
  /** Font Awesome icon class, e.g. `fa-handshake`. */
  icon: string;
  label(token: MenuToken): string;
  visible(token: MenuToken): boolean;
  onClick(token: MenuToken): void;
};

const MENU_ID = 'kaiserkram-token-menu';
/** A right-drag pans the canvas; only a click (little movement) opens the menu. */
const CLICK_SLOP_PX = 6;
const groups: TokenMenuEntry[][] = [];
let rightDown: { x: number; y: number } | null = null;
let bound = false;

function placeables(): MenuToken[] {
  return (canvas as unknown as { tokens?: { placeables: MenuToken[] } } | null)?.tokens?.placeables ?? [];
}

/** Stops the open menu's outside-click listeners. */
let dismissListeners: AbortController | null = null;

export function removeTokenMenu(): void {
  dismissListeners?.abort();
  dismissListeners = null;
  document.getElementById(MENU_ID)?.remove();
}

function showMenu(clientX: number, clientY: number, token: MenuToken, entries: TokenMenuEntry[][]): void {
  removeTokenMenu();
  const menu = document.createElement('nav');
  menu.id = MENU_ID;
  menu.className = MENU_ID;
  menu.style.left = `${clientX}px`;
  menu.style.top = `${clientY}px`;
  entries.forEach((group, i) => {
    if (i > 0) menu.append(document.createElement('hr'));
    for (const entry of group) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.entry = entry.id;
      button.innerHTML = `<i class="fa-solid ${entry.icon}"></i> ${escapeHtml(entry.label(token))}`;
      button.addEventListener('click', () => {
        removeTokenMenu();
        entry.onClick(token);
      });
      menu.append(button);
    }
  });
  document.body.append(menu);
  // Any other click, or the wheel (zoom), closes it.
  const listeners = new AbortController();
  dismissListeners = listeners;
  const dismiss = (ev: Event) => {
    if (!menu.contains(ev.target as Node)) removeTokenMenu();
  };
  setTimeout(() => {
    if (listeners.signal.aborted) return;
    document.addEventListener('pointerdown', dismiss, { capture: true, signal: listeners.signal });
    document.addEventListener('wheel', dismiss, { capture: true, signal: listeners.signal });
  }, 0);
}

/** The visible token under the pointer that you don't own, if any. */
function foreignTokenAt(clientX: number, clientY: number): MenuToken | null {
  const c = canvas as unknown as {
    ready?: boolean;
    canvasCoordinatesFromClient?(p: { x: number; y: number }): { x: number; y: number };
  } | null;
  if (!c?.ready || !c.canvasCoordinatesFromClient) return null;
  const { x, y } = c.canvasCoordinatesFromClient({ x: clientX, y: clientY });
  const hits = placeables().filter(
    (t) => t.visible !== false && !!t.actor && !t.actor.isOwner && t.bounds?.contains(x, y),
  );
  return hits.at(-1) ?? null;
}

function onPointerDown(ev: PointerEvent): void {
  if (ev.button === 2) rightDown = { x: ev.clientX, y: ev.clientY };
}

function onContextMenu(ev: MouseEvent): void {
  const start = rightDown;
  rightDown = null;
  if (start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > CLICK_SLOP_PX) return;
  const token = foreignTokenAt(ev.clientX, ev.clientY);
  if (!token) return;
  const shown = groups.map((g) => g.filter((e) => e.visible(token))).filter((g) => g.length);
  if (shown.length) showMenu(ev.clientX, ev.clientY, token, shown);
}

/** The canvas element survives scene changes; bind once. */
function bindCanvas(): void {
  const view = (canvas as unknown as { app?: { view?: HTMLCanvasElement & { dataset: DOMStringMap } } } | null)?.app?.view;
  if (!view || view.dataset.kaiserkramTokenMenu) return;
  view.dataset.kaiserkramTokenMenu = '1';
  view.addEventListener('pointerdown', onPointerDown);
  view.addEventListener('contextmenu', onContextMenu);
}

/** Add a group of entries (shown together, divided from other features' groups). Call in `init`. */
export function addTokenMenuEntries(entries: TokenMenuEntry[]): void {
  groups.push(entries);
  if (bound) return;
  bound = true;
  injectStylesheet(`${MODULE_PATH}/styles/token-menu.css`);
  on('canvasReady', bindCanvas);
  on('canvasTearDown', removeTokenMenu);
}
