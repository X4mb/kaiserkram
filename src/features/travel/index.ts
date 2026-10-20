import { MODULE_ID, MODULE_PATH } from '../../core/constants.js';
import type { Feature } from '../../core/feature.js';
import { contextEntry, on, settings } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';
import { registerSocketHandler } from '../../core/socket.js';
import { refreshTravel } from './panel.js';
import { onTravelMessage, request, SETTING, settleIfActive } from './state.js';

/**
 * Travel vote: a player looking at another scene (through a map tile, or the scene navigation)
 * can propose travelling there; everyone online says Ready or Not yet, and the GM makes it the
 * active scene with one click. The GM can also start a vote from the Scenes sidebar.
 */

function sceneIdOf(li: HTMLElement): string | null {
  const row = li.closest<HTMLElement>('[data-document-id], [data-entry-id], [data-scene-id]') ?? li;
  return row.dataset.documentId ?? row.dataset.entryId ?? row.dataset.sceneId ?? null;
}

function addSceneContextOptions(_application: unknown, options: Record<string, unknown>[]): void {
  options.push(
    contextEntry({
      label: loc('kaiserkram.travel.ask', 'Ask players to travel here'),
      icon: '<i class="fa-solid fa-map-location-dot"></i>',
      visible: () => Boolean(game.user?.isGM),
      onClick: (li) => {
        const sceneId = sceneIdOf(li);
        if (sceneId) request({ op: 'propose', sceneId });
      },
    }),
  );
}

export const travel: Feature = {
  id: 'travel',
  group: 'general',
  styles: [`${MODULE_PATH}/styles/travel.css`],

  init() {
    settings().register(MODULE_ID, SETTING, {
      scope: 'world',
      config: false,
      type: Object,
      default: {},
      onChange: () => refreshTravel(),
    });
    on('getSceneContextOptions', addSceneContextOptions as (...args: never[]) => unknown);
    on('canvasReady', refreshTravel);
    // Who is online changes who counts.
    on('userConnected', refreshTravel);
    // A vote is settled once its scene becomes active, however that happened.
    on('updateScene', ((scene: { id: string; active?: boolean }, changes: { active?: boolean }) => {
      if (changes.active && scene.active) void settleIfActive(scene.id);
    }) as (...args: never[]) => unknown);
  },

  ready() {
    registerSocketHandler('travel', onTravelMessage);
    refreshTravel();
  },
};
