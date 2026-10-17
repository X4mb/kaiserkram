import { deployParty } from './deploy.js';
import { isDeployedMember, isPartyMarker, recallParty } from './recall.js';
import { toElement } from '../../core/foundryApi.js';
import { loc } from '../../core/i18n.js';

function addHudButton(
  column: Element,
  className: string,
  icon: string,
  title: string,
  onClick: () => void,
): void {
  if (column.querySelector(`.${className}`)) return;

  const button = document.createElement('div');
  button.classList.add('control-icon', className);
  button.setAttribute('role', 'button');
  button.title = title;
  button.innerHTML = `<i class="fa-solid ${icon}"></i>`;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  column.appendChild(button);
}

/**
 * Right-clicking a token opens the core Token HUD; we drop our own icons into it:
 * "Deploy" on the party marker, and "Recall" on the marker or any of its deployed members.
 */
export function registerTokenHudButton(): void {
  Hooks.on('renderTokenHUD', (hud: unknown, html: unknown) => {
    const token = (hud as { object?: Token }).object;
    const doc = token?.document;
    if (!doc || !doc.isOwner) return;

    const isMarker = isPartyMarker(doc);
    const isMember = isDeployedMember(doc);
    if (!isMarker && !isMember) return;

    const root = toElement(html);
    if (!root) return;

    const column = root.querySelector('.col.right') ?? root.querySelector('.col.left') ?? root;

    if (isMarker) {
      addHudButton(
        column,
        'kaiserkram-party-hud-deploy',
        'fa-people-group',
        loc('kaiserkram.party.hud.deploy', 'Deploy party'),
        () => void deployParty(doc),
      );
    }

    addHudButton(
      column,
      'kaiserkram-party-hud-recall',
      'fa-people-arrows',
      loc('kaiserkram.party.hud.recall', 'Recall party'),
      () => void recallParty(doc),
    );
  });
}
