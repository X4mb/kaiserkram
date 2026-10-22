import { on } from './foundryApi.js';

/** A button (or toggle) in the token controls of the left toolbar. */
export type TokenTool = {
  name: string;
  title: string;
  /** Font Awesome icon classes, e.g. `fa-solid fa-gift`. */
  icon: string;
  order: number;
  /** A toggle shows on/off; `use` gets the new state. Otherwise it is a plain button. */
  toggle?: { active(): boolean };
  use(active: boolean): void;
};

type Tool = Record<string, unknown>;
type Control = { tools: Record<string, Tool> };

/**
 * Add tools to the token controls. `tools` is asked each time the toolbar is built, so it can
 * return nothing (a setting turned off, say).
 */
export function addTokenTools(tools: () => TokenTool[]): void {
  on('getSceneControlButtons', ((controls: Record<string, Control>) => {
    const tokens = controls.tokens;
    if (!tokens) return;
    for (const t of tools()) {
      const tool: Tool = {
        name: t.name,
        title: t.title,
        icon: t.icon,
        order: t.order,
        visible: true,
        ...(t.toggle ? { toggle: true, active: t.toggle.active() } : { button: true }),
        onChange: (_event: unknown, active: boolean) => t.use(Boolean(active)),
      };
      tokens.tools[t.name] = tool;
    }
  }) as (...args: never[]) => unknown);
}
