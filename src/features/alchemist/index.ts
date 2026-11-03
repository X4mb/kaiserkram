import { MODULE_ID } from '../../core/constants.js';
import type { Feature } from '../../core/feature.js';
import { on, toElement } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';
import { addTokenTools } from '../../core/sceneTools.js';
import { openImport } from './importer.js';
import { registerAlchemistSettings } from './settings.js';
import { placeStairs } from './stairs.js';

/** GM: an "Import from Dungeon Alchemist" button at the top of the Scenes sidebar. */
function addImportButton(_app: unknown, html: unknown): void {
  if (!game.user?.isGM) return;
  const actions = toElement(html)?.querySelector('.header-actions');
  const cls = `${MODULE_ID}-alchemist-import`;
  if (!actions || actions.querySelector(`.${cls}`)) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = cls;
  button.innerHTML = `<i class="fa-solid fa-flask"></i> ${loc('kaiserkram.alchemist.button', 'Dungeon Alchemist')}`;
  button.dataset.tooltip = loc('kaiserkram.alchemist.title', 'Import from Dungeon Alchemist');
  button.addEventListener('click', () => void openImport());
  actions.append(button);
}

export const alchemist: Feature = {
  id: 'alchemist',
  group: 'general',

  init() {
    registerAlchemistSettings();
    on('renderSceneDirectory', addImportButton as (...args: never[]) => unknown);
    addTokenTools(() =>
      game.user?.isGM
        ? [
            {
              name: 'kaiserkramStairs',
              title: loc('kaiserkram.alchemist.stairs.tool', 'Stairs (link this level with the one above or below)'),
              icon: 'fa-solid fa-stairs',
              order: 120,
              use: () => void placeStairs(),
            },
          ]
        : [],
    );
  },

  api() {
    return { openImport, placeStairs };
  },
};
