import { formatBP, priceToBP } from './money.js';

/**
 * Goods the GM can stock a trader with: the Trappings folder of the Core Rulebook's Items
 * compendium (wfrp4e-core), grouped by its subfolders. Without that folder, every physical
 * item in the core packs; without the core module, the physical items of any WFRP4e pack.
 * Read once per session; compendiums don't change during play.
 */

export type CatalogEntry = { uuid: string; name: string; img: string; price: string; category: string };
export type Catalog = { source: string; categories: { name: string; items: CatalogEntry[] }[] };

type IndexEntry = {
  _id: string;
  uuid?: string;
  name: string;
  type: string;
  img?: string;
  folder?: string | null;
  system?: { price?: { gc?: unknown; ss?: unknown; bp?: unknown } };
};
type FolderLike = { id: string; name: string; folder?: { id: string } | string | null };
type Pack = {
  collection: string;
  documentName: string;
  title?: string;
  metadata?: { packageName?: string; system?: string | string[]; label?: string };
  folders?: { contents?: FolderLike[] } | FolderLike[];
  getIndex(o: { fields: string[] }): Promise<Iterable<IndexEntry>>;
};

const PHYSICAL = new Set(['trapping', 'weapon', 'armour', 'ammunition', 'container', 'cargo']);
const TRAPPINGS = /^trappings$/i;

let cached: Promise<Catalog> | null = null;

function packs(): Pack[] {
  return [...((game as unknown as { packs: Iterable<Pack> }).packs ?? [])].filter((p) => p.documentName === 'Item');
}

function foldersOf(pack: Pack): FolderLike[] {
  const f = pack.folders;
  return Array.isArray(f) ? f : [...(f?.contents ?? [])];
}

function parentId(folder: FolderLike): string | null {
  const p = folder.folder;
  return typeof p === 'string' ? p : (p?.id ?? null);
}

/** Folder id → the name of its top folder below "Trappings" (the category), for that folder's tree. */
function trappingFolders(pack: Pack): Map<string, string> | null {
  const folders = foldersOf(pack);
  const root = folders.find((f) => TRAPPINGS.test(f.name.trim()));
  if (!root) return null;
  const byId = new Map(folders.map((f) => [f.id, f]));
  const result = new Map<string, string>([[root.id, root.name]]);
  for (const f of folders) {
    // Walk up to the root; the folder right below it names the category.
    let node: FolderLike | undefined = f;
    let below: FolderLike = f;
    while (node && node.id !== root.id) {
      below = node;
      const up = parentId(node);
      node = up ? byId.get(up) : undefined;
    }
    if (node) result.set(f.id, below.id === root.id ? root.name : below.name);
  }
  return result;
}

function entryOf(pack: Pack, e: IndexEntry, category: string): CatalogEntry {
  return {
    uuid: e.uuid ?? `Compendium.${pack.collection}.Item.${e._id}`,
    name: e.name,
    img: e.img ?? 'icons/svg/item-bag.svg',
    price: formatBP(priceToBP(e.system?.price)),
    category,
  };
}

function isWfrpPack(pack: Pack): boolean {
  const system = pack.metadata?.system;
  const id = pack.metadata?.packageName ?? pack.collection.split('.')[0];
  return id.startsWith('wfrp4e') || system === 'wfrp4e' || (Array.isArray(system) && system.includes('wfrp4e'));
}

async function build(): Promise<Catalog> {
  const fields = ['img', 'type', 'folder', 'system.price'];
  const core = packs().filter((p) => p.collection.startsWith('wfrp4e-core.'));

  // The Trappings folder of the core Items pack.
  const found: CatalogEntry[] = [];
  let source = '';
  for (const pack of core) {
    const folders = trappingFolders(pack);
    if (!folders) continue;
    for (const e of await pack.getIndex({ fields })) {
      const category = e.folder ? folders.get(e.folder) : undefined;
      if (category && PHYSICAL.has(e.type)) found.push(entryOf(pack, e, category));
    }
    source = pack.title ?? pack.metadata?.label ?? pack.collection;
  }

  // Otherwise: every physical item in the core packs, or in any WFRP4e pack.
  if (!found.length) {
    const fallback = core.length ? core : packs().filter(isWfrpPack);
    for (const pack of fallback) {
      for (const e of await pack.getIndex({ fields })) {
        if (PHYSICAL.has(e.type)) found.push(entryOf(pack, e, e.type.charAt(0).toUpperCase() + e.type.slice(1)));
      }
    }
    source = fallback.map((p) => p.title ?? p.collection).join(', ');
  }

  const seen = new Set<string>();
  const groups = new Map<string, CatalogEntry[]>();
  for (const entry of found.sort((a, b) => a.name.localeCompare(b.name))) {
    const key = `${entry.category}|${entry.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    (groups.get(entry.category) ?? groups.set(entry.category, []).get(entry.category)!).push(entry);
  }
  const categories = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, items]) => ({ name, items }));
  return { source, categories };
}

export function loadCatalog(): Promise<Catalog> {
  cached ??= build()
    .catch((err) => {
      console.warn('[kaiserkram] trader: could not read the trappings catalog', err);
      return { source: '', categories: [] } as Catalog;
    })
    .then((catalog) => {
      // Nothing found (no compendium yet, or an error): look again next time.
      if (!catalog.categories.length) cached = null;
      return catalog;
    });
  return cached;
}
