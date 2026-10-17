/**
 * Smoke test: load dist/kaiserkram.js against stubbed Foundry globals and fire init/ready.
 *
 *  1. All features on in a WFRP4e world: nothing throws, settings and keybindings register
 *     during `init` only, every feature is active, and legacy data gets migrated.
 *  2. All features off: no feature hooks, settings, keybindings, sheets, sockets, CSS or templates.
 *  3. All features on in a non-WFRP world: the Trader stays off.
 *
 * Anything not stubbed explicitly is an auto-generated recursive Proxy, so the bundle can
 * touch any API path without the test having to know about it.
 */
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import assert from 'assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = pathToFileURL(join(root, 'dist', 'kaiserkram.js')).href;
const MODULE_ID = 'kaiserkram';

/** A callable, constructible object where every property is another stub. */
function stub(name = 'stub') {
  const cache = new Map();
  const fn = function () {};
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'then') return undefined; // not a thenable
      if (prop === Symbol.toPrimitive) return () => name;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === 'prototype') return target.prototype;
      if (!cache.has(prop)) cache.set(prop, stub(`${name}.${String(prop)}`));
      return cache.get(prop);
    },
    set(_t, prop, value) {
      cache.set(prop, value);
      return true;
    },
    apply: () => stub(`${name}()`),
    construct: () => stub(`new ${name}`),
  });
}

/** Wrap a real object so missing properties fall back to stubs. */
function partial(name, real) {
  const fallback = stub(name);
  return new Proxy(real, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      return fallback[prop];
    },
  });
}

function isObj(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function expandObject(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const parts = k.split('.');
    let node = out;
    for (const p of parts.slice(0, -1)) node = node[p] ??= {};
    node[parts.at(-1)] = isObj(v) ? expandObject(v) : v;
  }
  return out;
}

function mergeObject(a, b) {
  const out = a ?? {};
  for (const [k, v] of Object.entries(expandObject(b ?? {}))) {
    out[k] = isObj(v) && isObj(out[k]) ? mergeObject(out[k], v) : v;
  }
  return out;
}

/** A document whose update() merges dotted changes into its source, so the test can inspect results. */
function fakeDoc(name, source, embedded = {}) {
  const doc = {
    name,
    _source: source,
    updates: [],
    async update(changes) {
      doc.updates.push(changes);
      mergeObject(source, changes);
    },
    async updateEmbeddedDocuments(type, list) {
      for (const change of list) {
        const target = embedded[type]?.find((d) => d._id === change._id);
        assert.ok(target, `${name}: no ${type} ${change._id}`);
        const { _id, ...rest } = change;
        mergeObject(target, rest);
      }
    },
  };
  return doc;
}

function seedLegacyWorld() {
  const settingDocs = [
    ['world-landing-fvtt.defaultSceneId', JSON.stringify('scene123')],
    ['deploy-party.defaultTokenImage', JSON.stringify('modules/deploy-party/assets/party-token.svg')],
    ['deploy-party.tokenSpacing', JSON.stringify(1.5)],
    ['trader-wfrp4e.defaultMarkup', JSON.stringify(120)],
    ['trader-wfrp4e.haggleMode', JSON.stringify('simple')],
    ['withinearshot.maxRange', JSON.stringify(30)],
    ['someothermodule.thing', JSON.stringify(1)],
  ].map(([key, value]) => fakeDoc(key, { value }));
  for (const d of settingDocs) d.key = d.name;

  const traderItems = [
    { _id: 'item1', name: 'Rope', flags: { 'trader-wfrp4e': { priceOverride: 12, infinite: true } } },
    { _id: 'item2', name: 'Sword', flags: {} },
  ];
  const traderActor = fakeDoc(
    'Trader',
    {
      img: 'modules/trader-wfrp4e/assets/trader.svg',
      prototypeToken: { texture: { src: 'modules/trader-wfrp4e/assets/trader.svg' } },
      flags: {
        core: { sheetClass: 'trader-wfrp4e.TraderSheet' },
        'trader-wfrp4e': { isTrader: true, config: { markup: 110, open: true } },
      },
      items: traderItems,
    },
    { Item: traderItems },
  );
  const pc = fakeDoc('PC', { img: 'pc.png', flags: { withinearshot: { voiceProfile: { gainMultiplier: 1.5 } } }, items: [] });

  const deltaItems = [{ _id: 'item1', flags: { 'trader-wfrp4e': { notForSale: true } } }];
  const syntheticTrader = fakeDoc('Trader (synthetic)', {}, { Item: deltaItems });
  const tokens = [
    {
      id: 'tok1',
      name: 'Party',
      actor: null,
      _source: {
        _id: 'tok1',
        actorLink: false,
        texture: { src: 'modules/deploy-party/assets/party-token.svg' },
        flags: { 'deploy-party': { isPartyToken: true, folderUuid: 'Folder.abc', folderName: 'Heroes' } },
        delta: null,
      },
    },
    {
      id: 'tok2',
      name: 'Trader',
      actor: syntheticTrader,
      _source: {
        _id: 'tok2',
        actorLink: false,
        texture: { src: 'modules/trader-wfrp4e/assets/trader.svg' },
        flags: {},
        delta: { flags: { 'trader-wfrp4e': { haggle: { pc1: { penalty: 5 } } } }, items: deltaItems },
      },
    },
  ];
  const tokenUpdates = [];
  const scene = {
    name: 'Town',
    tokens: { contents: tokens },
    async updateEmbeddedDocuments(type, list) {
      assert.equal(type, 'Token');
      tokenUpdates.push(...list);
      for (const change of list) {
        const t = tokens.find((x) => x._source._id === change._id);
        const { _id, ...rest } = change;
        mergeObject(t._source, rest);
      }
    },
  };
  return { settingDocs, traderActor, traderItems, pc, syntheticTrader, deltaItems, tokens, scene, tokenUpdates };
}

