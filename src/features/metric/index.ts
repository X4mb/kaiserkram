import type { Feature } from '../../core/feature.js';
import { on, toElement } from '../../core/foundryApi.js';
import { toMetric } from './convert.js';

/**
 * Metric units: everything the table reads (sheets, items, spells, chat cards, journals, dialogs,
 * tooltips) shows metres instead of yards and feet, as it is drawn. The stored data stays as it
 * is (yards), so turning the feature off brings the old text back and nothing needs converting.
 */

/** Where text is typed, not read: changing it there would save metric into the data. */
const EDITABLE = 'input, textarea, select, [contenteditable], prose-mirror, .ProseMirror, code, pre, script, style';
const ATTRIBUTES = ['data-tooltip', 'title', 'placeholder'];

export function convertElement(root: HTMLElement): void {
  if (!/yard|yd|feet|foot|ft|mile|inch/i.test(root.textContent ?? '') && !root.querySelector('[data-tooltip], [title]')) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest(EDITABLE) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.nodeValue ?? '';
    const metric = toMetric(text);
    if (metric !== text) node.nodeValue = metric;
  }
  // Tooltips, titles and placeholders are only ever read.
  for (const el of root.querySelectorAll<HTMLElement>(ATTRIBUTES.map((a) => `[${a}]`).join(', '))) {
    for (const name of ATTRIBUTES) {
      const value = el.getAttribute(name);
      if (!value) continue;
      const metric = toMetric(value);
      if (metric !== value) el.setAttribute(name, metric);
    }
  }
}

function onRender(_app: unknown, html: unknown): void {
  const root = toElement(html);
  if (root) convertElement(root);
}

export const metric: Feature = {
  id: 'metric',
  group: 'general',

  init() {
    // Every window (sheets, journals, dialogs, the roll dialog) and every chat message.
    on('renderApplicationV2', onRender as (...args: never[]) => unknown);
    on('renderChatMessageHTML', ((_message: unknown, html: unknown) => onRender(null, html)) as (...args: never[]) => unknown);
  },
};
