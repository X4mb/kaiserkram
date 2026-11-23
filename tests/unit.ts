/**
 * Unit tests for the logic that moves money and items or builds imported scenes: the parts where
 * a mistake loses or doubles something at the table. Foundry is faked with plain objects that
 * behave like documents (update, create, delete). Run with `npm run test`.
 */
import assert from 'node:assert/strict';

// --- A little of Foundry, before the module code loads ---------------------------------------
const docs = new Map<string, Doc>();
Object.assign(globalThis, {
  Hooks: { on: () => 0, once: () => 0 },
  foundry: {
    utils: {
      objectsEqual: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
      deepClone: <T>(v: T): T => structuredClone(v),
      fromUuid: async (uuid: string) => docs.get(uuid) ?? null,
    },
  },
  game: {
    user: { id: 'gm', isGM: true },
    users: { contents: [{ id: 'p1', isGM: false, active: true }] },
    settings: { get: () => true },
    i18n: { localize: (k: string) => k, format: (k: string) => k, has: () => false },
  },
});

const { transferItem, sameGoods, goodsAndMoney, quantityOf } = await import('../src/core/items.js');
const { parsePrice, planPayment, purseTotal } = await import('../src/features/trader/money.js');
const { totalFor } = await import('../src/features/trader/trader.js');
const { handleRequest, setBroadcaster } = await import('../src/features/party/trade/authority.js');
const { buildScene, filesOfMap } = await import('../src/features/alchemist/build.js');
const { outlineFromWalls } = await import('../src/features/alchemist/outline.js');
const { toMetric } = await import('../src/features/metric/convert.js');
const { previewDamage } = await import('../src/features/damagePreview/index.js');
const { distanceToSegment } = await import('../src/features/doors/index.js');

type Doc = Record<string, any>;
let nextId = 0;
/** Items whose delete should fail (by id, so copies of them delete normally). */
const failDelete = new Set<string>();

/** An actor whose items behave like embedded documents. */
function actor(name: string): Doc {
  const a: Doc = { id: name, uuid: `Actor.${name}`, name, img: '', isOwner: true, list: [] as Doc[] };
  a.items = { get contents() { return a.list; }, get: (id: string) => a.list.find((i: Doc) => i.id === id) };
  a.testUserPermission = () => true;
  a.createEmbeddedDocuments = async (_type: string, data: Doc[], options?: Doc) =>
    data.map((d) => addItem(a, { ...d, id: options?.keepId ? d._id : undefined }));
  return a;
}

function addItem(a: Doc, data: Doc): Doc {
  const item: Doc = { ...structuredClone(data), id: data.id ?? `i${++nextId}`, documentName: 'Item', parent: a, img: '' };
  item.uuid = `${a.uuid}.Item.${item.id}`;
  item.toObject = () => {
    const { parent, toObject, update, delete: _delete, ...rest } = item;
    return { ...structuredClone(rest), _id: item.id };
  };
  item.update = async (changes: Doc) => {
    for (const [path, value] of Object.entries(changes)) {
      const keys = path.split('.');
      let target = item;
      for (const k of keys.slice(0, -1)) target = target[k];
      target[keys.at(-1)!] = value;
    }
  };
  item.delete = async () => {
    if (failDelete.has(item.id)) throw new Error('delete failed');
    a.list = a.list.filter((i: Doc) => i !== item);
    docs.delete(item.uuid);
  };
  a.list.push(item);
  docs.set(item.uuid, item);
  return item;
}

const goods = (name: string, qty: number, extra: Doc = {}) => ({ name, type: 'trapping', system: { quantity: { value: qty }, location: { value: '' }, ...extra } });
const count = (a: Doc, name: string) => a.list.filter((i: Doc) => i.name === name).reduce((n: number, i: Doc) => n + quantityOf(i), 0);

let passed = 0;
async function test(name: string, run: () => unknown): Promise<void> {
  await run();
  passed += 1;
  console.log(`[kaiserkram] unit: ${name} ✓`);
}