async function run({ label, systemId, enabled, legacy = false }) {
  const phase = { current: 'load' };
  const record = { hooks: [], settings: [], menus: [], keybindings: [], sheets: [], socketOn: 0, styles: [], templates: [], errors: [], created: [] };
  const hookFns = new Map();
  const values = new Map([[`${MODULE_ID}.enabledFeatures`, enabled]]);
  const registered = new Map();
  const world = legacy ? seedLegacyWorld() : null;
  const settingDocs = world?.settingDocs ?? [];

  const Hooks = {
    on(name, fn) {
      record.hooks.push({ name, phase: phase.current });
      if (!hookFns.has(name)) hookFns.set(name, []);
      hookFns.get(name).push(fn);
      return record.hooks.length;
    },
    once(name, fn) {
      return Hooks.on(name, fn);
    },
    async callAll(name, ...args) {
      for (const fn of hookFns.get(name) ?? []) await fn(...args);
    },
  };

  const game = partial('game', {
    system: { id: systemId },
    user: partial('user', { id: 'gm1', isGM: true, name: 'GM' }),
    users: partial('users', {
      activeGM: { isSelf: true },
      contents: [],
      find: () => undefined,
      filter: () => [],
      get: () => undefined,
    }),
    modules: new Map([[MODULE_ID, { id: MODULE_ID, title: 'Kaiserkram', active: true }]]),
    i18n: partial('i18n', { localize: (k) => k, format: (k) => k }),
    socket: { on: () => void record.socketOn++, emit: () => {} },
    actors: { contents: world ? [world.traderActor, world.pc] : [] },
    scenes: { contents: world ? [world.scene] : [], get: () => undefined, active: null },
    settings: {
      settings: registered,
      storage: new Map([['world', { contents: settingDocs }]]),
      register(ns, key, data) {
        assert.equal(phase.current, 'init', `setting ${ns}.${key} registered outside init (${phase.current})`);
        registered.set(`${ns}.${key}`, data);
        record.settings.push(`${ns}.${key}`);
      },
      registerMenu(ns, key) {
        assert.equal(phase.current, 'init', `menu ${ns}.${key} registered outside init`);
        record.menus.push(`${ns}.${key}`);
      },
      get(ns, key) {
        const full = `${ns}.${key}`;
        assert.ok(registered.has(full), `setting ${full} read before it was registered`);
        if (values.has(full)) return values.get(full);
        const doc = settingDocs.find((d) => d.key === full);
        if (doc) return JSON.parse(doc._source.value);
        return registered.get(full).default;
      },
      async set(ns, key, value) {
        const full = `${ns}.${key}`;
        assert.ok(registered.has(full), `setting ${full} set before it was registered`);
        values.set(full, value);
      },
    },
    keybindings: {
      register(ns, action) {
        assert.equal(phase.current, 'init', `keybinding ${ns}.${action} registered outside init (${phase.current})`);
        record.keybindings.push(`${ns}.${action}`);
      },
    },
  });

  const foundry = partial('foundry', {
    utils: partial('foundry.utils', {
      expandObject,
      mergeObject,
      deepClone: (v) => structuredClone(v),
      debounce: (fn) => fn,
      randomID: () => Math.random().toString(36).slice(2, 18),
      fromUuid: async () => null,
      escapeHTML: (s) => s,
      debouncedReload: () => {},
    }),
    applications: partial('foundry.applications', {
      api: partial('foundry.applications.api', {
        ApplicationV2: class {},
        HandlebarsApplicationMixin: (Base) => class extends Base {},
        DialogV2: stub('DialogV2'),
      }),
      sheets: partial('foundry.applications.sheets', { ActorSheetV2: class {} }),
      apps: partial('foundry.applications.apps', {
        DocumentSheetConfig: { registerSheet: (_doc, scope, _cls, opts) => record.sheets.push({ scope, opts }) },
      }),
      handlebars: partial('foundry.applications.handlebars', {
        loadTemplates: async (paths) => void record.templates.push(...paths),
        renderTemplate: async () => '',
      }),
    }),
    av: { clients: { SimplePeerAVClient: class {} } },
  });

  const OriginalClient = class {};
  const CONFIG = partial('CONFIG', {
    WebRTC: { clientClass: OriginalClient },
    Setting: {
      documentClass: {
        create: async (data) => {
          record.created.push(data);
          const doc = fakeDoc(data.key, { value: data.value });
          doc.key = data.key;
          settingDocs.push(doc);
        },
      },
    },
  });

  const head = {
    querySelector: () => null,
    append: (el) => void record.styles.push(el.href),
  };

  Object.assign(globalThis, {
    Hooks,
    game,
    foundry,
    CONFIG,
    CONST: stub('CONST'),
    ui: stub('ui'),
    canvas: null,
    PIXI: stub('PIXI'),
    document: { head, createElement: () => ({ dataset: {} }) },
    window: { location: { origin: 'http://localhost' }, addEventListener: () => {} },
    fetch: async () => {
      throw new Error('no server in smoke test');
    },
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  });

  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args) => {
    record.errors.push(args.map(String).join(' '));
    originalError(...args);
  };
  console.log = () => {};

  try {
    await import(`${bundle}?run=${encodeURIComponent(label)}`);
    phase.current = 'init';
    await Hooks.callAll('init');
    phase.current = 'ready';
    await Hooks.callAll('ready');
    // Let un-awaited feature ready() calls and the migration finish.
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }

  const featureHooks = record.hooks.filter((h) => !(h.phase === 'load' && (h.name === 'init' || h.name === 'ready')));
  return { record, featureHooks, game, CONFIG, OriginalClient, values, world };
}

