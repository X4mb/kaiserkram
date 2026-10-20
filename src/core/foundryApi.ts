/**
 * Narrow, hand-written views of the Foundry API surface Kaiserkram touches.
 * The published `foundry-vtt-types` package doesn't know about module flag namespaces,
 * setting namespaces or several v14 APIs, so those calls go through here instead of
 * sprinkling `as unknown as X` casts through the feature code.
 */

export type SettingsApi = {
  register(namespace: string, key: string, data: Record<string, unknown>): void;
  registerMenu(namespace: string, key: string, data: Record<string, unknown>): void;
  get(namespace: string, key: string): unknown;
  set(namespace: string, key: string, value: unknown): Promise<unknown>;
};

export function settings(): SettingsApi {
  return game.settings as unknown as SettingsApi;
}

export type KeybindingsApi = {
  register(namespace: string, action: string, data: Record<string, unknown>): void;
};

export function keybindings(): KeybindingsApi {
  return game.keybindings as unknown as KeybindingsApi;
}

export type HookFn = (...args: never[]) => unknown;

/** `Hooks.on` for hook names and signatures the type package doesn't model. */
export function on(hook: string, fn: HookFn): number {
  return (Hooks as unknown as { on(hook: string, fn: HookFn): number }).on(hook, fn);
}

export type FlagHolder = {
  getFlag(scope: string, key: string): unknown;
  setFlag(scope: string, key: string, value: unknown): Promise<unknown>;
  unsetFlag(scope: string, key: string): Promise<unknown>;
};

export function flags(doc: unknown): FlagHolder {
  return doc as FlagHolder;
}

export type GameModule = { id: string; title: string; active: boolean; version?: string; api?: Record<string, unknown> };

export function moduleById(id: string): GameModule | undefined {
  return (game.modules as unknown as { get(id: string): GameModule | undefined } | undefined)?.get(id);
}

export function systemId(): string {
  return (game as unknown as { system?: { id?: string } }).system?.id ?? '';
}

export type Notifications = {
  info(message: string, options?: Record<string, unknown>): unknown;
  warn(message: string, options?: Record<string, unknown>): unknown;
  error(message: string, options?: Record<string, unknown>): unknown;
};

export function notify(): Notifications {
  return ui.notifications as unknown as Notifications;
}

export async function resolveDocument<T>(uuid: string): Promise<T | null> {
  return ((await foundry.utils.fromUuid(uuid)) as unknown as T) ?? null;
}

type ChatData = { content: string; speaker?: unknown; whisper?: string[]; rolls?: unknown[] };

type ChatMessageClass = {
  create(d: ChatData): Promise<unknown>;
  getSpeaker(o: { actor: unknown }): unknown;
};

function chatMessageClass(): ChatMessageClass {
  return (CONFIG as unknown as { ChatMessage: { documentClass: ChatMessageClass } }).ChatMessage.documentClass;
}

export async function postChat(data: ChatData): Promise<void> {
  await chatMessageClass().create(data);
}

export function speakerFor(actor: unknown): unknown {
  return chatMessageClass().getSpeaker({ actor });
}

/** Foundry's DialogV2, typed loosely enough to call from TS. */
export type DialogV2Api = {
  wait(config: Record<string, unknown>): Promise<unknown>;
  confirm(config: Record<string, unknown>): Promise<boolean | null>;
};

export function dialogV2(): DialogV2Api {
  return (foundry.applications.api as unknown as { DialogV2: DialogV2Api }).DialogV2;
}

export function renderTemplate(path: string, data: Record<string, unknown>): Promise<string> {
  const api = foundry.applications.handlebars as unknown as {
    renderTemplate(p: string, d: Record<string, unknown>): Promise<string>;
  };
  return api.renderTemplate(path, data);
}

export function loadTemplates(paths: string[]): Promise<unknown> {
  const api = foundry.applications.handlebars as unknown as { loadTemplates(p: string[]): Promise<unknown> };
  return api.loadTemplates(paths);
}

export function escapeHtml(text: string): string {
  return (
    (foundry.utils as unknown as { escapeHTML?(s: string): string }).escapeHTML?.(text) ??
    text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  );
}

/** `foundry.utils.expandObject`: turns `{ 'party.isPartyToken': true }` into `{ party: { isPartyToken: true } }`. */
export function expandObject(obj: Record<string, unknown>): Record<string, unknown> {
  return (foundry.utils as unknown as { expandObject(o: object): Record<string, unknown> }).expandObject(obj);
}

/** Accept either a bare HTMLElement or a jQuery-wrapped one (hook arguments vary by app version). */
export function toElement(html: unknown): HTMLElement | null {
  if (html instanceof HTMLElement) return html;
  const jq = html as { 0?: HTMLElement } | undefined;
  return jq?.[0] instanceof HTMLElement ? jq[0] : null;
}

/** One context-menu entry (Actors/Scenes sidebar, token menu). `target` is the clicked entry's element. */
export type MenuEntry = {
  /** Already localized. */
  label: string;
  icon: string;
  visible?: (target: HTMLElement) => boolean;
  onClick: (target: HTMLElement) => unknown;
};

/**
 * The entry in both shapes: v14 reads label / visible / onClick, v13 name / condition / callback
 * (v14 still accepts those, with a deprecation warning).
 */
export function contextEntry(entry: MenuEntry): Record<string, unknown> {
  const visible = (target: unknown) => (entry.visible ? entry.visible(toElement(target) ?? (target as HTMLElement)) : true);
  const run = (target: unknown) => entry.onClick(toElement(target) ?? (target as HTMLElement));
  return {
    label: entry.label,
    icon: entry.icon,
    visible,
    onClick: (_event: unknown, target: unknown) => run(target),
    name: entry.label,
    condition: visible,
    callback: run,
  };
}
