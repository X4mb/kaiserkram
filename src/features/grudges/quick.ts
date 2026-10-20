import { MODULE_ID } from '../../core/constants.js';
import { escapeHtml } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { defaultHolder, holderChoices, resolveHolder } from './people.js';
import { changePoint } from './points.js';
import { chanceOf, decide, relationTo, type HolderLike, type Kind, type TargetLike } from './store.js';

/**
 * The small window right-click opens: what one holder feels about one target, with +/- for
 * favour and grudge, the odds, and the decision roll.
 */

type AppInstance = {
  element: HTMLElement;
  rendered: boolean;
  render(options?: unknown): Promise<unknown>;
  close(options?: unknown): Promise<unknown>;
  bringToFront?(): void;
};
type AppCtor = new (options?: Record<string, unknown>) => AppInstance;
type QuickWindow = AppInstance & { target: TargetLike; holderUuid: string | null; reason: string };

const windows = new Map<string, QuickWindow>();
let QuickClass: (new (target: TargetLike) => QuickWindow) | undefined;
let openTracker: () => void = () => {};

export function setTrackerOpener(fn: () => void): void {
  openTracker = fn;
}

function holderOf(win: QuickWindow): HolderLike | null {
  const holder = resolveHolder(win.holderUuid);
  return holder && holderChoices(win.target).some((c) => c.uuid === holder.uuid) ? holder : null;
}

function render(win: QuickWindow): string {
  const choices = holderChoices(win.target);
  const holder = holderOf(win);
  const rel = holder ? relationTo(holder, win.target.uuid) : undefined;
  const chance = chanceOf(rel);
  const disabled = holder ? '' : 'disabled';
  const options = choices
    .map((c) => `<option value="${escapeHtml(c.uuid)}" ${c.uuid === holder?.uuid ? 'selected' : ''}>${escapeHtml(c.name)}</option>`)
    .join('');
  const row = (kind: Kind, icon: string, label: string) => `
    <div class="kk-grudge-row ${kind}">
      <span class="label"><i class="fa-solid ${icon}"></i> ${escapeHtml(label)}</span>
      <button type="button" data-action="change" data-kind="${kind}" data-delta="-1" ${disabled}><i class="fa-solid fa-minus"></i></button>
      <span class="count">${rel?.[kind] ?? 0}</span>
      <button type="button" data-action="change" data-kind="${kind}" data-delta="1" ${disabled}><i class="fa-solid fa-plus"></i></button>
    </div>`;
  return `<div class="kk-grudge-quick">
    <div class="kk-grudge-who">
      <select data-holder>
        ${holder ? '' : `<option value="" selected>${escapeHtml(loc('kaiserkram.grudges.pickHolder', 'Who feels this way?'))}</option>`}
        ${options}
      </select>
      <i class="fa-solid fa-arrow-right"></i>
      <span class="target"><img src="${escapeHtml(win.target.img)}" alt="" /> ${escapeHtml(win.target.name)}</span>
    </div>
    ${choices.length ? '' : `<p class="hint">${escapeHtml(loc('kaiserkram.grudges.noHolder', 'You have no character to hold a grudge with.'))}</p>`}
    ${row('good', 'fa-thumbs-up', loc('kaiserkram.grudges.favour', 'Favour'))}
    ${row('bad', 'fa-thumbs-down', loc('kaiserkram.grudges.grudge', 'Grudge'))}
    <div class="kk-grudge-chance" style="--chance: ${chance}%">
      <span>${escapeHtml(fmt('kaiserkram.grudges.chance', '{chance}% in their favour', { chance }))}</span>
    </div>
    <input type="text" data-reason value="${escapeHtml(win.reason)}" placeholder="${escapeHtml(loc('kaiserkram.grudges.reason', 'Reason (optional)'))}" />
    <footer>
      <button type="button" data-action="roll" ${disabled}><i class="fa-solid fa-dice-d20"></i> ${escapeHtml(loc('kaiserkram.grudges.decide', 'Decide'))}</button>
      <button type="button" data-action="tracker"><i class="fa-solid fa-book"></i> ${escapeHtml(loc('kaiserkram.grudges.tracker', 'Grudges'))}</button>
    </footer>
  </div>`;
}

function quickClass(): new (target: TargetLike) => QuickWindow {
  if (QuickClass) return QuickClass;
  const Base = (foundry.applications.api as unknown as { ApplicationV2: AppCtor }).ApplicationV2;

  class GrudgeQuick extends Base {
    target: TargetLike;
    holderUuid: string | null;
    reason = '';

    static DEFAULT_OPTIONS = {
      classes: [`${MODULE_ID}-grudge-quick`],
      position: { width: 340, height: 'auto' },
      window: { icon: 'fa-solid fa-scale-unbalanced' },
      actions: { change: GrudgeQuick.onChange, roll: GrudgeQuick.onRoll, tracker: () => openTracker() },
    };

    constructor(target: TargetLike) {
      super({ id: `${MODULE_ID}-grudge-${target.uuid.replace(/\W/g, '-')}` });
      this.target = target;
      this.holderUuid = defaultHolder(target)?.uuid ?? null;
    }

    get title(): string {
      return fmt('kaiserkram.grudges.quickTitle', 'Feelings about {name}', { name: this.target.name });
    }

    async _renderHTML(): Promise<string> {
      return render(this as unknown as QuickWindow);
    }

    _replaceHTML(result: string, content: HTMLElement): void {
      content.innerHTML = result;
      const win = this as unknown as QuickWindow;
      content.querySelector<HTMLSelectElement>('select[data-holder]')?.addEventListener('change', (ev) => {
        win.holderUuid = (ev.currentTarget as HTMLSelectElement).value || null;
        void win.render();
      });
      content.querySelector<HTMLInputElement>('input[data-reason]')?.addEventListener('input', (ev) => {
        win.reason = (ev.currentTarget as HTMLInputElement).value;
      });
    }

    static async onChange(this: QuickWindow, _event: Event, target: HTMLElement): Promise<void> {
      const holder = holderOf(this);
      if (!holder) return;
      const kind = target.dataset.kind as Kind;
      const delta = Number(target.dataset.delta) < 0 ? -1 : 1;
      if (!(await changePoint(holder, this.target, kind, delta, this.reason))) return;
      this.reason = '';
      void this.render();
    }

    static async onRoll(this: QuickWindow): Promise<void> {
      const holder = holderOf(this);
      if (holder) await decide(holder, this.target);
    }

    async close(options?: unknown): Promise<unknown> {
      windows.delete(this.target.uuid);
      return super.close(options);
    }
  }

  QuickClass = GrudgeQuick as unknown as new (target: TargetLike) => QuickWindow;
  return QuickClass;
}

export function openQuick(target: TargetLike): void {
  let win = windows.get(target.uuid);
  if (!win) {
    win = new (quickClass())(target);
    windows.set(target.uuid, win);
  }
  void win.render({ force: true });
  win.bringToFront?.();
}

export function refreshQuickWindows(): void {
  for (const win of windows.values()) if (win.rendered) void win.render();
}