function ok(label) {
  console.log(`[kaiserkram] smoke: ${label} ✓`);
}

// 1. Everything on, WFRP4e world with data from the old modules.
{
  const all = { landing: true, party: true, earshot: true, trader: true };
  const { record, featureHooks, game, CONFIG, OriginalClient, values, world } = await run({
    label: 'all-on',
    systemId: 'wfrp4e',
    enabled: all,
    legacy: true,
  });
  assert.deepEqual(record.errors, [], 'console.error was called');
  assert.ok(featureHooks.length > 15, `expected feature hooks, got ${featureHooks.length}`);
  assert.ok(featureHooks.every((h) => h.phase === 'init'), 'feature hooks registered outside init');
  for (const key of ['landingDefaultSceneId', 'partyDeployOnDrop', 'earshotMaxRange', 'traderDefaultMarkup']) {
    assert.ok(record.settings.includes(`${MODULE_ID}.${key}`), `setting ${key} not registered`);
  }
  assert.deepEqual(record.keybindings.sort(), [`${MODULE_ID}.earshotToggleGMVoiceGlobal`, `${MODULE_ID}.earshotVoiceToken`]);
  assert.deepEqual(record.menus, [`${MODULE_ID}.features`]);
  assert.equal(record.sheets.length, 1);
  assert.equal(record.sheets[0].scope, MODULE_ID);
  assert.deepEqual(record.styles, ['modules/kaiserkram/styles/trader.css']);
  assert.equal(record.templates.length, 5);
  assert.equal(record.socketOn, 1);
  assert.notEqual(CONFIG.WebRTC.clientClass, OriginalClient, 'WebRTC client not replaced');
  const api = game.modules.get(MODULE_ID).api;
  assert.deepEqual(Object.keys(api.features).sort(), ['earshot', 'landing', 'party', 'trader']);
  assert.equal(typeof api.migrate, 'function');
  ok('all features on (WFRP4e): registers in init, exposes api');

  // Migration
  assert.equal(values.get(`${MODULE_ID}.migrationVersion`), 1, 'migrationVersion not set');
  const created = Object.fromEntries(record.created.map((c) => [c.key, JSON.parse(c.value)]));
  // These features are enabled, so their settings are registered and go through game.settings.set.
  assert.equal(values.get(`${MODULE_ID}.landingDefaultSceneId`), 'scene123');
  assert.equal(values.get(`${MODULE_ID}.partyDefaultTokenImage`), 'modules/kaiserkram/assets/party-token.svg');
  assert.equal(values.get(`${MODULE_ID}.partyTokenSpacing`), 1.5);
  assert.equal(values.get(`${MODULE_ID}.traderDefaultMarkup`), 120);
  assert.equal(values.get(`${MODULE_ID}.traderHaggleMode`), 'simple');
  assert.equal(values.get(`${MODULE_ID}.earshotMaxRange`), 30);
  assert.deepEqual(created, {});

  const t = world.traderActor._source;
  assert.equal(t.flags.core.sheetClass, 'kaiserkram.TraderSheet');
  assert.deepEqual(t.flags.kaiserkram.trader, { isTrader: true, config: { markup: 110, open: true } });
  assert.ok(t.flags['trader-wfrp4e'], 'old trader flags must be kept');
  assert.equal(t.img, 'modules/kaiserkram/assets/trader.svg');
  assert.equal(t.prototypeToken.texture.src, 'modules/kaiserkram/assets/trader.svg');
  assert.deepEqual(world.traderItems[0].flags.kaiserkram.trader, { priceOverride: 12, infinite: true });
  assert.equal(world.traderItems[1].flags.kaiserkram, undefined);
  assert.deepEqual(world.pc._source.flags.kaiserkram.earshot.voiceProfile, { gainMultiplier: 1.5 });
  const [partyTok, traderTok] = world.tokens.map((x) => x._source);
  assert.deepEqual(partyTok.flags.kaiserkram.party, { isPartyToken: true, folderUuid: 'Folder.abc', folderName: 'Heroes' });
  assert.equal(partyTok.texture.src, 'modules/kaiserkram/assets/party-token.svg');
  assert.equal(traderTok.texture.src, 'modules/kaiserkram/assets/trader.svg');
  assert.deepEqual(world.syntheticTrader.updates, [{ 'flags.kaiserkram.trader': { haggle: { pc1: { penalty: 5 } } } }]);
  assert.deepEqual(world.deltaItems[0].flags.kaiserkram.trader, { notForSale: true });
  ok('migration copies settings, flags, sheet class, images and token deltas');
}

