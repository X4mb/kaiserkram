import type { HolderLike, TargetLike } from './store.js';

/**
 * Who can hold feelings, and about whom. A player's holders are the actors they own (the party
 * marker's shared actor aside); the GM's are everyone on the scene plus every player character.
 */

export type TokenLike = {
  id: string;
  name: string;
  actor?: (HolderLike & { type?: string; hasPlayerOwner?: boolean }) | null;
  document?: { texture?: { src?: string } };
};

type ActorEntry = HolderLike & { type?: string; hasPlayerOwner?: boolean };

function isPartyMarkerActor(actor: HolderLike): boolean {
  return Boolean(actor.getFlag('kaiserkram', 'party.markerActorFor'));
}

function sceneTokens(): TokenLike[] {
  return (canvas as unknown as { tokens?: { placeables: TokenLike[] } } | null)?.tokens?.placeables ?? [];
}

function controlledTokens(): TokenLike[] {
  return (canvas as unknown as { tokens?: { controlled: TokenLike[] } } | null)?.tokens?.controlled ?? [];
}

/** A token as someone feelings can be about: its actor's uuid (the token's, for unlinked NPCs). */
export function targetOf(token: TokenLike): TargetLike | null {
  const actor = token.actor;
  if (!actor) return null;
  return { uuid: actor.uuid, name: token.name || actor.name, img: token.document?.texture?.src || actor.img };
}

/** Everyone this user may record feelings for, other than `target`. */
export function holderChoices(target?: TargetLike | null): HolderLike[] {
  const seen = new Set<string>();
  const out: HolderLike[] = [];
  const add = (a: HolderLike | null | undefined) => {
    if (!a || seen.has(a.uuid) || a.uuid === target?.uuid || isPartyMarkerActor(a)) return;
    seen.add(a.uuid);
    out.push(a);
  };
  const actors = (game.actors as unknown as { contents: ActorEntry[] }).contents;
  if (game.user?.isGM) {
    for (const t of sceneTokens()) add(t.actor);
    for (const a of actors) if (a.type === 'character' && a.hasPlayerOwner) add(a);
  } else {
    for (const a of actors) if (a.isOwner) add(a);
  }
  return out;
}

/** Whose feelings a quick change is about: a selected token of yours, else your character. */
export function defaultHolder(target?: TargetLike | null): HolderLike | null {
  const choices = holderChoices(target);
  const allowed = new Set(choices.map((c) => c.uuid));
  const selected = controlledTokens()
    .map((t) => t.actor)
    .find((a) => a && allowed.has(a.uuid));
  if (selected) return selected;
  if (game.user?.isGM) return null; // The GM picks; guessing would put feelings on the wrong NPC.
  const character = (game.user as unknown as { character?: HolderLike | null }).character;
  return (character && choices.find((c) => c.uuid === character.uuid)) ?? choices[0] ?? null;
}

/** Holders whose relations this user may see in the tracker. */
export function visibleHolders(): HolderLike[] {
  const actors = (game.actors as unknown as { contents: ActorEntry[] }).contents;
  const seen = new Set<string>();
  const out: HolderLike[] = [];
  const add = (a: HolderLike | null | undefined) => {
    if (!a || seen.has(a.uuid) || isPartyMarkerActor(a)) return;
    seen.add(a.uuid);
    out.push(a);
  };
  if (game.user?.isGM) {
    for (const a of actors) add(a);
    // Unlinked NPCs keep theirs on the token: those on the scene being viewed.
    for (const t of sceneTokens()) add(t.actor);
  } else {
    for (const a of actors) if (a.isOwner) add(a);
  }
  return out;
}

export function resolveHolder(uuid: string | null | undefined): HolderLike | null {
  if (!uuid) return null;
  const fromUuidSync = (foundry.utils as unknown as { fromUuidSync(u: string): unknown }).fromUuidSync;
  try {
    const doc = fromUuidSync(uuid) as (HolderLike & { documentName?: string }) | null;
    return doc?.documentName === 'Actor' ? doc : null;
  } catch {
    return null;
  }
}
