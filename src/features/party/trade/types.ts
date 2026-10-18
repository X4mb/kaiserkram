/** One side of a trade, as every client sees it. */
export type TradeSide = {
  actorUuid: string;
  actorName: string;
  actorImg: string;
  /** The user deciding for this actor. */
  userId: string;
  userName: string;
  /** Offered items with display data, so the other side needn't look them up. */
  items: { id: string; name: string; img: string; qty: number; max: number }[];
  accepted: boolean;
};

export type TradeStatus = 'pending' | 'open';

export type TradeSession = {
  id: string;
  status: TradeStatus;
  /** [initiator, partner] */
  sides: [TradeSide, TradeSide];
};

export type CloseReason = 'declined' | 'cancelled' | 'done' | 'failed' | 'timeout' | 'left' | 'unknown';

/** Client → GM. `userId` is the sender. */
export type TradeRequest =
  | { kind: 'trade'; op: 'propose'; userId: string; from: string; to: string }
  | { kind: 'trade'; op: 'respond'; userId: string; id: string; accept: boolean }
  | { kind: 'trade'; op: 'offer'; userId: string; id: string; items: Record<string, number> }
  | { kind: 'trade'; op: 'accept'; userId: string; id: string; accepted: boolean }
  | { kind: 'trade'; op: 'cancel'; userId: string; id: string };

/** GM → clients. */
export type TradeUpdate =
  | { kind: 'trade'; op: 'invite'; session: TradeSession }
  | { kind: 'trade'; op: 'state'; session: TradeSession }
  | { kind: 'trade'; op: 'closed'; id: string; users: string[]; reason: CloseReason; by?: string; message?: string };

export type TradeMessage = TradeRequest | TradeUpdate;

export const REQUEST_OPS = new Set(['propose', 'respond', 'offer', 'accept', 'cancel']);

/** A request without the fields the sender fills in itself. */
export type RequestBody = {
  [K in TradeRequest['op']]: Omit<Extract<TradeRequest, { op: K }>, 'kind' | 'userId'>;
}[TradeRequest['op']];
