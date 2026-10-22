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
type Control = { name?: string; tools: Record<string, Tool> | Tool[] };

/**
 * Add tools to the token controls. `tools` is asked each time the toolbar is built, so it can
 * return nothing (a setting turned off, say).
 */
export function addTokenTools(tools: () => TokenTool[]): void {
  on('getSceneControlButtons', ((controls: Record<string, Control> | Control[]) => {
    const tokens = Array.isArray(controls)
      ? controls.find((c) => c.name === 'token' || c.name === 'tokens')
      : (controls.tokens ?? controls.token);
    if (!tokens) return;
    for (const t of tools()) {
      const tool: Tool = {
        name: t.name,
        title: t.title,
        icon: t.icon,
        order: t.order,
        visible: true,
        ...(t.toggle ? { toggle: true, active: t.toggle.active() } : { button: true }),
        // v13+: onChange(event, active).
        onChange: (_event: unknown, active: boolean) => t.use(Boolean(active)),
      };
      // Older cores: an array of tools, onClick(active).
      if (Array.isArray(tokens.tools)) tokens.tools.push({ ...tool, onClick: (active: boolean) => t.use(Boolean(active)) });
      else tokens.tools[t.name] = tool;
    }
  }) as (...args: never[]) => unknown);
}