// 2. Everything off (the default), with legacy data: nothing registers, migration still runs.
{
  const { record, featureHooks, CONFIG, OriginalClient, values } = await run({
    label: 'all-off',
    systemId: 'wfrp4e',
    enabled: {},
    legacy: true,
  });
  assert.deepEqual(record.errors, []);
  assert.deepEqual(featureHooks, [], 'disabled features registered hooks');
  assert.deepEqual(record.settings.sort(), [`${MODULE_ID}.enabledFeatures`, `${MODULE_ID}.migrationVersion`]);
  assert.deepEqual(record.keybindings, []);
  assert.deepEqual(record.sheets, []);
  assert.deepEqual(record.styles, []);
  assert.deepEqual(record.templates, []);
  assert.equal(record.socketOn, 0);
  assert.equal(CONFIG.WebRTC.clientClass, OriginalClient);
  ok('all features off: registers nothing');

  // Unregistered settings are written straight to world storage.
  assert.equal(values.get(`${MODULE_ID}.migrationVersion`), 1);
  const created = Object.fromEntries(record.created.map((c) => [c.key, JSON.parse(c.value)]));
  assert.deepEqual(created, {
    'kaiserkram.landingDefaultSceneId': 'scene123',
    'kaiserkram.partyDefaultTokenImage': 'modules/kaiserkram/assets/party-token.svg',
    'kaiserkram.partyTokenSpacing': 1.5,
    'kaiserkram.traderDefaultMarkup': 120,
    'kaiserkram.traderHaggleMode': 'simple',
    'kaiserkram.earshotMaxRange': 30,
  });
  ok('migration runs with every feature off');
}

// 3. Everything on in a non-WFRP world: Trader stays off.
{
  const all = { landing: true, party: true, earshot: true, trader: true };
  const { record, game } = await run({ label: 'dnd5e', systemId: 'dnd5e', enabled: all });
  assert.deepEqual(record.errors, []);
  assert.deepEqual(record.sheets, []);
  assert.equal(record.socketOn, 0);
  assert.ok(!record.settings.some((k) => k.startsWith(`${MODULE_ID}.trader`)), 'trader settings registered');
  assert.deepEqual(Object.keys(game.modules.get(MODULE_ID).api.features).sort(), ['earshot', 'landing', 'party']);
  ok('non-WFRP world: Trader stays off');
}
