import { MODULE_ID } from './constants.js';
import { moduleById } from './foundryApi.js';

/**
 * Add a stylesheet to the page once. `href` is relative to the Foundry root, e.g.
 * `modules/kaiserkram/styles/x.css`. The module version is appended so an update isn't
 * hidden behind a cached copy.
 */
export function injectStylesheet(href: string): void {
  if (document.head.querySelector(`link[data-kaiserkram-style="${href}"]`)) return;
  const version = (moduleById(MODULE_ID) as { version?: string } | undefined)?.version;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.type = 'text/css';
  link.href = version ? `${href}?v=${encodeURIComponent(version)}` : href;
  link.dataset.kaiserkramStyle = href;
  document.head.append(link);
}
