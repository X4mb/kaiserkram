import { MODULE_ID } from '../../core/constants.js';
import { escapeHtml, notify } from '../../core/foundryApi.js';
import { fmt, loc } from '../../core/i18n.js';
import { allReady, approve, currentVote, onlinePlayers, proposerName, request, sceneById, type Vote } from './state.js';

/**
 * Two small bars at the top of the screen:
 *  - the vote: where to, who is ready, and (for the GM) Travel now / Cancel;
 *  - for a player looking at a scene that isn't the active one: "Propose travelling here?".
 */

const PANEL_ID = `${MODULE_ID}-travel`;
const OFFER_ID = `${MODULE_ID}-travel-offer`;
/** Scenes a player said "just looking" about, this session. */
const dismissed = new Set<string>();
/** The vote the GM was last told is ready, so it's said once. */
let announcedReady = '';

function viewedSceneId(): string | null {
  return (canvas as unknown as { scene?: { id: string } | null } | null)?.scene?.id ?? null;
}

function activeSceneId(): string | null {
  return (game.scenes as unknown as { active?: { id: string } | null }).active?.id ?? null;
}

const STACK_ID = `${MODULE_ID}-travel-stack`;

/** Both bars live in one fixed column at the top, the vote first. */
function element(id: string): HTMLElement {
  let el = document.getElementById(id);
  if (el) return el;
  let stack = document.getElementById(STACK_ID);
  if (!stack) {
    stack = document.createElement('div');
    stack.id = STACK_ID;
    stack.addEventListener('click', onClick);
    document.body.append(stack);
  }
  el = document.createElement('section');
  el.id = id;
  el.className = `${MODULE_ID}-travel-bar`;
  if (id === PANEL_ID) stack.prepend(el);
  else stack.append(el);
  return el;
}

function renderVote(vote: Vote): string {
  const scene = sceneById(vote.sceneId)!;
  const me = game.user!;
  const players = onlinePlayers();
  const ready = players.filter((u) => vote.votes[u.id] === true).length;
  const everyone = allReady(vote);
  const chips = players
    .map((u) => {
      const state = vote.votes[u.id];
      const icon = state === true ? 'fa-check' : state === false ? 'fa-xmark' : 'fa-hourglass-half';
      const cls = state === true ? 'yes' : state === false ? 'no' : 'waiting';
      return `<span class="chip ${cls}"><i class="fa-solid ${icon}"></i> ${escapeHtml(u.name)}</span>`;
    })
    .join('');
  const mine = vote.votes[me.id];
  const looking = viewedSceneId() === scene.id;
  const buttons: string[] = [];
  if (!me.isGM) {
    buttons.push(
      `<button type="button" data-travel="yes" class="${mine === true ? 'active' : ''}"><i class="fa-solid fa-check"></i> ${escapeHtml(loc('kaiserkram.travel.ready', 'Ready'))}</button>`,
      `<button type="button" data-travel="no" class="${mine === false ? 'active' : ''}"><i class="fa-solid fa-xmark"></i> ${escapeHtml(loc('kaiserkram.travel.notYet', 'Not yet'))}</button>`,
    );
  }
  buttons.push(
    looking
      ? `<button type="button" data-travel="back"><i class="fa-solid fa-rotate-left"></i> ${escapeHtml(loc('kaiserkram.travel.back', 'Back'))}</button>`
      : `<button type="button" data-travel="look"><i class="fa-solid fa-eye"></i> ${escapeHtml(loc('kaiserkram.travel.look', 'Look'))}</button>`,
  );
  if (me.isGM) {
    buttons.push(
      `<button type="button" data-travel="approve" class="${everyone ? 'ready' : ''}"><i class="fa-solid fa-person-walking-arrow-right"></i> ${escapeHtml(loc('kaiserkram.travel.approve', 'Travel now'))}</button>`,
    );
  }
  if (me.isGM || me.id === vote.by) {
    buttons.push(`<button type="button" data-travel="cancel" data-tooltip="${escapeHtml(loc('kaiserkram.travel.cancel', 'Cancel the vote'))}"><i class="fa-solid fa-ban"></i></button>`);
  }
  return `<div class="title">
      <i class="fa-solid fa-map-location-dot"></i>
      ${fmt('kaiserkram.travel.question', 'Travel to <b>{scene}</b>?', { scene: escapeHtml(scene.name) })}
      <span class="hint">${escapeHtml(fmt('kaiserkram.travel.proposedBy', 'proposed by {name}', { name: proposerName(vote) }))}</span>
      <span class="tally ${everyone ? 'ready' : ''}">${ready}/${players.length}</span>
    </div>
    <div class="chips">${chips || `<span class="hint">${escapeHtml(loc('kaiserkram.travel.noPlayers', 'No players online.'))}</span>`}</div>
    <div class="buttons">${buttons.join('')}</div>`;
}

