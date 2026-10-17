/** Narrow views of the Foundry API surface Deploy Party touches (see core/foundryApi.ts). */

export type EmbeddedTokenCreator = {
  createEmbeddedDocuments(embeddedName: 'Token', data: Record<string, unknown>[]): Promise<unknown[]>;
};

export function tokenCreator(scene: unknown): EmbeddedTokenCreator {
  return scene as unknown as EmbeddedTokenCreator;
}

export type ActorTokenSource = {
  getTokenDocument(data?: Record<string, unknown>, context?: { parent: unknown }): Promise<TokenDocument>;
};

export function actorTokenSource(actor: unknown): ActorTokenSource {
  return actor as unknown as ActorTokenSource;
}

export type FoldersOf = {
  getSubfolders(recursive?: boolean): Folder[];
};

export function foldersOf(folder: unknown): FoldersOf {
  return folder as unknown as FoldersOf;
}

export type SceneTokens = {
  tokens: { contents: TokenDocument[]; get(id: string): TokenDocument | undefined };
  deleteEmbeddedDocuments(embeddedName: 'Token', ids: string[]): Promise<unknown[]>;
};

export function sceneTokens(scene: unknown): SceneTokens {
  return scene as unknown as SceneTokens;
}
