/**
 * Narrow, hand-written views of the WFRP4e API surface the trader touches. The published
 * `foundry-vtt-types` package doesn't know about WFRP4e's data models; generic Foundry
 * helpers live in core/foundryApi.ts.
 */
import { resolveDocument } from '../../core/foundryApi.js';


export type WfrpItem = {
  id: string;
  name: string;
  type: string;
  img: string;
  uuid: string;
  system: any;
  actor: WfrpActor | null;
  flags?: Record<string, any>;
  _stats?: { compendiumSource?: string | null };
  getFlag(scope: string, key: string): unknown;
  setFlag(scope: string, key: string, value: unknown): Promise<unknown>;
  unsetFlag(scope: string, key: string): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<unknown>;
  toObject(): Record<string, any>;
};

export type WfrpTest = {
  roll(): Promise<WfrpTest>;
  succeeded: boolean;
  result: { SL: string | number; target?: number; roll?: number };
};

export type WfrpActor = {
  id: string;
  uuid: string;
  name: string;
  img: string;
  type: string;
  isOwner: boolean;
  hasPlayerOwner: boolean;
  items: { contents: WfrpItem[]; get(id: string): WfrpItem | undefined };
  ownership: Record<string, number>;
  flags: Record<string, any>;
  sheet: { render(options?: unknown): unknown; close?(): unknown } | null;
  getFlag(scope: string, key: string): unknown;
  setFlag(scope: string, key: string, value: unknown): Promise<unknown>;
  unsetFlag(scope: string, key: string): Promise<unknown>;
  update(data: Record<string, unknown>): Promise<unknown>;
  testUserPermission(user: unknown, level: string | number): boolean;
  getActiveTokens(linked?: boolean, document?: boolean): WfrpTokenDoc[];
  createEmbeddedDocuments(type: 'Item', data: Record<string, unknown>[], options?: Record<string, unknown>): Promise<WfrpItem[]>;
  updateEmbeddedDocuments(type: 'Item', data: Record<string, unknown>[]): Promise<unknown[]>;
  deleteEmbeddedDocuments(type: 'Item', ids: string[]): Promise<unknown[]>;
  setupSkill(
    skill: string,
    context?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<WfrpTest | undefined>;
};

export type WfrpTokenDoc = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  actor: WfrpActor | null;
  parent: WfrpScene | null;
};

export type WfrpScene = {
  id: string;
  grid: { size: number; distance: number };
  tokens: { contents: WfrpTokenDoc[] };
};

export type FoundryUser = {
  id: string;
  name: string;
  isGM: boolean;
  isSelf: boolean;
  active: boolean;
  character: WfrpActor | null;
};

export type GameView = {
  user: FoundryUser;
  users: { get(id: string): FoundryUser | undefined; activeGM: FoundryUser | null; contents: FoundryUser[] };
  actors: { get(id: string): WfrpActor | undefined; contents: WfrpActor[] };
  scenes: { viewed: WfrpScene | null };
  system: { id: string };
  packs: { get(id: string): { getDocuments(query?: Record<string, unknown>): Promise<WfrpItem[]> } | undefined };
  socket: {
    emit(name: string, data: unknown): void;
    on(name: string, fn: (data: any) => void): void;
  };
  i18n: {
    localize(key: string): string;
    format(key: string, data: Record<string, unknown>): string;
  };
  settings: {
    register(namespace: string, key: string, data: Record<string, unknown>): void;
    get(namespace: string, key: string): unknown;
  };
  modules: { get(id: string): { api?: Record<string, unknown> } | undefined };
};

/** `game`, seen through the WFRP4e types above. */
export function g(): GameView {
  return game as unknown as GameView;
}

export async function resolveActor(uuid: string): Promise<WfrpActor | null> {
  const doc = await resolveDocument<{ documentName?: string }>(uuid);
  return doc?.documentName === 'Actor' ? (doc as unknown as WfrpActor) : null;
}
