import { MODULE_ID } from './constants.js';
import type { FeatureId } from './feature.js';

/**
 * One socket channel for the whole module. Every message carries the feature it belongs to,
 * and only features that registered a handler (i.e. are active) ever see their messages.
 * Handlers get the sender's user id from Foundry itself: trust that, never an id in the payload.
 */
export const SOCKET_NAME = `module.${MODULE_ID}`;

type Envelope = { feature: FeatureId; data: unknown };
type SocketApi = { emit(name: string, data: unknown): void; on(name: string, fn: (data: unknown, senderId?: string) => void): void };

export type SocketHandler = (data: unknown, senderId: string | undefined) => void;

const handlers = new Map<FeatureId, SocketHandler>();
let listening = false;

function socket(): SocketApi {
  return (game as unknown as { socket: SocketApi }).socket;
}

export function registerSocketHandler(feature: FeatureId, handler: SocketHandler): void {
  handlers.set(feature, handler);
  if (listening) return;
  listening = true;
  // Foundry passes the id of the user who emitted the message after the data.
  socket().on(SOCKET_NAME, (raw: unknown, senderId?: string) => {
    const msg = raw as Envelope | undefined;
    if (!msg?.feature) return;
    handlers.get(msg.feature)?.(msg.data, senderId);
  });
}

export function emitSocket(feature: FeatureId, data: unknown): void {
  const envelope: Envelope = { feature, data };
  socket().emit(SOCKET_NAME, envelope);
}