/** Re-draw both bars from the current state. */
export function refreshTravel(): void {
  const vote = currentVote();
  const panel = document.getElementById(PANEL_ID);
  if (vote) element(PANEL_ID).innerHTML = renderVote(vote);
  else panel?.remove();

  if (vote && game.user?.isGM && allReady(vote) && announcedReady !== `${vote.sceneId}:${vote.at}`) {
    announcedReady = `${vote.sceneId}:${vote.at}`;
    notify().info(fmt('kaiserkram.travel.allReady', 'Everyone is ready to travel to {scene}.', { scene: sceneById(vote.sceneId)!.name }));
  }

  // Offer a vote to a player looking at a scene the party isn't on.
  const viewed = viewedSceneId();
  const offer = !game.user?.isGM && viewed && viewed !== activeSceneId() && vote?.sceneId !== viewed && !dismissed.has(viewed);
  const offerEl = document.getElementById(OFFER_ID);
  if (!offer) {
    offerEl?.remove();
    return;
  }
  const scene = sceneById(viewed!);
  if (!scene) return;
  element(OFFER_ID).innerHTML = `<div class="title"><i class="fa-solid fa-eye"></i> ${fmt(
    'kaiserkram.travel.viewing',
    "You're looking at <b>{scene}</b>.",
    { scene: escapeHtml(scene.name) },
  )}</div>
    <div class="buttons">
      <button type="button" data-travel="propose" data-scene="${escapeHtml(scene.id)}"><i class="fa-solid fa-map-location-dot"></i> ${escapeHtml(
        loc('kaiserkram.travel.propose', 'Propose travelling here'),
      )}</button>
      <button type="button" data-travel="dismiss" data-scene="${escapeHtml(scene.id)}"><i class="fa-solid fa-xmark"></i> ${escapeHtml(
        loc('kaiserkram.travel.justLooking', 'Just looking'),
      )}</button>
    </div>`;
}

function onClick(ev: MouseEvent): void {
  const button = (ev.target as HTMLElement).closest<HTMLElement>('[data-travel]');
  if (!button) return;
  const vote = currentVote();
  switch (button.dataset.travel) {
    case 'yes':
    case 'no':
      request({ op: 'vote', yes: button.dataset.travel === 'yes' });
      break;
    case 'look':
      void sceneById(vote?.sceneId)?.view();
      break;
    case 'back': {
      const active = (game.scenes as unknown as { active?: { view(): Promise<unknown> } | null }).active;
      void active?.view();
      break;
    }
    case 'approve':
      void approve();
      break;
    case 'cancel':
      request({ op: 'cancel' });
      break;
    case 'propose':
      if (button.dataset.scene) request({ op: 'propose', sceneId: button.dataset.scene });
      break;
    case 'dismiss':
      if (button.dataset.scene) dismissed.add(button.dataset.scene);
      refreshTravel();
      break;
  }
}


