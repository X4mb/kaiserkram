import { MODULE_ID } from '../../core/constants.js';
import { escapeHtml } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { resolveHolder, visibleHolders } from './people.js';
import { changePoint } from './points.js';
import { chanceOf, decide, forget, relationsOf, type HolderLike, type Kind, type Relation } from './store.js';

/**
 * Every grudge and favour this user may see: the GM's are everyone's, a player's those their own
 * characters hold. Grouped by who holds them, with the same +/- and roll as the quick window.
 */

type AppInstance = {
  element: HTMLElement;
  rendered: boolean;
  render(options?: unknown): Promise<unknown>;
  close(options?: unknown): Promise<unknown>;
  bringToFront?(): void;
};
type AppCtor = new (options?: Record<string, unknown>) => AppInstance;
type TrackerWindow = AppInstance & { filter: string };

let instance: TrackerWindow | null = null;

/**
 * Who a feeling is about, as the viewer should see them. Players get the name and picture they
 * saw on the token when they set it (a "Hooded Stranger" stays one); the GM sees the actor as it
 * is now.
 */
function targetOfRelation(rel: Relation): { uuid: string; name: string; img: string } {
  if (!game.user?.isGM) return { uuid: rel.target, name: rel.name, img: rel.img };
  const live = resolveHolder(rel.target);
  return { uuid: rel.target, name: live?.name ?? rel.name, img: live?.img ?? rel.img };
}

function logLine(e: Relation['log'][number]): string {
  const sign = e.delta > 0 ? '+1' : '−1';
  const what = e.kind === 'good' ? loc('kaiserkram.grudges.favour', 'Favour') : loc('kaiserkram.grudges.grudge', 'Grudge');
  const when = new Date(e.at).toLocaleDateString();
  return `<li>${escapeHtml(`${sign} ${what}`)}${e.reason ? ` — ${escapeHtml(e.reason)}` : ''} <span class="hint">${escapeHtml(`${e.by}, ${when}`)}</span></li>`;
}

/** The most recent reason given for this relation, if any. */
function latestReason(rel: Relation): string | undefined {
  return rel.log.find((e) => e.delta > 0 && e.reason)?.reason;
}

function relationRow(holder: HolderLike, rel: Relation): string {
  const target = targetOfRelation(rel);
  const chance = chanceOf(rel);
  const counter = (kind: Kind, icon: string) => `
    <span class="kk-grudge-count ${kind}">
      <button type="button" data-action="change" data-kind="${kind}" data-delta="-1"><i class="fa-solid fa-minus"></i></button>
      <i class="fa-solid ${icon}"></i> ${rel[kind]}
      <button type="button" data-action="change" data-kind="${kind}" data-delta="1"><i class="fa-solid fa-plus"></i></button>
    </span>`;
  const reason = latestReason(rel);
  return `<li class="kk-grudge-relation" data-holder="${escapeHtml(holder.uuid)}" data-target="${escapeHtml(rel.target)}"
      data-search="${escapeHtml(`${holder.name} ${target.name}`.toLowerCase())}">
    <div class="kk-grudge-line">
      <img src="${escapeHtml(target.img)}" alt="" />
      <span class="name">${escapeHtml(target.name)}${
        reason ? `<small class="reason">${escapeHtml(reason)}</small>` : ''
      }</span>
      ${counter('good', 'fa-thumbs-up')}
      ${counter('bad', 'fa-thumbs-down')}
      <span class="kk-grudge-pct" data-tooltip="${escapeHtml(loc('kaiserkram.grudges.chanceHint', 'Chance a decision goes their way'))}">${chance}%</span>
      <button type="button" data-action="roll" data-tooltip="${escapeHtml(loc('kaiserkram.grudges.decide', 'Decide'))}"><i class="fa-solid fa-dice-d20"></i></button>
      <button type="button" data-action="forget" data-tooltip="${escapeHtml(loc('kaiserkram.grudges.forget', 'Forget'))}"><i class="fa-solid fa-trash"></i></button>
    </div>
    ${rel.log.length ? `<details><summary>${escapeHtml(loc('kaiserkram.grudges.history', 'History'))}</summary><ul class="kk-grudge-log">${rel.log.map(logLine).join('')}</ul></details>` : ''}
  </li>`;
}

