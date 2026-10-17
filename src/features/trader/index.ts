import { MODULE_ID } from '../../core/constants.js';
import type { Feature } from '../../core/feature.js';
import { expandObject, on, toElement } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';
import { DEFAULT_TRADER_IMAGE, FLAGS, SHEET_CLASS, STYLESHEET, TEMPLATES } from './constants.js';
import { registerHaggleHandler, resetHaggling, startHaggle } from './haggle.js';
import { promptSettlement, restockFromTable } from './restock.js';
import { getBool, registerTraderSettings, SETTINGS } from './settings.js';
import { TraderSheet } from './sheet.js';
import { registerSocket } from './socket.js';
import { isTrader } from './trader.js';
import { registerTransactionHandlers } from './transactions.js';
import { g, type WfrpActor } from './wfrp.js';

function registerSheet(): void {
  const config = foundry.applications.apps.DocumentSheetConfig as unknown as {
    registerSheet(doc: unknown, scope: string, cls: unknown, options: Record<string, unknown>): void;
  };
  config.registerSheet(foundry.documents.Actor, MODULE_ID, TraderSheet, {
    types: ['npc'],
    makeDefault: false,
    label: 'kaiserkram.trader.sheet.label',
  });
}

/** GM: create a new NPC that opens as a trader. */
export async function createTrader(data: Record<string, unknown> = {}): Promise<WfrpActor | null> {
  const cls = (CONFIG as unknown as { Actor: { documentClass: { create(d: unknown): Promise<unknown> } } }).Actor
    .documentClass;
  const actor = (await cls.create(
    foundry.utils.mergeObject(
      {
        name: loc('kaiserkram.trader.sheet.newTrader', 'Trader'),
        type: 'npc',
        img: DEFAULT_TRADER_IMAGE,
        prototypeToken: { texture: { src: DEFAULT_TRADER_IMAGE } },
        flags: {
          core: { sheetClass: SHEET_CLASS },
          [MODULE_ID]: expandObject({ [FLAGS.IS_TRADER]: true }),
        },
      },
      data,
    ),
  )) as WfrpActor | null;
  actor?.sheet?.render({ force: true });
  return actor;
}

const CREATE_BUTTON_CLASS = `${MODULE_ID}-trader-create`;

function addDirectoryButton(_app: unknown, html: unknown): void {
  if (!g().user.isGM) return;
  const root = toElement(html);
  const actions = root?.querySelector('.header-actions');
  if (!actions || actions.querySelector(`.${CREATE_BUTTON_CLASS}`)) return;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = CREATE_BUTTON_CLASS;
  button.innerHTML = `<i class="fa-solid fa-store"></i> ${loc('kaiserkram.trader.sheet.createTrader', 'Create Trader')}`;
  button.addEventListener('click', () => void createTrader());
  actions.append(button);
}

/** GM: placing a trader on a scene asks which settlement size the trader is in (unless turned off). */
function onCreateToken(token: { actor: WfrpActor | null }, _options: unknown, userId: string): void {
  if (userId !== g().user.id || !g().user.isGM || !getBool(SETTINGS.ASK_SETTLEMENT)) return;
  if (!token.actor || !isTrader(token.actor)) return;
  void promptSettlement(token.actor, { offerRestock: true });
}

function registerHooks(): void {
  /** A customer's coins or inventory changing should refresh any open trader sheet. */
  const refreshOpenSheets = foundry.utils.debounce(() => {
    for (const sheet of TraderSheet.open) if (sheet.rendered) void sheet.render();
  }, 100);

  const onItemChange = (item: { parent?: { documentName?: string } | null }): void => {
    if (item.parent?.documentName === 'Actor' && TraderSheet.open.size) refreshOpenSheets();
  };

  on('renderActorDirectory', addDirectoryButton);
  on('createToken', onCreateToken as (...args: never[]) => unknown);
  for (const hook of ['createItem', 'updateItem', 'deleteItem']) on(hook, onItemChange);
}

export const trader: Feature = {
  id: 'trader',
  group: 'wfrp4e',
  systems: ['wfrp4e'],
  legacyModuleId: 'trader-wfrp4e',
  legacyTitle: 'WFRP4e Trader',
  styles: [STYLESHEET],
  templates: Object.values(TEMPLATES),

  init() {
    registerTraderSettings();
    registerSheet();
    registerTransactionHandlers();
    registerHaggleHandler();
    registerHooks();
  },

  ready() {
    registerSocket();
  },

  api() {
    return { createTrader, isTrader, promptSettlement, restockFromTable, resetHaggling, startHaggle, TraderSheet };
  },
};
