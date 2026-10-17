/** Add a stylesheet to the page once. `href` is relative to the Foundry root, e.g. `modules/kaiserkram/styles/x.css`. */
export function injectStylesheet(href: string): void {
  if (document.head.querySelector(`link[data-kaiserkram-style="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.type = 'text/css';
  link.href = href;
  link.dataset.kaiserkramStyle = href;
  document.head.append(link);
}