function render(win: TrackerWindow): string {
  const sections = visibleHolders()
    .map((holder) => ({ holder, relations: relationsOf(holder) }))
    .filter((s) => s.relations.length)
    .sort((a, b) => a.holder.name.localeCompare(b.holder.name))
    .map(
      ({ holder, relations }) => `<section class="kk-grudge-holder">
        <h3><img src="${escapeHtml(holder.img)}" alt="" /> ${escapeHtml(holder.name)}</h3>
        <ul>${relations
          .sort((a, b) => targetOfRelation(a).name.localeCompare(targetOfRelation(b).name))
          .map((r) => relationRow(holder, r))
          .join('')}</ul>
      </section>`,
    )
    .join('');
  return `<div class="kk-grudge-tracker">
    <input type="search" data-filter value="${escapeHtml(win.filter)}" placeholder="${escapeHtml(loc('kaiserkram.grudges.search', 'Search names…'))}" />
    ${
      sections ||
      `<p class="hint">${escapeHtml(
        game.user?.isGM
          ? loc('kaiserkram.grudges.emptyGM', 'No grudges yet. Right-click a token and use the scales on its HUD to add one.')
          : loc('kaiserkram.grudges.empty', "You don't hold any grudges or favours yet. Right-click someone else's token to add one."),
      )}</p>`
    }
  </div>`;
}

function applyFilter(root: HTMLElement, filter: string): void {
  const q = filter.trim().toLowerCase();
  root.querySelectorAll<HTMLElement>('.kk-grudge-relation').forEach((row) => {
    row.hidden = !!q && !(row.dataset.search ?? '').includes(q);
  });
  root.querySelectorAll<HTMLElement>('.kk-grudge-holder').forEach((section) => {
    section.hidden = !section.querySelector('.kk-grudge-relation:not([hidden])');
  });
}

function rowParties(target: HTMLElement): { holder: HolderLike; rel: Relation } | null {
  const row = target.closest<HTMLElement>('.kk-grudge-relation');
  const holder = resolveHolder(row?.dataset.holder);
  const rel = holder ? relationsOf(holder).find((r) => r.target === row?.dataset.target) : undefined;
  return holder && rel && holder.isOwner ? { holder, rel } : null;
}

function trackerClass(): new () => TrackerWindow {
  const Base = (foundry.applications.api as unknown as { ApplicationV2: AppCtor }).ApplicationV2;

  class GrudgeTracker extends Base {
    filter = '';

    static DEFAULT_OPTIONS = {
      id: `${MODULE_ID}-grudges`,
      classes: [`${MODULE_ID}-grudges`],
      position: { width: 560, height: 'auto' },
      window: { icon: 'fa-solid fa-scale-unbalanced', resizable: true },
      actions: { change: GrudgeTracker.onChange, roll: GrudgeTracker.onRoll, forget: GrudgeTracker.onForget },
    };

    get title(): string {
      return loc('kaiserkram.grudges.trackerTitle', 'Grudges and favours');
    }

    async _renderHTML(): Promise<string> {
      return render(this as unknown as TrackerWindow);
    }

    _replaceHTML(result: string, content: HTMLElement): void {
      content.innerHTML = result;
      const win = this as unknown as TrackerWindow;
      content.querySelector<HTMLInputElement>('input[data-filter]')?.addEventListener('input', (ev) => {
        win.filter = (ev.currentTarget as HTMLInputElement).value;
        applyFilter(content, win.filter);
      });
      applyFilter(content, win.filter);
    }

    static async onChange(this: TrackerWindow, _event: Event, target: HTMLElement): Promise<void> {
      const parties = rowParties(target);
      if (!parties) return;
      const delta = Number(target.dataset.delta) < 0 ? -1 : 1;
      await changePoint(parties.holder, targetOfRelation(parties.rel), target.dataset.kind as Kind, delta);
    }

    static async onRoll(this: TrackerWindow, _event: Event, target: HTMLElement): Promise<void> {
      const parties = rowParties(target);
      if (parties) await decide(parties.holder, targetOfRelation(parties.rel));
    }

    static async onForget(this: TrackerWindow, _event: Event, target: HTMLElement): Promise<void> {
      const parties = rowParties(target);
      if (!parties) return;
      const ok = await (foundry.applications.api as unknown as {
        DialogV2: { confirm(o: Record<string, unknown>): Promise<boolean | null> };
      }).DialogV2.confirm({
        window: { title: loc('kaiserkram.grudges.forget', 'Forget') },
        content: `<p>${escapeHtml(
          fmt('kaiserkram.grudges.forgetConfirm', 'Forget what {holder} feels about {target}?', {
            holder: parties.holder.name,
            target: targetOfRelation(parties.rel).name,
          }),
        )}</p>`,
        rejectClose: false,
      });
      if (ok) await forget(parties.holder, parties.rel.target);
    }

    async close(options?: unknown): Promise<unknown> {
      instance = null;
      return super.close(options);
    }
  }

  return GrudgeTracker as unknown as new () => TrackerWindow;
}

export function openTracker(): void {
  instance ??= new (trackerClass())();
  void instance.render({ force: true });
  instance.bringToFront?.();
}

export function isTrackerOpen(): boolean {
  return !!instance?.rendered;
}

export function refreshTracker(): void {
  if (instance?.rendered) void instance.render();
}
