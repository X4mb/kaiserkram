import { MODULE_ID, MODULE_PATH } from './constants.js';
import type { FeatureId } from './feature.js';
import { notify, settings } from './foundryApi.js';
import { fmt, loc } from './i18n.js';
import { featureName } from './featureManager.js';
import { CORE_SETTINGS } from './toggles.js';
import { SETTINGS as LANDING } from '../features/landing/index.js';
import { SETTINGS as PARTY } from '../features/party/settings.js';
import { SETTINGS as EARSHOT } from '../features/earshot/settings.js';
import { SETTINGS as TRADER } from '../features/trader/settings.js';
import { SHEET_CLASS } from '../features/trader/constants.js';

/**
 * One-time copy of the data the four stand-alone modules left in a world, into Kaiserkram's
 * namespaces. Nothing is deleted: the old flags and settings stay where they were.
 */
export const MIGRATION_VERSION = 2;

/**
 * Steps:
 *  1. copy the old modules' settings, flags and image paths
 *  2. traders stop using a custom sheet (they keep the system's NPC sheet and shop in their own
 *     window), so clear the old and the earlier Kaiserkram trader sheet class and flag them instead
 */

const LEGACY = {
  landing: 'world-landing-fvtt',
  party: 'deploy-party',
  earshot: 'withinearshot',
  trader: 'trader-wfrp4e',
} as const;

const TRADER_SHEET_CLASSES = [`${LEGACY.trader}.TraderSheet`, SHEET_CLASS];

/** Old world setting key → new Kaiserkram setting key, per feature. */
const SETTING_MAP: Record<FeatureId, Record<string, string>> = {
  landing: {
    defaultSceneId: LANDING.DEFAULT_SCENE,
    lastBootEpoch: LANDING.LAST_BOOT,
  },
  party: {
    deployOnDrop: PARTY.DEPLOY_ON_DROP,
    shiftAfterDeployBehavior: PARTY.SHIFT_AFTER_DEPLOY,
    includeSubfolders: PARTY.INCLUDE_SUBFOLDERS,
    afterDeployBehavior: PARTY.AFTER_DEPLOY,
    deployLayout: PARTY.LAYOUT,
    tokenSpacing: PARTY.SPACING,
    partyTokenSize: PARTY.PARTY_TOKEN_SIZE,
    defaultTokenImage: PARTY.DEFAULT_IMAGE,
  },
  earshot: {
    maxRange: EARSHOT.MAX_RANGE,
    gmVoiceGlobal: EARSHOT.GM_VOICE_GLOBAL,
    throughWallGain: EARSHOT.THROUGH_WALL_GAIN,
    muteUnresolvedSpeaker: EARSHOT.MUTE_UNRESOLVED_SPEAKER,
  },
  // The old module's other trader settings (restocking, haggle tuning) no longer exist.
  trader: {
    defaultMarkup: TRADER.DEFAULT_MARKUP,
    defaultSellRate: TRADER.DEFAULT_SELL_RATE,
    enforcePurse: TRADER.ENFORCE_PURSE,
    haggleEnabled: TRADER.HAGGLE_ENABLED,
    haggleRetry: TRADER.HAGGLE_RETRY,
  },
};

/** Image paths that pointed into the old modules' folders. */
const ASSET_MAP: Record<string, string> = {
  [`modules/${LEGACY.party}/assets/party-token.svg`]: `${MODULE_PATH}/assets/party-token.svg`,
  [`modules/${LEGACY.trader}/assets/trader.svg`]: `${MODULE_PATH}/assets/trader.svg`,
};

type Obj = Record<string, unknown>;

