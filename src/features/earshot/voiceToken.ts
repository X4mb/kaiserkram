import { MODULE_ID } from '../../core/constants.js';
import { flags, notify } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { FLAGS } from './constants.js';
import { firstOwnedTokenDoc } from './proximity.js';
import { voiceChangerProcessor } from './voiceChangerProcessor.js';
import { getVoiceProfileForActor } from './voiceProfile.js';

export function canUserPickVoiceToken(user: User, token: Token): boolean {
  if (user.isGM) return true;
  return token.document.testUserPermission(user, 'OWNER');
}

export function getVoiceTokenIdFromUser(user: User): string | null {
  const v = flags(user).getFlag(MODULE_ID, FLAGS.VOICE_TOKEN_ID) as string | null | undefined;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Scene token document for this user’s voice position (explicit pin, else primary / sole-owned).
 * Uses embedded scene data so the speaker is still resolved when their token is **not visible**
 * to the current client (e.g. behind a wall). Proximity audio must not depend on `token.visible`.
 */
export function getSpeakerTokenDocumentForUser(remoteUser: User): TokenDocument | null {
  const pinId = getVoiceTokenIdFromUser(remoteUser);
  if (pinId && canvas?.scene) {
    const pinned = canvas.scene.tokens.get(pinId);
    if (pinned) return pinned;
  }

  if (!canvas?.scene) return null;

  const actor = remoteUser.character;
  if (actor) {
    const docs = Array.from(canvas.scene.tokens).filter((d) => d.actor?.id === actor.id);
    if (docs.length === 0) return null;
    const owned = docs.filter((d) => d.testUserPermission(remoteUser, 'OWNER'));
    const pool = owned.length > 0 ? owned : docs;
    pool.sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
    return pool[0] ?? null;
  }

  /** No assigned actor: the same token the listener side uses for them. */
  return firstOwnedTokenDoc(remoteUser);
}

/** Prefer {@link getSpeakerTokenDocumentForUser} when you need a position even if `visible` is false. */
export function getSpeakerTokenForUser(remoteUser: User): Token | null {
  const doc = getSpeakerTokenDocumentForUser(remoteUser);
  if (!doc || !canvas?.tokens) return null;
  const sid = doc.id;
  if (!sid) return null;
  return canvas.tokens.get(sid) ?? null;
}

/**
 * Token to draw the local voice ring on. GMs with no pinned voice token (shortcut cleared)
 * use omnipresent voice — no ring. Players always use {@link getSpeakerTokenForUser}.
 */
export function getVoiceSourceTokenForDisplay(user: User): Token | null {
  if (user.isGM && !getVoiceTokenIdFromUser(user)) return null;
  return getSpeakerTokenForUser(user);
}

/**
 * Clear the persisted voice-token pin only when it no longer resolves to any token in the world
 * (e.g. the token was deleted), so a valid pin survives a reload instead of being wiped every time.
 */
export async function clearVoiceTokenFlagForCurrentUser(): Promise<void> {
  const user = game.user;
  if (!user) return;
  const pinId = getVoiceTokenIdFromUser(user);
  if (!pinId) return;
  const stillExists = game.scenes?.some((scene) => scene.tokens.get(pinId) !== undefined) ?? false;
  if (stillExists) return;
  try {
    await flags(user).unsetFlag(MODULE_ID, FLAGS.VOICE_TOKEN_ID);
  } catch {
    /* ignore */
  }
}

export async function toggleVoiceTokenForCurrentUser(token: Token): Promise<void> {
  const user = game.user;
  if (!user) return;
  if (!canUserPickVoiceToken(user, token)) {
    ui.notifications?.warn(loc('kaiserkram.earshot.VOICE.cannotPick', 'You can only set your voice token to a token you own.'));
    return;
  }
  const current = getVoiceTokenIdFromUser(user);
  const next = current === token.id ? null : token.id;
  try {
    if (next === null) await flags(user).unsetFlag(MODULE_ID, FLAGS.VOICE_TOKEN_ID);
    else await flags(user).setFlag(MODULE_ID, FLAGS.VOICE_TOKEN_ID, next);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    notify().error(
      fmt('kaiserkram.earshot.VOICE.saveFailed', 'Within Earshot: could not save voice token ({error})', { error }),
    );
    return;
  }
  if (game.user?.isGM) {
    const actor = next !== null ? token.actor : null;
    const profile = actor ? getVoiceProfileForActor(actor) : null;
    void voiceChangerProcessor.applyProfile(profile).catch((err: unknown) => {
      notify().warn(
        fmt('kaiserkram.earshot.VOICE.cannotApplyProfile', 'Within Earshot: could not apply voice profile ({error})', {
          error: String(err),
        }),
      );
    });
  }

  const name = token.name ?? token.document.name;
  const msg =
    next === null
      ? loc('kaiserkram.earshot.VOICE.cleared', 'Voice position: automatic (assigned character token).')
      : fmt('kaiserkram.earshot.VOICE.set', 'Voice position: speaking as {name}.', { name });
  ui.notifications?.info(msg);
}