// --- Money ------------------------------------------------------------------------------------
await test('typed prices', () => {
  assert.equal(parsePrice('1 gc 5 ss'), 300);
  assert.equal(parsePrice('1,5 gc'), 360);
  assert.equal(parsePrice('3s 6b'), 42);
  assert.equal(parsePrice('1/5/0'), 300);
  assert.equal(parsePrice('7'), 7);
  assert.equal(parsePrice('2 p'), 2);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice('5 mp'), null, 'unknown unit');
  assert.equal(parsePrice('1,5'), 2, 'a bare number is brass pennies');
  assert.equal(parsePrice('5 gc please'), null, 'leftover words');
  assert.equal(parsePrice('1 gc, 5 ss'), 300, 'a comma between parts');
});

await test('paying makes change and never overspends', () => {
  const purse = [
    { id: 'bp', value: 1, qty: 3 },
    { id: 'ss', value: 12, qty: 1 },
  ];
  const after = planPayment(purse, 13)!;
  assert.equal(purseTotal(after), purseTotal(purse) - 13);
  const fromGold = planPayment([{ id: 'gc', value: 240, qty: 1 }], 1)!;
  assert.equal(purseTotal(fromGold), 239, 'one gold crown broken, change given');
  assert.equal(planPayment([{ id: 'bp', value: 1, qty: 2 }], 3), null, "can't afford");
});

await test('a haggled deal counts for one unit only', () => {
  assert.equal(totalFor({ list: 100, unit: 80, deal: 20 }, 3), 280);
  assert.equal(totalFor({ list: 100, unit: 80, deal: 20 }, 0), 0);
});

// --- Moving items -----------------------------------------------------------------------------
await test('same goods stack; different qualities and derived values handled', () => {
  const r3 = { name: 'Rations', type: 'trapping', _source: { system: { quantity: { value: 3 }, encumbrance: { value: 0.1 } } }, system: { encumbrance: { total: 0.3 } } };
  const r1 = { name: 'Rations', type: 'trapping', _source: { system: { quantity: { value: 1 }, encumbrance: { value: 0.1 } } }, system: { encumbrance: { total: 0.1 } } };
  assert.ok(sameGoods(r3, r1), 'counts and derived totals differ, still the same goods');
  assert.ok(!sameGoods(r3, { ...r1, _source: { system: { ...r1._source.system, qualities: ['fine'] } } }));
});

await test('a move that fails half-way puts everything back', async () => {
  const a = actor('A');
  const b = actor('B');
  const sword = addItem(a, goods('Sword', 1));
  addItem(b, goods('Sword', 2));
  const rope = addItem(a, goods('Rope', 1));
  failDelete.add(rope.id);
  const undo: (() => Promise<unknown>)[] = [];
  await assert.rejects(async () => {
    await transferItem(sword as never, 1, b as never, undo);
    await transferItem(rope as never, 1, b as never, undo);
  });
  for (const step of undo.reverse()) await step();
  assert.equal(count(b, 'Sword'), 2);
  assert.equal(count(b, 'Rope'), 0);
  assert.equal(a.items.get(sword.id) ? 1 : 0, 1, 'the sword is back under its own id');
  assert.equal(count(a, 'Rope'), 1);
});

await test('a whole container moves with what is inside', async () => {
  const a = actor('A2');
  const b = actor('B2');
  const bag = addItem(a, { name: 'Backpack', type: 'container', system: { quantity: { value: 1 }, location: { value: '' } } });
  addItem(a, goods('Rope', 1, { location: { value: bag.id } }));
  const pouch = addItem(a, { name: 'Pouch', type: 'container', system: { quantity: { value: 1 }, location: { value: bag.id } } });
  addItem(a, goods('Gem', 2, { location: { value: pouch.id } }));
  await transferItem(bag as never, 1, b as never);
  assert.equal(a.list.length, 0);
  const newBag = b.list.find((i: Doc) => i.name === 'Backpack');
  const newPouch = b.list.find((i: Doc) => i.name === 'Pouch');
  assert.equal(b.list.find((i: Doc) => i.name === 'Rope').system.location.value, newBag.id);
  assert.equal(b.list.find((i: Doc) => i.name === 'Gem').system.location.value, newPouch.id);
});

