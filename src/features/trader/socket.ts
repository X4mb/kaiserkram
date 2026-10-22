import { isActiveGM } from '../../core/foundryApi.js';
import { emitSocket, registerSocketHandler } from '../../core/socket.js';
import { loc } from '../../core/i18n.js';
import { g, type FoundryUser } from './wfrp.js';

/**
 * Players don't own the trader, so every trade runs on the active GM's client.
 * A player emits a request; the GM runs the handler and emits back a response.
 * Messages travel on Kaiserkram's shared socket, tagged with the `trader` feature.
 */

export type ActionResult = { ok: boolean; message?: string };
export type ActionHandler = (payload: Record<string, unknown>, user: FoundryUser) => Promise<ActionResult>;

/** The sender is never in the message: the GM takes it from the socket, so nobody can pose as someone else. */
type RequestMessage = {
  type: 'request';
  action: string;
  requestId: string;
  payload: Record<string, unknown>;
};

type ResponseMessage = {
  type: 'response';
  requestId: string;
  userId: string;
  result: ActionResult;
};

/** GM → players: open this trader's sheet on your screen. */
type ShowMessage = { type: 'show'; traderUuid: string };

const TIMEOUT_MS = 60_000;
const handlers = new Map<string, ActionHandler>();
const pending = new Map<string, (result: ActionResult) => void>();

export function registerHandler(action: string, handler: ActionHandler): void {
  handlers.set(action, handler);
}

export function registerSocket(): void {
  registerSocketHandler('trader', (raw: unknown, senderId) => {
    const data = raw as RequestMessage | ResponseMessage | ShowMessage | undefined;
    const fromGM = !!senderId && g().users.get(senderId)?.isGM === true;
    if (data?.type === 'show') {
      if (fromGM && !g().user.isGM) showHandler(data.traderUuid);
    } else if (data?.type === 'response') {
      if (!fromGM || data.userId !== g().user.id) return;
      pending.get(data.requestId)?.(data.result);
      pending.delete(data.requestId);
    } else if (data?.type === 'request') {
      if (!isActiveGM() || !senderId) return;
      void handleRequest(data, senderId);
    }
  });
}

/** What a player's client does when the GM shows them a shop (set by the feature, to avoid an import cycle). */
let showHandler: (traderUuid: string) => void = () => {};

export function onShowShop(handler: (traderUuid: string) => void): void {
  showHandler = handler;
}

/** GM: pop the trader's shop open for every connected player. */
export function showToPlayers(traderUuid: string): void {
  const message: ShowMessage = { type: 'show', traderUuid };
  emitSocket('trader', message);
}

/**
 * Trades run one at a time on the GM's client. Each reads stock and coins, then writes them; two
 * at once (two players buying the last item) could both pass the checks and sell it twice.
 */
let queue: Promise<unknown> = Promise.resolve();

function run(action: string, payload: Record<string, unknown>, user: FoundryUser): Promise<ActionResult> {
  const next = queue.then(() => runNow(action, payload, user));
  queue = next.catch(() => undefined);
  return next;
}

async function runNow(action: string, payload: Record<string, unknown>, user: FoundryUser): Promise<ActionResult> {
  const handler = handlers.get(action);
  if (!handler) return { ok: false, message: `Unknown action ${action}` };
  try {
    return await handler(payload, user);
  } catch (err) {
    console.error(`[kaiserkram] trader: ${action} failed`, err);
    return { ok: false, message: loc('kaiserkram.trader.notifications.failed', 'The trade failed; see the GM\'s console.') };
  }
}

async function handleRequest(msg: RequestMessage, senderId: string): Promise<void> {
  const user = g().users.get(senderId);
  const result: ActionResult = user
    ? await run(msg.action, msg.payload, user)
    : { ok: false, message: 'Unknown user' };
  const response: ResponseMessage = { type: 'response', requestId: msg.requestId, userId: senderId, result };
  emitSocket('trader', response);
}

/** Run `action` on the GM's client (or right here, if this is a GM) and report the outcome. */
export async function requestGM(action: string, payload: Record<string, unknown>): Promise<ActionResult> {
  const me = g().user;
  const result = await (async (): Promise<ActionResult> => {
    if (me.isGM) return run(action, payload, me);
    if (!g().users.activeGM) {
      return { ok: false, message: loc('kaiserkram.trader.notifications.noGM', 'A GM needs to be online to trade.') };
    }
    const requestId = foundry.utils.randomID();
    const response = new Promise<ActionResult>((resolve) => {
      pending.set(requestId, resolve);
      setTimeout(() => {
        if (pending.delete(requestId)) {
          resolve({ ok: false, message: loc('kaiserkram.trader.notifications.timeout', 'The GM didn\'t answer in time.') });
        }
      }, TIMEOUT_MS);
    });
    const request: RequestMessage = { type: 'request', action, requestId, payload };
    emitSocket('trader', request);
    return response;
  })();

  if (result.message) {
    const notify = ui.notifications as unknown as { info(m: string): void; warn(m: string): void };
    if (result.ok) notify.info(result.message);
    else notify.warn(result.message);
  }
  return result;
}
