import { MODULE_PATH } from '../../core/constants.js';
import type { Feature } from '../../core/feature.js';
import { notify, on, toElement } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { addTokenMenuEntries, type MenuToken } from '../../core/tokenMenu.js';
import { defaultHolder, holderChoices, targetOf, type TokenLike } from './people.js';
import { openQuick, refreshQuickWindows, setTrackerOpener } from './quick.js';
import { changePoint } from './points.js';
import { registerGrudgeSettings } from './settings.js';
import { chanceOf, decide, relationTo, type HolderLike, type Kind, type TargetLike } from './store.js';
import { openTracker, refreshTracker } from './tracker.js';

/**
 * Grudges: one-sided favour and grudge points between characters and NPCs, with a decision
 * roll whose odds follow them. Right-click a token to change them: someone else's token shows
 * quick entries in the token menu; a token you own (every token, for the GM) gets a button on
 * its HUD. The Grudges tool in the token controls opens the full list.
 */

function asToken(t: MenuToken): TokenLike {
  return t as unknown as TokenLike;
}

/** One point from the token menu, confirmed with where things now stand. */
async function quickAdjust(holder: HolderLike, target: TargetLike, kind: Kind): Promise<void> {
  if (!(await changePoint(holder, target, kind, 1))) return;
  const rel = relationTo(holder, target.uuid);
  notify().info(
    fmt('kaiserkram.grudges.changed', '{holder} → {target}: {good} favour / {bad} grudge ({chance}%).', {
      holder: holder.name,
      target: target.name,
      good: rel?.good ?? 0,
      bad: rel?.bad ?? 0,
      chance: chanceOf(rel),
    }),
  );
}

/** Players' quick entries on other people's tokens, as their own character. */
function menuEntries() {
  const parties = (t: MenuToken) => {
    const target = targetOf(asToken(t));
    const holder = target ? defaultHolder(target) : null;
    return target && holder ? { target, holder } : null;
  };
  const name = (t: MenuToken) => targetOf(asToken(t))?.name ?? t.name;
  return [
    {
      id: 'grudge-good',
      icon: 'fa-thumbs-up',
      label: (t: MenuToken) => fmt('kaiserkram.grudges.menuFavour', 'Favour +1 for {name}', { name: name(t) }),
      visible: (t: MenuToken) => !!parties(t),
      onClick: (t: MenuToken) => {
        const p = parties(t);
        if (p) void quickAdjust(p.holder, p.target, 'good');
      },
    },
    {
      id: 'grudge-bad',
      icon: 'fa-thumbs-down',
      label: (t: MenuToken) => fmt('kaiserkram.grudges.menuGrudge', 'Grudge +1 against {name}', { name: name(t) }),
      visible: (t: MenuToken) => !!parties(t),
      onClick: (t: MenuToken) => {
        const p = parties(t);
        if (p) void quickAdjust(p.holder, p.target, 'bad');
      },
    },
    {
      id: 'grudge-decide',
      icon: 'fa-dice-d20',
      label: (t: MenuToken) => {
        const p = parties(t);
        const chance = p ? chanceOf(relationTo(p.holder, p.target.uuid)) : 50;
        return fmt('kaiserkram.grudges.menuDecide', 'Decide about {name} ({chance}%)', { name: name(t), chance });
      },
      visible: (t: MenuToken) => !!parties(t),
      onClick: (t: MenuToken) => {
        const p = parties(t);
        if (p) void decide(p.holder, p.target);
      },
    },
    {
      id: 'grudge-open',
      icon: 'fa-scale-unbalanced',
      label: (t: MenuToken) => fmt('kaiserkram.grudges.menuOpen', 'Feelings about {name}…', { name: name(t) }),
      visible: (t: MenuToken) => !!parties(t),
      onClick: (t: MenuToken) => {
        const target = targetOf(asToken(t));
        if (target) openQuick(target);
      },
    },
  ];
}

/** Token HUD (tokens you own; the GM owns all): a button opening the quick window. */
function addHudButton(hud: unknown, html: unknown): void {
  const token = (hud as { object?: TokenLike }).object;
  const target = token ? targetOf(token) : null;
  if (!target || !holderChoices(target).length) return;
  const root = toElement(html);
  const column = root?.querySelector('.col.right') ?? root?.querySelector('.col.left') ?? root;
  if (!column || column.querySelector('.kaiserkram-grudges')) return;
  const button = document.createElement('div');
  button.classList.add('control-icon', 'kaiserkram-grudges');
  button.setAttribute('role', 'button');
  button.title = loc('kaiserkram.grudges.hud', 'Grudges and favours');
  button.innerHTML = '<i class="fa-solid fa-scale-unbalanced"></i>';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    openQuick(target);
  });
  column.appendChild(button);
}

type Tool = Record<string, unknown>;
type Control = { name?: string; tools: Record<string, Tool> | Tool[] };

function addTool(controls: Record<string, Control> | Control[]): void {
  const tokens = Array.isArray(controls)
    ? controls.find((c) => c.name === 'token' || c.name === 'tokens')
    : (controls.tokens ?? controls.token);
  if (!tokens) return;
  const tool: Tool = {
    name: 'kaiserkramGrudges',
    title: loc('kaiserkram.grudges.tool', 'Grudges and favours'),
    icon: 'fa-solid fa-scale-unbalanced',
    order: 110,
    button: true,
    visible: true,
    // v13+: onChange(event, active); older cores: onClick().
    onChange: () => openTracker(),
  };
  if (Array.isArray(tokens.tools)) tokens.tools.push({ ...tool, onClick: () => openTracker() });
  else tokens.tools[tool.name as string] = tool;
}

export const grudges: Feature = {
  id: 'grudges',
  group: 'general',
  styles: [`${MODULE_PATH}/styles/grudges.css`],

  init() {
    registerGrudgeSettings(() => {
      refreshQuickWindows();
      refreshTracker();
    });
    setTrackerOpener(openTracker);
    addTokenMenuEntries(menuEntries());
    on('renderTokenHUD', addHudButton as (...args: never[]) => unknown);
    on('getSceneControlButtons', addTool as (...args: never[]) => unknown);
    // Feelings live on actors (or an unlinked token's actor): refresh open windows when they change.
    const refresh = foundry.utils.debounce(() => {
      refreshQuickWindows();
      refreshTracker();
    }, 50);
    for (const hook of ['updateActor', 'updateToken', 'updateActorDelta', 'canvasReady']) on(hook, refresh);
  },

  api() {
    return { openTracker, openQuick };
  },
};