await test('a container moved without its contents leaves them with their owner', async () => {
  const a = actor('A3');
  const b = actor('B3');
  const bag = addItem(a, { name: 'Backpack', type: 'container', system: { quantity: { value: 1 }, location: { value: '' } } });
  addItem(a, goods('Sword', 1, { location: { value: bag.id } }));
  await transferItem(bag as never, 1, b as never, [], { withContents: false });
  assert.equal(count(b, 'Sword'), 0, 'the trader did not pay for the sword');
  assert.equal(count(a, 'Sword'), 1);
});

await test('two players dragging the same stack: nobody gets extra', async () => {
  const notes: Doc[] = [];
  setBroadcaster((m: Doc) => notes.push(m));
  const party = actor('Party');
  const p = actor('P');
  const q = actor('Q');
  const gold = addItem(party, { name: 'GC', type: 'money', system: { quantity: { value: 10 }, coinValue: { value: 240 } } });
  // Both copies already made by the players' sheets before the GM settles them.
  const copyQ = addItem(q, { name: 'GC', type: 'money', system: { quantity: { value: 5 }, coinValue: { value: 240 } } });
  const copyP = addItem(p, { name: 'GC', type: 'money', system: { quantity: { value: 10 }, coinValue: { value: 240 } } });
  await handleRequest({ kind: 'trade', op: 'settle', userId: 'p1', source: gold.uuid, copy: copyQ.uuid, qty: 5 } as never);
  await handleRequest({ kind: 'trade', op: 'settle', userId: 'p1', source: gold.uuid, copy: copyP.uuid, qty: 10 } as never);
  assert.equal(count(party, 'GC') + count(p, 'GC') + count(q, 'GC'), 10);
  assert.ok(notes.some((n) => n.failed), 'the later drag was taken back and told so');
  const spell = addItem(party, { name: 'Dart', type: 'spell', system: {} });
  const spellCopy = addItem(p, { name: 'Dart', type: 'spell', system: {} });
  await handleRequest({ kind: 'trade', op: 'settle', userId: 'p1', source: spell.uuid, copy: spellCopy.uuid, qty: null } as never);
  assert.equal(party.list.some((i: Doc) => i.name === 'Dart'), false, 'something without a count still moves');
});

await test('goods and money listed for handing over', () => {
  const a = actor('L');
  addItem(a, goods('Torch', 1));
  addItem(a, goods('Axe', 1));
  addItem(a, { name: 'BP', type: 'money', system: { quantity: { value: 3 }, coinValue: { value: 1 } } });
  addItem(a, { name: 'GC', type: 'money', system: { quantity: { value: 1 }, coinValue: { value: 240 } } });
  addItem(a, goods('Empty', 0));
  const { goods: g, money } = goodsAndMoney(a as never);
  assert.deepEqual(g.map((i) => i.name), ['Axe', 'Torch']);
  assert.deepEqual(money.map((i) => i.name), ['GC', 'BP']);
});

// --- Dungeon Alchemist import -----------------------------------------------------------------
await test('a building outline follows its walls', () => {
  const box = (x: number, y: number, w: number, h: number) => [
    [x, y, x + w, y],
    [x + w, y, x + w, y + h],
    [x + w, y + h, x, y + h],
    [x, y + h, x, y],
  ];
  const outline = outlineFromWalls(3000, 3000, [...box(600, 600, 600, 600), ...box(1800, 1800, 450, 450)], { cell: 30, grow: 2, minCells: 50 });
  assert.equal(outline.length, 2, 'two buildings, two outlines');
  const xs = outline[0].filter((_, i) => i % 2 === 0);
  assert.ok(Math.min(...xs) < 600 && Math.max(...xs) > 1200, 'walls kept inside, with a margin');
});

