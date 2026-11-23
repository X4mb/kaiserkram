import type { Feature } from '../../core/feature.js';
import { escapeHtml, on, toElement } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';

/**
 * On a WFRP4e opposed-test result, before anyone presses Apply Damage: what the hit will cost the
 * defender and where that leaves them, so the player can decide whether to spend something first.
 * Only for the defender's owners and the GM.
 *
 * The same sum WFRP4e makes when damage is applied: damage, less Toughness Bonus and the armour
 * at the hit location, at least 1. What it leaves out is said on the card: talents, traits and
 * weapon qualities change damage through scripts that can't be run without applying it (and a
 * Ward is a roll).
 */

type ActorLike = {
  isOwner: boolean;
  system: {
    characteristics: { t: { bonus: number } };
    status: { wounds: { value: number; max: number }; armour?: Record<string, { value?: number }> };
  };
};
type OpposedTest = {
  defender?: ActorLike | null;
  result: { damage?: { value?: unknown }; hitloc?: { value?: string }; confirmation?: unknown };
};
type MessageLike = { type?: string; system?: { opposedTest?: OpposedTest } };

export type Preview = { loss: number; after: number; max: number; critical: number };

/** The wounds a hit of `damage` costs, and what is left: WFRP4e's sum without talents and qualities. */
export function previewDamage(damage: number, toughnessBonus: number, armour: number, wounds: number, max: number): Preview {
  const loss = Math.max(1, damage - toughnessBonus - armour);
  const after = wounds - loss;
  // Below 0 Wounds is a Critical Wound, +10 to the roll for every Wound beyond.
  return { loss, after, max, critical: after < 0 ? -after * 10 : 0 };
}

function onRender(message: MessageLike, html: unknown): void {
  if (message.type !== 'opposed') return;
  const root = toElement(html);
  const card = root?.querySelector('.opposed-card');
  if (!card || card.querySelector('.kk-damage-preview')) return;
  let test: OpposedTest | undefined;
  try {
    test = message.system?.opposedTest;
  } catch {
    return;
  }
  const defender = test?.defender;
  const damage = Number(test?.result.damage?.value);
  // Nothing to foresee: no damage, already applied, or not this viewer's to see.
  if (!test || !defender || !Number.isFinite(damage) || test.result.confirmation) return;
  if (!game.user?.isGM && !defender.isOwner) return;

  const location = test.result.hitloc?.value ?? 'body';
  const { status, characteristics } = defender.system;
  const p = previewDamage(damage, characteristics.t.bonus, Number(status.armour?.[location]?.value) || 0, status.wounds.value, status.wounds.max);
  const line = document.createElement('div');
  line.className = 'kk-damage-preview';
  line.innerHTML = `<i class="fa-solid fa-heart-crack"></i> ${escapeHtml(
    fmt('kaiserkram.damagePreview.line', 'Expected: −{loss} Wounds → {after}/{max}', p),
  )}${
    p.critical
      ? ` <strong>${escapeHtml(fmt('kaiserkram.damagePreview.critical', 'Critical Wound +{critical}', p))}</strong>`
      : ''
  } <span class="hint" data-tooltip="${escapeHtml(
    loc('kaiserkram.damagePreview.hint', 'Damage less Toughness Bonus and armour at the hit location (at least 1). Talents, traits, weapon qualities and Ward can still change it.'),
  )}"><i class="fa-solid fa-circle-info"></i></span>`;
  // Under the damage line, above the Apply Damage button.
  const damageRow = card.querySelector('.opposed-breakdown')?.parentElement ?? card.children[1] ?? null;
  if (damageRow) damageRow.after(line);
  else card.append(line);
}

export const damagePreview: Feature = {
  id: 'damagePreview',
  group: 'wfrp4e',
  systems: ['wfrp4e'],

  init() {
    on('renderChatMessageHTML', onRender as (...args: never[]) => unknown);
  },
};
