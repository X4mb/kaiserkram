import { MODULE_ID } from './constants.js';
import type { Feature } from './feature.js';
import { escapeHtml, on, toElement } from './foundryApi.js';
import { featureHint, featureName } from './featureManager.js';

const SECTION_CLASS = `${MODULE_ID}-settings-section`;

/** Every feature's setting keys start with its id (`partyDeployOnDrop`, `traderDefaultMarkup`, ...). */
function settingGroups(root: HTMLElement, feature: Feature): HTMLElement[] {
  const groups = new Set<HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>(`[name^="${MODULE_ID}.${feature.id}"]`)) {
    const name = el.getAttribute('name') ?? '';
    // `party` must not also match a hypothetical `partyX` feature id: the next char is the key's capital.
    if (!/^[A-Z]/.test(name.slice(`${MODULE_ID}.${feature.id}`.length))) continue;
    const group = el.closest<HTMLElement>('.form-group');
    if (group) groups.add(group);
  }
  return [...groups];
}

function sectionHeader(feature: Feature): HTMLElement {
  const header = document.createElement('div');
  header.className = SECTION_CLASS;
  header.dataset.feature = feature.id;
  header.innerHTML = `<h4 class="divider">${escapeHtml(featureName(feature.id))}</h4><p class="hint">${escapeHtml(
    featureHint(feature.id),
  )}</p>`;
  return header;
}

/**
 * Foundry lists all of a module's settings as one block. Put a heading in front of each
 * active feature's settings in Configure Settings, in feature-manager order, with that
 * feature's settings kept together under it.
 */
export function registerSettingsSections(active: readonly Feature[]): void {
  on('renderSettingsConfig', ((_app: unknown, html: unknown) => {
    const root = toElement(html);
    if (!root || root.querySelector(`.${SECTION_CLASS}`)) return;
    const sections = active
      .map((feature) => ({ feature, groups: settingGroups(root, feature) }))
      .filter((s) => s.groups.length);
    if (!sections.length) return;

    // Start where Kaiserkram's first setting is (after any settings menu buttons).
    const first = sections.flatMap((s) => s.groups).sort((a, b) =>
      a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    )[0];
    let anchor: Element = document.createElement('div');
    first.before(anchor);
    const marker = anchor;
    for (const { feature, groups } of sections) {
      for (const el of [sectionHeader(feature), ...groups]) {
        anchor.after(el);
        anchor = el;
      }
    }
    marker.remove();
  }) as (...args: never[]) => unknown);
}