type SettingDoc = { key: string; value?: unknown; _source?: { value?: unknown }; update(d: Obj): Promise<unknown> };
type ItemDoc = { _id?: string; flags?: Obj };
type ActorDoc = {
  name: string;
  _source: { img?: string; flags?: Obj; prototypeToken?: { texture?: { src?: string } }; items?: ItemDoc[] };
  update(d: Obj): Promise<unknown>;
  updateEmbeddedDocuments(type: 'Item', d: Obj[]): Promise<unknown>;
};
type TokenDoc = {
  id: string;
  name: string;
  actor: ActorDoc | null;
  _source: {
    _id: string;
    actorLink?: boolean;
    flags?: Obj;
    texture?: { src?: string };
    delta?: { img?: string | null; flags?: Obj; items?: ItemDoc[] } | null;
  };
};
type SceneDoc = {
  name: string;
  tokens: { contents: TokenDoc[] };
  updateEmbeddedDocuments(type: 'Token', d: Obj[]): Promise<unknown>;
};

export type MigrationReport = {
  /** Features that had any data to copy. */
  features: FeatureId[];
  settings: number;
  actors: number;
  items: number;
  tokens: number;
  /** Traders moved off a trader sheet class (step 2). */
  traderSheets: number;
  errors: number;
};

function isObj(v: unknown): v is Obj {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function clone<T>(v: T): T {
  return foundry.utils.deepClone(v);
}

function newAsset(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const bare = path.replace(/^\//, '');
  return ASSET_MAP[bare] ?? null;
}

function legacyNamespace(flagsObj: Obj | undefined, id: string): Obj | null {
  const v = flagsObj?.[id];
  return isObj(v) && Object.keys(v).length ? v : null;
}

function worldSettings(): SettingDoc[] {
  const storage = (game.settings as unknown as { storage: Map<string, unknown> }).storage.get('world') as
    | { contents?: SettingDoc[] }
    | Iterable<SettingDoc>
    | undefined;
  if (!storage) return [];
  return 'contents' in storage && Array.isArray(storage.contents) ? storage.contents : Array.from(storage as Iterable<SettingDoc>);
}

function readValue(doc: SettingDoc): unknown {
  const raw = doc._source?.value ?? doc.value;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function isRegistered(key: string): boolean {
  const registry = (game.settings as unknown as { settings?: Map<string, unknown> }).settings;
  return Boolean(registry?.has(`${MODULE_ID}.${key}`));
}

/**
 * Disabled features haven't registered their settings, so `game.settings.set` would refuse
 * them. Write the stored Setting document directly instead; it is picked up once the
 * feature registers the key.
 */
async function writeSetting(key: string, value: unknown): Promise<void> {
  if (isRegistered(key)) {
    await settings().set(MODULE_ID, key, value);
    return;
  }
  const fullKey = `${MODULE_ID}.${key}`;
  const json = JSON.stringify(value);
  const existing = worldSettings().find((s) => s.key === fullKey);
  if (existing) {
    await existing.update({ value: json });
    return;
  }
  const Setting = (CONFIG as unknown as { Setting: { documentClass: { create(d: Obj): Promise<unknown> } } }).Setting
    .documentClass;
  await Setting.create({ key: fullKey, value: json });
}

class Migrator {
  readonly report: MigrationReport = { features: [], settings: 0, actors: 0, items: 0, tokens: 0, traderSheets: 0, errors: 0 };
  private readonly found = new Set<FeatureId>();

  private mark(feature: FeatureId): void {
    this.found.add(feature);
  }

  private async attempt(label: string, fn: () => Promise<unknown>): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (err) {
      this.report.errors += 1;
      console.error(`[${MODULE_ID}] migration: ${label} failed`, err);
      return false;
    }
  }

  async settings(): Promise<void> {
    const stored = new Map(worldSettings().map((s) => [s.key, s] as const));
    for (const [feature, keys] of Object.entries(SETTING_MAP) as [FeatureId, Record<string, string>][]) {
      for (const [oldKey, newKey] of Object.entries(keys)) {
        const doc = stored.get(`${LEGACY[feature]}.${oldKey}`);
        if (!doc) continue;
        let value = readValue(doc);
        if (feature === 'party' && oldKey === 'defaultTokenImage') value = newAsset(value) ?? value;
        if (await this.attempt(`setting ${LEGACY[feature]}.${oldKey}`, () => writeSetting(newKey, value))) {
          this.report.settings += 1;
          this.mark(feature);
        }
      }
    }
  }

  /** Changes for a (base or synthetic) actor's own flags and image, from what its source holds. */
  private actorChanges(source: { img?: string | null; flags?: Obj }): Obj {
    const update: Obj = {};
    const traderFlags = legacyNamespace(source.flags, LEGACY.trader);
    if (traderFlags) {
      update[`flags.${MODULE_ID}.trader`] = clone(traderFlags);
      this.mark('trader');
    }
    const earshot = legacyNamespace(source.flags, LEGACY.earshot);
    if (earshot && earshot.voiceProfile !== undefined) {
      update[`flags.${MODULE_ID}.earshot.voiceProfile`] = clone(earshot.voiceProfile);
      this.mark('earshot');
    }
    const img = newAsset(source.img);
    if (img) update.img = img;
    return update;
  }

  private itemChanges(items: ItemDoc[] | undefined): Obj[] {
    const updates: Obj[] = [];
    for (const item of items ?? []) {
      const traderFlags = legacyNamespace(item.flags, LEGACY.trader);
      if (!item._id || !traderFlags) continue;
      updates.push({ _id: item._id, [`flags.${MODULE_ID}.trader`]: clone(traderFlags) });
    }
    if (updates.length) this.mark('trader');
    return updates;
  }

  async actors(): Promise<void> {
    const actors = (game.actors as unknown as { contents: ActorDoc[] }).contents;
    for (const actor of actors) {
      const src = actor._source;
      const update = this.actorChanges(src);
      const tokenImg = newAsset(src.prototypeToken?.texture?.src);
      if (tokenImg) update['prototypeToken.texture.src'] = tokenImg;
      if (Object.keys(update).length && (await this.attempt(`actor ${actor.name}`, () => actor.update(update)))) {
        this.report.actors += 1;
      }
      const items = this.itemChanges(src.items);
      if (items.length && (await this.attempt(`items of ${actor.name}`, () => actor.updateEmbeddedDocuments('Item', items)))) {
        this.report.items += items.length;
      }
    }
  }

  async scenes(): Promise<void> {
    const scenes = (game.scenes as unknown as { contents: SceneDoc[] }).contents;
    for (const scene of scenes) {
      const tokenUpdates: Obj[] = [];
      const deltas: { token: TokenDoc; update: Obj; items: Obj[] }[] = [];
      for (const token of scene.tokens.contents) {
        const src = token._source;
        const update: Obj = { _id: src._id };
        const partyFlags = legacyNamespace(src.flags, LEGACY.party);
        if (partyFlags) {
          update[`flags.${MODULE_ID}.party`] = clone(partyFlags);
          this.mark('party');
        }
        const texture = newAsset(src.texture?.src);
        if (texture) update['texture.src'] = texture;
        if (Object.keys(update).length > 1) tokenUpdates.push(update);

        // Unlinked tokens: migrate only what the delta itself overrides, through the
        // synthetic actor, so no base-actor data gets copied into the delta.
        const delta = src.delta;
        if (!src.actorLink && delta) {
          const deltaUpdate = this.actorChanges(delta);
          const deltaItems = this.itemChanges(delta.items);
          if (Object.keys(deltaUpdate).length || deltaItems.length) deltas.push({ token, update: deltaUpdate, items: deltaItems });
        }
      }
      if (
        tokenUpdates.length &&
        (await this.attempt(`tokens on ${scene.name}`, () => scene.updateEmbeddedDocuments('Token', tokenUpdates)))
      ) {
        this.report.tokens += tokenUpdates.length;
      }
      for (const { token, update, items } of deltas) {
        const synthetic = token.actor;
        if (!synthetic) {
          console.warn(`[${MODULE_ID}] migration: token ${token.name} on ${scene.name} has no actor; skipped its delta`);
          continue;
        }
        if (Object.keys(update).length && (await this.attempt(`token ${token.name}`, () => synthetic.update(update)))) {
          this.report.tokens += 1;
        }
        if (
          items.length &&
          (await this.attempt(`items of token ${token.name}`, () => synthetic.updateEmbeddedDocuments('Item', items)))
        ) {
          this.report.items += items.length;
        }
      }
    }
  }

  /** Changes that move a (base or synthetic) actor off a trader sheet class. */
  private sheetChanges(source: { flags?: Obj }): Obj {
    const core = source.flags?.core as Obj | undefined;
    if (!TRADER_SHEET_CLASSES.includes(String(core?.sheetClass ?? ''))) return {};
    return { 'flags.core.sheetClass': '', [`flags.${MODULE_ID}.trader.isTrader`]: true };
  }

  /** Step 2: traders back on the system's sheet. */
  async traderSheets(): Promise<void> {
    for (const actor of (game.actors as unknown as { contents: ActorDoc[] }).contents) {
      const update = this.sheetChanges(actor._source);
      if (Object.keys(update).length && (await this.attempt(`sheet of ${actor.name}`, () => actor.update(update)))) {
        this.report.traderSheets += 1;
      }
    }
    for (const scene of (game.scenes as unknown as { contents: SceneDoc[] }).contents) {
      for (const token of scene.tokens.contents) {
        const delta = token._source.delta;
        if (token._source.actorLink || !delta || !token.actor) continue;
        const update = this.sheetChanges(delta);
        const synthetic = token.actor;
        if (Object.keys(update).length && (await this.attempt(`sheet of token ${token.name}`, () => synthetic.update(update)))) {
          this.report.traderSheets += 1;
        }
      }
    }
  }

  finish(): MigrationReport {
    this.report.features = [...this.found];
    return this.report;
  }
}

export function migrationVersion(): number {
  return Number(settings().get(MODULE_ID, CORE_SETTINGS.MIGRATION_VERSION)) || 0;
}

/**
 * Copy the old modules' data into Kaiserkram. Runs once per world (as a GM), regardless of
 * which features are enabled; `force` runs it again.
 */
export async function migrate({ force = false }: { force?: boolean } = {}): Promise<MigrationReport | null> {
  if (!game.user?.isGM) {
    notify().warn(loc('kaiserkram.migration.gmOnly', 'Only a GM can migrate data.'));
    return null;
  }
  const from = force ? 0 : migrationVersion();
  if (from >= MIGRATION_VERSION) return null;

  console.log(`[${MODULE_ID}] migrating world data from version ${from} to ${MIGRATION_VERSION}…`);
  const migrator = new Migrator();
  if (from < 1) {
    await migrator.settings();
    await migrator.actors();
    await migrator.scenes();
  }
  if (from < 2) await migrator.traderSheets();
  const report = migrator.finish();
  console.log(`[${MODULE_ID}] migration finished`, report);

  if (report.errors) {
    notify().error(
      fmt(
        'kaiserkram.migration.failed',
        'Kaiserkram: {count} part(s) of the data migration failed; see the console. It will try again on the next load.',
        { count: report.errors },
      ),
      { permanent: true },
    );
    return report;
  }

  await settings().set(MODULE_ID, CORE_SETTINGS.MIGRATION_VERSION, MIGRATION_VERSION);
  if (report.traderSheets) {
    notify().info(
      fmt(
        'kaiserkram.migration.traderSheets',
        'Kaiserkram: {count} trader(s) now open with their normal NPC sheet. Their shop has its own window: right-click the trader in the Actors sidebar → Open Shop, or use the Shops button.',
        { count: report.traderSheets },
      ),
      { permanent: true },
    );
  }
  if (report.features.length) {
    notify().info(
      fmt(
        'kaiserkram.migration.done',
        'Kaiserkram copied your data from: {features}. These features stay off until you enable them under Configure Settings → Kaiserkram → Kaiserkram Features.',
        { features: report.features.map(featureName).join(', ') },
      ),
      { permanent: true },
    );
  }
  return report;
}
