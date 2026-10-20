import { dialogV2, escapeHtml } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { getAskReason } from './settings.js';
import { adjust, type HolderLike, type Kind, type TargetLike } from './store.js';

/**
 * Change a point from any of the UIs. Adding one asks for a reason when this user turned that
 * on (unless one was typed already); a blank reason still adds the point, Cancel doesn't.
 * Returns whether anything was changed.
 */
export async function changePoint(
  holder: HolderLike,
  target: TargetLike,
  kind: Kind,
  delta: 1 | -1,
  reason = '',
): Promise<boolean> {
  if (delta > 0 && !reason.trim() && getAskReason()) {
    const asked = await askReason(holder, target, kind);
    if (asked === null) return false;
    reason = asked;
  }
  await adjust(holder, target, kind, delta, reason);
  return true;
}

async function askReason(holder: HolderLike, target: TargetLike, kind: Kind): Promise<string | null> {
  const vars = { holder: holder.name, target: target.name };
  const question =
    kind === 'good'
      ? fmt('kaiserkram.grudges.askFavour', 'Why does {holder} owe {target} a favour?', vars)
      : fmt('kaiserkram.grudges.askGrudge', 'Why does {holder} hold a grudge against {target}?', vars);
  const result = await dialogV2().wait({
    window: {
      title: kind === 'good' ? loc('kaiserkram.grudges.favour', 'Favour') : loc('kaiserkram.grudges.grudge', 'Grudge'),
      icon: kind === 'good' ? 'fa-solid fa-thumbs-up' : 'fa-solid fa-thumbs-down',
    },
    content: `<p>${escapeHtml(question)}</p>
      <input type="text" name="reason" autofocus placeholder="${escapeHtml(loc('kaiserkram.grudges.reason', 'Reason (optional)'))}" />`,
    rejectClose: false,
    buttons: [
      {
        action: 'add',
        label: loc('kaiserkram.grudges.add', 'Add'),
        icon: 'fa-solid fa-plus',
        default: true,
        // Wrapped, so a reason can't be mistaken for the Cancel button's action name.
        callback: (_event: unknown, button: { form: HTMLFormElement }) => ({
          reason: (button.form.elements.namedItem('reason') as HTMLInputElement | null)?.value ?? '',
        }),
      },
      { action: 'cancel', label: loc('kaiserkram.party.trade.cancel', 'Cancel') },
    ],
  });
  return result && typeof result === 'object' ? String((result as { reason: string }).reason) : null;
}
