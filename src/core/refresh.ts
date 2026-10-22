import { on } from './foundryApi.js';

/**
 * Refresh open windows only for the actors they show. Collects the uuids of actors whose items
 * (and, if asked, whose own data) changed, then calls `refresh` once with all of them, shortly
 * after the last change. A purchase or a trade touches several documents in a row; this turns
 * that into one redraw, and a change to anyone else into none.
 */
export function onActorChanges(
  refresh: (changed: Set<string>) => void,
  options: { actors?: boolean; wait?: number } = {},
): void {
  let changed = new Set<string>();
  const flush = foundry.utils.debounce(() => {
    const batch = changed;
    changed = new Set();
    refresh(batch);
  }, options.wait ?? 100);
  const note = (uuid: string | undefined) => {
    if (!uuid) return;
    changed.add(uuid);
    flush();
  };
  const fromItem = (item: { parent?: { uuid?: string; documentName?: string } | null }) => {
    if (item.parent?.documentName === 'Actor') note(item.parent.uuid);
  };
  for (const hook of ['createItem', 'updateItem', 'deleteItem']) on(hook, fromItem as (...args: never[]) => unknown);
  if (options.actors) on('updateActor', ((actor: { uuid?: string }) => note(actor.uuid)) as (...args: never[]) => unknown);
}
