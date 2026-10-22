import { MODULE_ID } from '../constants.js';
import { moduleById, notify, on, settings } from '../foundryApi.js';
import { fmt } from '../i18n.js';

/**
 * Workaround for Token Action HUD WFRP4e (v3.3.0): its container groups use the icon
 * `<i class="fas fa-box-open></i>`, which is missing a quote. Since TAH Core 2.1.2 renders group
 * icons, that unclosed attribute swallows the rest of the HUD and Foundry refuses to render it,
 * so the HUD vanishes for every actor carrying a container.
 *
 * Kaiserkram repairs such icons just before the HUD renders, but only while the module's own
 * source still has the bug. Once it doesn't, the repair stays off and the GM is told (once per
 * version of that module) that this workaround can be removed from Kaiserkram.
 *
 * Remove this file, and its call in main.ts, once the fix is released upstream.
 */

const TAH_WFRP = 'token-action-hud-wfrp4e';
const SOURCE = `modules/${TAH_WFRP}/modules/ActionHandler.mjs`;
const BUG = '<i class="fas fa-box-open></i>';
/** A one-tag icon whose class attribute never closes: `<i class="fas fa-x></i>`. */
const UNCLOSED_ICON = /^<i class="([^"<>]*)><\/i>$/;
const NOTIFIED_SETTING = 'compatTahContainerIconFixed';

/** Unknown until the source has been checked; repairing meanwhile is harmless. */
let repairing = true;
let repaired = 0;

function repairValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const match = UNCLOSED_ICON.exec(value);
  if (!match) return value;
  repaired += 1;
  return `<i class="${match[1]}"></i>`;
}

/** Walk the HUD's group tree and fix every icon field in place. */
function repairGroups(groups: unknown, seen = new Set<unknown>()): void {
  if (!groups || typeof groups !== 'object' || seen.has(groups)) return;
  seen.add(groups);
  if (Array.isArray(groups)) {
    for (const g of groups) repairGroups(g, seen);
    return;
  }
  const node = groups as Record<string, unknown>;
  for (const key of ['icon', 'icon1', 'icon2', 'icon3']) if (key in node) node[key] = repairValue(node[key]);
  if (node.icons && typeof node.icons === 'object') {
    const icons = node.icons as Record<string, unknown>;
    for (const k of Object.keys(icons)) icons[k] = repairValue(icons[k]);
  }
  if (node.groups && typeof node.groups === 'object') {
    const g = node.groups as Record<string, unknown>;
    repairGroups(g.lists, seen);
    repairGroups(g.tabs, seen);
    if (Array.isArray(node.groups)) repairGroups(node.groups, seen);
  }
  if (Array.isArray(node.actions)) repairGroups(node.actions, seen);
}

type HudPrototype = { _prepareContext(options: unknown): Promise<{ hud?: { groups?: unknown } }> } & Record<symbol, unknown>;
const PATCHED = Symbol('kaiserkramTahContainerIcon');

/** Wrap the HUD application's context, once the HUD exists. */
function patchHud(): void {
  const hud = (game as unknown as { tokenActionHud?: object }).tokenActionHud;
  const proto = hud ? (Object.getPrototypeOf(hud) as HudPrototype) : null;
  if (!proto || Object.hasOwn(proto, PATCHED) || typeof proto._prepareContext !== 'function') return;
  const original = proto._prepareContext;
  proto._prepareContext = async function (this: unknown, options: unknown) {
    const context = await original.call(this, options);
    if (repairing) {
      const before = repaired;
      repairGroups(context?.hud?.groups);
      if (repaired > before && before === 0) {
        console.info(`${MODULE_ID} | repaired Token Action HUD WFRP4e container icons (see core/compat/tahContainerIcon.ts)`);
      }
    }
    return context;
  };
  proto[PATCHED] = true;
}

/** Whether the installed module still ships the broken icon; null when it can't be read. */
async function sourceHasBug(): Promise<boolean | null> {
  try {
    const route = (foundry.utils as unknown as { getRoute?(p: string): string }).getRoute?.(SOURCE) ?? SOURCE;
    const res = await fetch(route, { cache: 'no-cache' });
    if (!res.ok) return null;
    return (await res.text()).includes(BUG);
  } catch {
    return null;
  }
}

async function checkSource(): Promise<void> {
  const hasBug = await sourceHasBug();
  if (hasBug === null) return; // Can't tell: keep repairing, it changes nothing on a fixed version.
  repairing = hasBug;
  if (hasBug || !game.user?.isGM) return;
  const version = moduleById(TAH_WFRP)?.version ?? '?';
  if (settings().get(MODULE_ID, NOTIFIED_SETTING) === version) return;
  notify().info(
    fmt(
      'kaiserkram.compat.tahContainerIconFixed',
      'Token Action HUD WFRP4e {version} has fixed its container icon. Kaiserkram no longer repairs it; its workaround (core/compat/tahContainerIcon.ts) can be removed.',
      { version },
    ),
    { permanent: true },
  );
  await settings().set(MODULE_ID, NOTIFIED_SETTING, version);
}

/** Called in `init`. Does nothing unless Token Action HUD WFRP4e is active. */
export function registerTahContainerIconFix(): void {
  if (!moduleById(TAH_WFRP)?.active) return;
  settings().register(MODULE_ID, NOTIFIED_SETTING, { scope: 'world', config: false, type: String, default: '' });
  on('tokenActionHudReady', patchHud);
  Hooks.once('ready', () => {
    patchHud();
    void checkSource();
  });
}