await test('levels, heights and the roof from the file numbers', () => {
  const map = (walls: number[][]) => ({ width: 1500, height: 1500, grid: 150, walls: walls.map((c) => ({ c, move: 1, sense: 1, sound: 1 })) });
  const wall = [[300, 300, 900, 300]];
  const files = filesOfMap('Tower_00.json', [
    { name: 'Tower_00.json' }, { name: 'Tower_00.webp' }, { name: 'Tower_01.json' }, { name: 'Tower_01.png' },
    { name: 'Tower_02.json' }, { name: 'Other_00.json' },
  ])!;
  assert.deepEqual(files.levels.map((l) => [l.number, l.image?.name ?? null]), [[0, 'Tower_00.webp'], [1, 'Tower_01.png'], [2, null]]);
  let id = 0;
  const built = buildScene(
    [
      { number: 0, map: map(wall), image: 'a.webp' },
      { number: 1, map: map(wall), image: 'b.webp' },
      { number: 2, map: { width: 1500, height: 1500, grid: 150 }, image: 'c.webp' },
    ],
    {
      sceneName: 'Tower', firstLevel: -1, levelHeight: 10, newId: () => `L${id++}`, levelName: (n, roof) => (roof ? 'Roof' : `L${n}`),
      constants: { senseNone: 0, senseLimited: 10, senseNormal: 20, moveNone: 0, moveNormal: 20, fade: 1 },
      scope: 'kaiserkram', outlineName: (l) => l, roofName: 'Roof area',
    },
  );
  const levels = (built.data as Doc).levels as Doc[];
  assert.deepEqual(levels.map((l) => [l.name, l.elevation.bottom, l.elevation.top]), [['L-1', -10, 0], ['L0', 0, 10], ['Roof', 10, 20]]);
  assert.equal((built.data as Doc).initialLevel, built.levels[1].id, 'opens on the ground floor');
});

// --- Metric, doors, damage preview -------------------------------------------------------------
await test('imperial units read as metric', () => {
  const cases: [string, string][] = [
    ['Range: 24 yds', 'Range: 24 m'], ['Willpower yards', 'Willpower metres'], ['Yards', 'Metres'], ['1 yard', '1 metre'],
    ['6 feet tall', '1.8 m tall'], ['30ft', '9m'], ['a 10-foot pole', 'a 3-m pole'], ['At your feet', 'At your feet'],
    ['40 miles', '64 km'], ['12 inches', '30 cm'], ['24 yds - 48 yds: -10', '24 m - 48 m: -10'],
    ['backyard', 'backyard'], ['the yardarm', 'the yardarm'], ['1,5 miles', '2.4 km'],
  ];
  for (const [text, metric] of cases) assert.equal(toMetric(text), metric, text);
});

await test('door reach measured to the nearest point of the door', () => {
  assert.equal(distanceToSegment({ x: 0, y: 5 }, { x: -10, y: 0 }, { x: 10, y: 0 }), 5);
  assert.equal(distanceToSegment({ x: 13, y: 4 }, { x: -10, y: 0 }, { x: 10, y: 0 }), 5, 'past the end: to the end');
});

await test('expected wounds and a critical below zero', () => {
  assert.deepEqual(previewDamage(10, 3, 2, 12, 12), { loss: 5, after: 7, max: 12, critical: 0 });
  assert.deepEqual(previewDamage(4, 3, 2, 12, 12), { loss: 1, after: 11, max: 12, critical: 0 }, 'at least 1');
  assert.deepEqual(previewDamage(12, 3, 0, 4, 12), { loss: 9, after: -5, max: 12, critical: 50 });
});

await test('a feet export becomes a metre scene with Metric Units', () => {
  let id = 0;
  const built = buildScene(
    [{ number: 0, map: { width: 1500, height: 1500, grid: 150, gridDistance: 5, gridUnits: 'ft', lights: [{ x: 1, y: 1, dim: 20, bright: 10 }] }, image: 'a.webp' }],
    {
      sceneName: 'M', firstLevel: 0, levelHeight: 3, newId: () => `L${id++}`, levelName: () => 'L',
      constants: { senseNone: 0, senseLimited: 10, senseNormal: 20, moveNone: 0, moveNormal: 20, fade: 1 },
      scope: 'kaiserkram', outlineName: (l) => l, roofName: 'Roof', units: { scale: 0.3, name: 'm' },
    },
  );
  const data = built.data as Doc;
  assert.deepEqual([data.grid.distance, data.grid.units], [1.5, 'm']);
  assert.deepEqual([data.lights[0].config.dim, data.lights[0].config.bright], [6, 3]);
});

console.log(`[kaiserkram] unit: ${passed} passed`);
