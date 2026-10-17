import { MODULE_ID } from './constants.js';
import type { Feature, FeatureGroup, FeatureId } from './feature.js';
import { dialogV2, escapeHtml, moduleById, settings } from './foundryApi.js';
import { fmt, loc } from './i18n.js';
import { FEATURES } from './registry.js';
import { enabledFeatures, isAvailable, setEnabledFeatures, type EnabledMap } from './toggles.js';

const TEXT: Record<FeatureId, { name: [string, string]; hint: [string, string] }> = {
  landing: {
    name: ['kaiserkram.features.landing.name', 'World Landing'],
    hint: [
      'kaiserkram.features.landing.hint',
      'Right-click a scene to make it the landing scene, activated whenever the world starts.',
    ],
  },
  party: {
    name: ['kaiserkram.features.party.name', 'Deploy Party'],
    hint: [
      'kaiserkram.features.party.hint',
      'Drop an actor folder on the canvas to get one party marker; deploy and recall its members from the Token HUD.',
    ],
  },
  earshot: {
    name: ['kaiserkram.features.earshot.name', 'Within Earshot'],
    hint: [
      'kaiserkram.features.earshot.hint',
      'Proximity voice chat: how loud others are follows token distance and walls. Replaces the A/V client.',
    ],
  },
  trader: {
    name: ['kaiserkram.features.trader.name', 'Trader'],
    hint: [
      'kaiserkram.features.trader.hint',
      'Turns WFRP4e NPCs into shops players buy from and sell to, with haggling.',
    ],
  },
};

const GROUPS: Record<FeatureGroup, [string, string]> = {
  general: ['kaiserkram.manager.groups.general', 'General'],
  wfrp4e: ['kaiserkram.manager.groups.wfrp4e', 'WFRP4e'],
};

export function featureName(id: FeatureId): string {
  return loc(...TEXT[id].name);
}

export function featureHint(id: FeatureId): string {
  return loc(...TEXT[id].hint);
}

function renderFeature(feature: Feature, enabled: EnabledMap): string {
  const { id } = feature;
  const legacy = moduleById(feature.legacyModuleId);
  const legacyNote = legacy?.active
    ? `<p class="hint kaiserkram-legacy"><i class="fa-solid fa-triangle-exclamation"></i> ${escapeHtml(
        fmt('kaiserkram.manager.legacyActive', 'The old module "{module}" is still active. Disable it before enabling this.', {
          module: feature.legacyTitle,
        }),
      )}</p>`
    : '';
  return `
    <div class="form-group kaiserkram-feature">
      <label for="kaiserkram-feature-${id}">${escapeHtml(featureName(id))}</label>
      <div class="form-fields">
        <input type="checkbox" id="kaiserkram-feature-${id}" name="${id}" ${enabled[id] === true ? 'checked' : ''} />
      </div>
      <p class="hint">${escapeHtml(featureHint(id))}</p>
      ${legacyNote}
    </div>`;
}

function renderContent(): string {
  const enabled = enabledFeatures();
  const available = FEATURES.filter(isAvailable);
  const sections = (Object.keys(GROUPS) as FeatureGroup[])
    .map((group) => {
      const features = available.filter((f) => f.group === group);
      if (!features.length) return '';
      return `<fieldset><legend>${escapeHtml(loc(...GROUPS[group]))}</legend>${features
        .map((f) => renderFeature(f, enabled))
        .join('')}</fieldset>`;
    })
    .join('');
  return `
    <p class="hint">${escapeHtml(
      loc(
        'kaiserkram.manager.intro',
        'Every feature is off until you tick it. A disabled feature registers nothing: no settings, hooks, keybindings or sheets. Changes apply after a reload.',
      ),
    )}</p>
    ${sections}
    <footer class="form-footer">
      <button type="submit"><i class="fa-solid fa-floppy-disk"></i> ${escapeHtml(loc('kaiserkram.manager.save', 'Save Changes'))}</button>
    </footer>`;
}

async function askReload(): Promise<void> {
  const SettingsConfig = (foundry.applications as unknown as {
    settings?: { SettingsConfig?: { reloadConfirm?(options: { world: boolean }): Promise<void> } };
  }).settings?.SettingsConfig;
  if (typeof SettingsConfig?.reloadConfirm === 'function') {
    await SettingsConfig.reloadConfirm({ world: true });
    return;
  }
  const ok = await dialogV2().confirm({
    window: { title: loc('kaiserkram.manager.reloadTitle', 'Reload Required') },
    content: `<p>${escapeHtml(
      loc('kaiserkram.manager.reloadBody', 'Kaiserkram features changed. Reload now to apply them?'),
    )}</p>`,
    rejectClose: false,
    modal: true,
  });
  if (ok) (foundry.utils as unknown as { debouncedReload(): void }).debouncedReload();
}

async function save(form: HTMLFormElement): Promise<void> {
  const before = enabledFeatures();
  const next: EnabledMap = { ...before };
  for (const feature of FEATURES.filter(isAvailable)) {
    const input = form.elements.namedItem(feature.id) as HTMLInputElement | null;
    next[feature.id] = Boolean(input?.checked);
  }
  const changed = FEATURES.some((f) => (before[f.id] === true) !== (next[f.id] === true));
  if (!changed) return;
  await setEnabledFeatures(next);
  await askReload();
}

type AppV2Constructor = new (options?: Record<string, unknown>) => {
  element: HTMLElement;
  close(): Promise<unknown>;
};

let FeatureManagerClass: AppV2Constructor | undefined;

/** The "Kaiserkram Features" window. Built lazily so nothing touches ApplicationV2 until `init`. */
export function featureManagerClass(): AppV2Constructor {
  if (FeatureManagerClass) return FeatureManagerClass;
  const Base = (foundry.applications.api as unknown as { ApplicationV2: AppV2Constructor }).ApplicationV2;

  class FeatureManager extends Base {
    static DEFAULT_OPTIONS = {
      id: `${MODULE_ID}-features`,
      tag: 'form',
      classes: [`${MODULE_ID}-features`],
      window: { title: 'kaiserkram.manager.title', icon: 'fa-solid fa-toolbox', contentClasses: ['standard-form'] },
      position: { width: 560, height: 'auto' },
      form: {
        handler: FeatureManager.onSubmit,
        submitOnChange: false,
        closeOnSubmit: true,
      },
    };

    static async onSubmit(_event: Event, form: HTMLFormElement): Promise<void> {
      await save(form);
    }

    async _renderHTML(): Promise<string> {
      return renderContent();
    }

    _replaceHTML(result: string, content: HTMLElement): void {
      content.innerHTML = result;
    }
  }

  FeatureManagerClass = FeatureManager;
  return FeatureManager;
}

export function registerFeatureManager(): void {
  settings().registerMenu(MODULE_ID, 'features', {
    name: 'kaiserkram.manager.menuName',
    label: 'kaiserkram.manager.menuLabel',
    hint: 'kaiserkram.manager.menuHint',
    icon: 'fa-solid fa-toolbox',
    type: featureManagerClass(),
    restricted: true,
  });
}
