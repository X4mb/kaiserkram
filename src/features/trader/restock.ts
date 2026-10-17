import { rollAvailability, settlementLabel } from './availability.js';
import { MODULE_ID } from '../../core/constants.js';
import {
  dialogV2,
  escapeHtml,
  expandObject,
  postChat,
  renderTemplate,
  resolveDocument,
} from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { CARD_CLASS, FLAGS, TEMPLATES } from './constants.js';
import {
  g,
  type WfrpActor,
  type WfrpItem,
} from './wfrp.js';
import {
  asSettlement,
  isForSale,
  isTradeable,
  SETTLEMENTS,
  stockQuantity,
  traderConfig,
  type Settlement,
} from './trader.js';

type TableResultLike = { documentUuid?: string | null; name?: string; text?: string; description?: string };
type RollTableLike = {
  name: string;
  uuid: string;
  results: { contents: TableResultLike[] };
  roll(): Promise<{ results: TableResultLike[] }>;
};

/**
 * WFRP4e item types that are goods with a price. Skills, talents, conditions, spells and the
 * like are Items too, which is why tables of them would otherwise show up as restock tables.
 */
const GOODS_TYPES = new Set(['weapon', 'armour', 'trapping', 'ammunition', 'container', 'cargo']);

function worldTables(): RollTableLike[] {
  return (game as unknown as { tables: { contents: RollTableLike[] } }).tables.contents;
}

function worldItemNamed(name: string): WfrpItem | undefined {
  return (game as unknown as { items: { getName(n: string): WfrpItem | undefined } }).items.getName(name);
}

/** The item type a result points at, without loading anything (world items or compendium indexes). */
function resultItemType(result: TableResultLike): string | null {
  if (result.documentUuid) {
    try {
      const fromUuidSync = (foundry.utils as unknown as { fromUuidSync(u: string): unknown }).fromUuidSync;
      const doc = fromUuidSync(result.documentUuid) as { type?: string; documentName?: string } | null;
      if (doc?.type && (doc.documentName === undefined || doc.documentName === 'Item')) return doc.type;
    } catch {
      /* not resolvable without loading; treat as unknown */
    }
  }
  const label = (result.name || result.text || result.description || '').trim();
  return (label && worldItemNamed(label)?.type) || null;
}

/** Whether a table can give the trader anything to sell. */
export function isRestockTable(table: RollTableLike): boolean {
  return table.results.contents.some((r) => GOODS_TYPES.has(resultItemType(r) ?? ''));
}

async function itemFromResult(result: TableResultLike): Promise<WfrpItem | null> {
  if (result.documentUuid) {
    const doc = await resolveDocument<WfrpItem & { documentName?: string }>(result.documentUuid);
    if (doc?.documentName === 'Item') return doc;
  }
  const label = (result.name || result.text || result.description || '').trim();
  return (label && worldItemNamed(label)) || null;
}

export type RestockOptions = {
  /** Remove the current for-sale stock first. */
  clear?: boolean;
  /**
   * Roll WFRP4e Availability tests for this settlement size: unavailable items are skipped and the
   * stock count comes from the system's table instead of one per draw. '' (default) skips the tests.
   */
  settlement?: Settlement;
};

export type RestockResult = { added: number; unavailable: string[] };

type Drawn = { item: WfrpItem; qty: number; infinite: boolean };

