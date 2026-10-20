export type FeatureId = 'landing' | 'party' | 'earshot' | 'trader' | 'containers' | 'grudges' | 'travel';
export type FeatureGroup = 'general' | 'wfrp4e';

/**
 * One former stand-alone module. Nothing in a feature runs unless it is enabled in
 * Kaiserkram Features (and, with `systems`, the world runs one of those systems).
 */
export interface Feature {
  id: FeatureId;
  group: FeatureGroup;
  /** Game systems the feature works with; omitted means any system. */
  systems?: string[];
  /** Id of the module this feature replaces, for migration and conflict warnings (none for new features). */
  legacyModuleId?: string;
  /** Title of that module, for messages. */
  legacyTitle?: string;
  /** Stylesheets (relative to the Foundry root) injected only when active. */
  styles?: string[];
  /** Handlebars templates loaded only when active. */
  templates?: string[];
  /** Register settings, keybindings, hooks and sheets. Called during `init`. */
  init(): void;
  /** Called during `ready`. */
  ready?(): void | Promise<void>;
  /** Public functions, exposed as `game.modules.get('kaiserkram').api.features.<id>`. */
  api?(): Record<string, unknown>;
}
