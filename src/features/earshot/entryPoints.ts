import { MODULE_ID } from '../../core/constants.js';
import { contextEntry, notify, on, toElement } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';
import { getDebug } from './settings.js';
import { openVoiceAssignDialogForActor } from './voiceAssignDialog.js';

/** GM ways into the Assign Voice dialog: Token HUD, token right-click menu, Actors sidebar menu, Token Config. */

const MARK = `data-${MODULE_ID}-earshot-assign-voice`;

/** Entry-point diagnostics, gated behind the client "Verbose diagnostics" setting (off by default). */
export function dlog(msg: string, ...rest: unknown[]): void {
  if (getDebug()) console.log(`[${MODULE_ID}] earshot: ${msg}`, ...rest);
}

function assignLabel(): string {
  return loc('kaiserkram.earshot.VOICE.assignVoice', 'Assign Voice');
}

const ICON = '<i class="fa-solid fa-microphone-lines"></i>';

/** v14 canvas-token right-click menu. The target may be the Token placeable or an element carrying its id. */
function addTokenMenuEntry(_app: unknown, options: Record<string, unknown>[]): void {
  if (!game.user?.isGM) return;
  dlog('getTokenPlaceableContextOptions fired');
  const resolveActor = (target: unknown): Actor | null => {
    if (target instanceof HTMLElement) {
      const el = target.closest<HTMLElement>('[data-token-id], [data-object-id], [data-entry-id]') ?? target;
      const id = el.dataset.tokenId ?? el.dataset.objectId ?? el.dataset.entryId;
      const tok = id ? canvas?.tokens?.get(id) : null;
      if (tok?.actor) return tok.actor;
    } else if (target && typeof target === 'object') {
      const t = target as { actor?: Actor | null; document?: { actor?: Actor | null } | null };
      if (t.actor) return t.actor;
      if (t.document?.actor) return t.document.actor;
    }
    const layer = canvas?.tokens as unknown as { hover?: Token | null; controlled: Token[] } | undefined;
    return layer?.hover?.actor ?? layer?.controlled[0]?.actor ?? null;
  };
  // Not via contextEntry: the target here is often the placeable, not an element.
  const open = (target: unknown): void => {
    const actor = resolveActor(target);
    if (actor) openVoiceAssignDialogForActor(actor);
    else notify().warn(loc('kaiserkram.earshot.VOICE.noActor', 'Within Earshot: could not find the actor for this entry.'));
  };
  options.push({
    label: assignLabel(),
    name: assignLabel(),
    icon: ICON,
    // Always visible for the GM: a failing resolver must not silently hide the entry.
    visible: () => true,
    condition: () => true,
    onClick: (_event: unknown, target: unknown) => open(target),
    callback: open,
  });
}

/** Core right-click on a token opens the Token HUD, so the HUD is the main on-board entry point. */
function addHudButton(app: unknown, html: unknown): void {
  if (!game.user?.isGM) return;
  const hud = app as { object?: Token | null; document?: TokenDocument | null };
  const root = toElement(html);
  const actor = hud.object?.actor ?? hud.document?.actor ?? null;
  dlog('renderTokenHUD fired', { hasRoot: !!root, hasActor: !!actor });
  if (!root || !actor || root.querySelector(`[${MARK}]`)) return;
  const col = root.querySelector('.col.right') ?? root.querySelector('.col.left') ?? root;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'control-icon';
  btn.setAttribute(MARK, '');
  btn.title = assignLabel();
  btn.innerHTML = ICON;
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openVoiceAssignDialogForActor(actor);
  });
  col.appendChild(btn);
}

/**
 * Token Config (placed token) and Prototype Token Config → Identity tab: an "Assign Voice" section.
 * The profile is saved on the world actor, so assigning here covers all tokens of that actor.
 */
function addTokenConfigSection(app: unknown, html: unknown): void {
  if (!game.user?.isGM) return;
  const a = app as {
    actor?: Actor | null;
    token?: { actor?: Actor | null; parent?: Actor | null } | null;
    document?: { actor?: Actor | null; parent?: Actor | null } | null;
  };
  const root = toElement(html);
  if (!root || root.querySelector(`[${MARK}]`)) return;
  // Placed token config: document.actor. Prototype config: the PrototypeToken's parent actor.
  const actor = a.actor ?? a.token?.actor ?? a.token?.parent ?? a.document?.actor ?? a.document?.parent ?? null;
  const tab = root.querySelector('.tab[data-tab="identity"]') ?? root.querySelector('[data-tab="identity"]');
  dlog('renderTokenConfig fired', { hasActor: !!actor, hasIdentityTab: !!tab });
  if (!actor) return;
  // No identity tab found (layout differs): fall back to the window content so it shows somewhere.
  const host = tab ?? root.querySelector('.window-content') ?? root;
  const fs = document.createElement('fieldset');
  fs.setAttribute(MARK, '');
  const legend = document.createElement('legend');
  legend.textContent = loc('kaiserkram.features.earshot.name', 'Within Earshot');
  const btn = document.createElement('button');
  btn.type = 'button'; // must not submit the token config form
  btn.innerHTML = `${ICON} ${assignLabel()}`;
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    openVoiceAssignDialogForActor(actor);
  });
  const hint = document.createElement('p');
  hint.className = 'hint';
  hint.textContent = loc(
    'kaiserkram.earshot.VOICE.assignHint',
    'The voice is saved on the actor and applies to all of its tokens.',
  );
  fs.append(legend, btn, hint);
  host.appendChild(fs);
}

/** Actors sidebar right-click. The profile lives on the world actor, so unlinked tokens inherit it. */
function addActorMenuEntry(_app: unknown, options: Record<string, unknown>[]): void {
  if (!game.user?.isGM) return;
  dlog('getActorContextOptions fired');
  options.push(
    contextEntry({
      label: assignLabel(),
      icon: ICON,
      onClick: (li) => {
        const entry = li.closest<HTMLElement>('[data-entry-id], [data-document-id], [data-actor-id]') ?? li;
        const id = entry.dataset.entryId ?? entry.dataset.documentId ?? entry.dataset.actorId;
        const actor = id ? game.actors?.get(id) : null;
        if (actor) openVoiceAssignDialogForActor(actor);
        else notify().warn(loc('kaiserkram.earshot.VOICE.noActor', 'Within Earshot: could not find the actor for this entry.'));
      },
    }),
  );
}

export function registerVoiceEntryPoints(): void {
  on('getTokenPlaceableContextOptions', addTokenMenuEntry as (...args: never[]) => unknown);
  on('renderTokenHUD', addHudButton);
  on('renderTokenConfig', addTokenConfigSection);
  on('renderPrototypeTokenConfig', addTokenConfigSection);
  on('getActorContextOptions', addActorMenuEntry as (...args: never[]) => unknown);
}