/** GM: roll a RollTable `rolls` times and add whatever items it gives to the trader's stock. */
export async function restockFromTable(
  trader: WfrpActor,
  tableUuid: string,
  rolls: number,
  { clear = false, settlement = '' }: RestockOptions = {},
): Promise<RestockResult> {
  const table = await resolveDocument<RollTableLike>(tableUuid);
  if (!table) throw new Error(`No RollTable ${tableUuid}`);

  if (clear) {
    const ids = trader.items.contents.filter(isForSale).map((i) => i.id);
    if (ids.length) await trader.deleteEmbeddedDocuments('Item', ids);
  }

  // Tally first so repeated draws become one stack.
  const drawn = new Map<string, Drawn>();
  for (let i = 0; i < rolls; i++) {
    const { results } = await table.roll();
    for (const r of results) {
      const item = await itemFromResult(r);
      if (!item || !isTradeable(item)) continue;
      const key = `${item.type}:${item.name}`;
      const entry = drawn.get(key) ?? { item, qty: 0, infinite: false };
      entry.qty += 1;
      drawn.set(key, entry);
    }
  }

  // With a settlement, each distinct item gets one Availability test, which also sets its stock.
  const unavailable: string[] = [];
  const report: string[] = [];
  if (settlement) {
    for (const [key, entry] of drawn) {
      const result = await rollAvailability(entry.item, settlement);
      const rollText = result.roll === null ? '' : ` (${result.roll} / ${result.target})`;
      if (!result.available) {
        drawn.delete(key);
        unavailable.push(entry.item.name);
        report.push(`<li><s>${escapeHtml(entry.item.name)}</s>: ${escapeHtml(result.rarity)}${rollText}</li>`);
        continue;
      }
      entry.qty = result.qty;
      entry.infinite = result.infinite;
      report.push(
        `<li><b>${escapeHtml(entry.item.name)}</b>: ${escapeHtml(result.rarity)}${rollText} → ${
          result.infinite ? '∞' : result.qty
        }</li>`,
      );
    }
  }

  const creates: Record<string, unknown>[] = [];
  let added = 0;
  for (const { item, qty, infinite } of drawn.values()) {
    added += qty;
    const existing = trader.items.contents.find((i) => i.name === item.name && i.type === item.type && isForSale(i));
    if (existing) {
      await existing.update({ 'system.quantity.value': stockQuantity(existing) + qty });
      if (infinite) await existing.setFlag(MODULE_ID, FLAGS.INFINITE, true);
    } else {
      const data = item.toObject();
      delete data._id;
      data.system.quantity = { value: infinite ? 1 : qty };
      if (infinite) data.flags = foundry.utils.mergeObject(data.flags ?? {}, { [MODULE_ID]: expandObject({ [FLAGS.INFINITE]: true }) });
      creates.push(data);
    }
  }
  if (creates.length) await trader.createEmbeddedDocuments('Item', creates);
  await trader.setFlag(MODULE_ID, FLAGS.RESTOCK_TABLE, table.uuid);

  if (report.length) {
    const gmIds = g().users.contents.filter((u) => u.isGM).map((u) => u.id);
    await postChat({
      whisper: gmIds,
      content: `<div class="${CARD_CLASS}"><b>${escapeHtml(
        fmt('kaiserkram.trader.restock.reportTitle', 'Availability in a {settlement}: {trader}', {
          settlement: settlementLabel(settlement),
          trader: trader.name,
        }),
      )}</b><ul>${report.join('')}</ul></div>`,
    });
  }
  return { added, unavailable };
}

/** GM: pick a table, how many draws and the settlement size, then restock. */
export async function openRestockDialog(trader: WfrpActor): Promise<void> {
  const last = String(trader.getFlag(MODULE_ID, FLAGS.RESTOCK_TABLE) ?? '');
  const settlement = traderConfig(trader).settlement;
  const tables = worldTables()
    .filter((t) => t.uuid === last || isRestockTable(t))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => ({ uuid: t.uuid, name: t.name, selected: t.uuid === last }));
  const content = await renderTemplate(TEMPLATES.RESTOCK_DIALOG, {
    tables,
    hasTables: tables.length > 0,
    customUuid: tables.some((t) => t.selected) ? '' : last,
    settlements: settlementChoices(settlement),
  });

  const choice = (await dialogV2().wait({
    window: { title: fmt('kaiserkram.trader.restock.title', 'Restock {trader}', { trader: trader.name }) },
    content,
    rejectClose: false,
    render: (_event: unknown, dialog: { element: HTMLElement }) => acceptTableDrops(dialog.element),
    buttons: [
      {
        action: 'restock',
        label: loc('kaiserkram.trader.restock.go', 'Restock'),
        icon: 'fa-solid fa-boxes-stacked',
        default: true,
        callback: (_event: unknown, button: { form: HTMLFormElement }) => {
          const f = button.form.elements;
          const val = (n: string) => (f.namedItem(n) as HTMLInputElement | null)?.value ?? '';
          return {
            uuid: val('customUuid').trim() || val('table'),
            rolls: Math.max(1, Math.floor(Number(val('rolls')) || 1)),
            clear: Boolean((f.namedItem('clear') as HTMLInputElement | null)?.checked),
            settlement: asSettlement(val('settlement')),
          };
        },
      },
      { action: 'cancel', label: loc('kaiserkram.trader.common.cancel', 'Cancel') },
    ],
  })) as { uuid: string; rolls: number; clear: boolean; settlement: Settlement } | string | null;
  if (!choice || typeof choice !== 'object' || !choice.uuid) return;

  if (choice.settlement !== settlement) await setSettlement(trader, choice.settlement);

  const notify = ui.notifications as unknown as { info(m: string): void; error(m: string): void };
  try {
    const { added, unavailable } = await restockFromTable(trader, choice.uuid, choice.rolls, {
      clear: choice.clear,
      settlement: choice.settlement,
    });
    notify.info(
      fmt('kaiserkram.trader.restock.done', 'Added {count} item(s) to {trader}\'s stock ({missing} not available).', {
        count: added,
        trader: trader.name,
        missing: unavailable.length,
      }),
    );
  } catch (err) {
    console.error('[kaiserkram] trader: Restock failed', err);
    notify.error(loc('kaiserkram.trader.restock.failed', 'Restock failed: that RollTable could not be found.'));
  }
}

/** Dropping a RollTable (sidebar or compendium) anywhere on the restock dialog fills in its UUID. */
function acceptTableDrops(root: HTMLElement): void {
  const input = root.querySelector<HTMLInputElement>('input[name="customUuid"]');
  if (!input) return;
  root.addEventListener('dragover', (ev) => ev.preventDefault());
  root.addEventListener('drop', (ev) => {
    let data: { type?: string; uuid?: string };
    try {
      data = JSON.parse(ev.dataTransfer?.getData('text/plain') ?? '');
    } catch {
      return;
    }
    if (data.type !== 'RollTable' || !data.uuid) return;
    ev.preventDefault();
    input.value = data.uuid;
    input.dispatchEvent(new Event('change'));
  });
}

export function settlementChoices(current: Settlement): { value: string; label: string; selected: boolean }[] {
  return (['', ...SETTLEMENTS] as Settlement[]).map((value) => ({
    value,
    label: settlementLabel(value),
    selected: value === current,
  }));
}

export async function setSettlement(trader: WfrpActor, settlement: Settlement): Promise<void> {
  await trader.setFlag(MODULE_ID, `${FLAGS.CONFIG}.settlement`, settlement);
}

/** GM: ask which settlement size a trader is in (e.g. right after placing the token). */
export async function promptSettlement(trader: WfrpActor, { offerRestock = false } = {}): Promise<void> {
  const content = await renderTemplate(TEMPLATES.SETTLEMENT_DIALOG, {
    settlements: settlementChoices(traderConfig(trader).settlement),
    showRestock: offerRestock,
  });
  const choice = (await dialogV2().wait({
    window: { title: fmt('kaiserkram.trader.settlement.title', 'Where is {trader} trading?', { trader: trader.name }) },
    content,
    rejectClose: false,
    buttons: [
      {
        action: 'ok',
        label: loc('kaiserkram.trader.common.confirm', 'Confirm'),
        default: true,
        callback: (_event: unknown, button: { form: HTMLFormElement }) => {
          const f = button.form.elements;
          return {
            settlement: asSettlement((f.namedItem('settlement') as HTMLSelectElement | null)?.value),
            restock: Boolean((f.namedItem('restock') as HTMLInputElement | null)?.checked),
          };
        },
      },
      { action: 'cancel', label: loc('kaiserkram.trader.common.skip', 'Skip') },
    ],
  })) as { settlement: Settlement; restock: boolean } | string | null;
  if (!choice || typeof choice !== 'object') return;
  await setSettlement(trader, choice.settlement);
  if (choice.restock) await openRestockDialog(trader);
}
