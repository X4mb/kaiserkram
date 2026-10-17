# Kaiserkram — handoff

Merge four Foundry VTT modules by X4mb into one module, **Kaiserkram**, where every former module is an opt-in feature that registers nothing when it's off.

Target repo: `https://github.com/X4mb/kaiserkram` (created empty, apart from this file).

## Decisions already made

| Topic | Decision |
|---|---|
| Name / id | Title `Kaiserkram`, module id `kaiserkram` |
| Repo | `X4mb/kaiserkram`, under the user's account |
| License | PolyForm Noncommercial 1.0.0 for everything. World Landing was MIT, so keep its copyright notice in a `THIRD_PARTY_NOTICES` section of `LICENSE` |
| Git history | Fresh history. Don't import old commits |
| Foundry | v14 only (`minimum: "14"`, `verified: "14"`). Drop v13 fallbacks where convenient |
| Systems | General features run in any system; WFRP4e features only when `game.system.id === "wfrp4e"`. Do **not** set `relationships.systems` in `module.json` |
| Defaults | All features **off** (opt-in) in every world, including after migration |
| Toggle UI | A "Kaiserkram Features" window (ApplicationV2) opened from a `registerMenu` button. Grouped General / WFRP4e, short description per feature, one reload at the end |
| Old modules | Migrate their data once, then the user deletes the four old repos |

## Source repos

All public, all by X4mb. Clone them into a scratch folder:

```
git clone https://github.com/X4mb/World-Landing-fvtt
git clone https://github.com/X4mb/deploy-party-fvtt
git clone https://github.com/X4mb/within-earshot-fvtt
git clone https://github.com/X4mb/trader-wfrp4e-fvtt
```

| Old module | Old id | Feature id | Group | Notes |
|---|---|---|---|---|
| World Landing | `world-landing-fvtt` | `landing` | General | ~120 lines plain JS (`scripts/module.mjs`). Port to TS. Hooks are registered at load time; move them into the feature. Uses `/api/status` uptime to detect a fresh world boot |
| Deploy Party | `deploy-party` | `party` | General | Clean: everything registered in `init`. Hooks: `dropCanvasData`, `renderTokenHUD` |
| Within Earshot | `withinearshot` | `earshot` | General | Heaviest. Replaces `CONFIG.WebRTC.clientClass` in `init`, adds a per-frame canvas ticker and ~15 hooks. Settings are registered in `ready`; they must move to `init`. Keybindings must stay in `init` |
| WFRP4e Trader | `trader-wfrp4e` | `trader` | WFRP4e | Hooks `renderActorDirectory`, `createToken`, `create/update/deleteItem` are registered at module load time (they fire in every system); move into the feature. Registers an Actor sheet, uses a socket, 5 Handlebars templates, 1 CSS file |

Deploy Party, Within Earshot and Trader already share the toolchain: esbuild + TypeScript (strict), `@league-of-foundry-developers/foundry-vtt-types`, `scripts/deploy.mjs` (copies the build into `%LOCALAPPDATA%/FoundryVTT/Data/modules/<id>` or `FOUNDRY_MODULE_PATH`), `scripts/package-release.mjs` (archiver → `module.zip`), and CI/release workflows (release on `v*` tag, attaches `module.zip`, manifest `download` points at `releases/latest/download/module.zip`). Reuse these, generalised.

Roughly 4,200 lines in total. Largest files: `trader/sheet.ts` (472), `trader/haggle.ts` (257), `trader/restock.ts` (249).

## Target layout

```
kaiserkram/
├─ module.json            # id kaiserkram, v14, socket: true, esmodules: dist/kaiserkram.js,
│                         # styles: only styles/core.css (feature manager), lang/en.json
├─ package.json  tsconfig.json  .gitignore  LICENSE  README.md
├─ scripts/deploy.mjs  scripts/package-release.mjs
├─ .github/workflows/ci.yml  release.yml   .github/dependabot.yml
├─ src/
│  ├─ main.ts             # bootstrap: toggles, activation, api, migration
│  ├─ core/
│  │  ├─ constants.ts     # MODULE_ID = 'kaiserkram'
│  │  ├─ i18n.ts          # loc(key, fallback), fmt(key, fallback, data) (were duplicated 3x)
│  │  ├─ foundryApi.ts    # generic typed views: g(), flags(), dialogV2(), renderTemplate,
│  │  │                   # loadTemplates, escapeHtml, postChat ... (were duplicated 2x)
│  │  ├─ feature.ts       # Feature interface
│  │  ├─ registry.ts      # FEATURES array
│  │  ├─ toggles.ts       # enabled-features world setting + isEnabled()
│  │  ├─ featureManager.ts# ApplicationV2 window
│  │  ├─ socket.ts        # one channel `module.kaiserkram`, messages routed by `feature`
│  │  ├─ assets.ts        # injectStylesheet(href)
│  │  └─ migration.ts
│  └─ features/{landing,party,earshot,trader}/   # index.ts exports the Feature
├─ templates/trader/*.hbs
├─ styles/core.css  styles/trader.css            # trader.css injected only when active
├─ assets/party-token.svg  assets/trader.svg
└─ lang/en.json
```

A first pass of copying already happened in a scratch session, but nothing was pushed. Start from the old repos.

## Core design

```ts
export interface Feature {
  id: 'landing' | 'party' | 'earshot' | 'trader';
  group: 'general' | 'wfrp4e';
  systems?: string[];            // ['wfrp4e'] for trader; omitted = any system
  legacyModuleId: string;        // for migration and conflict warnings
  styles?: string[];             // injected only when active
  templates?: string[];          // loaded only when active
  init(): void;                  // register settings, keybindings, hooks, sheets (called in `init`)
  ready?(): void | Promise<void>;
  api?(): Record<string, unknown>;
}
```

`main.ts`, in `Hooks.once('init')`:

1. Register `enabledFeatures` (world, `config: false`, Object, default `{}`) and `migrationVersion` (world, Number, default 0).
2. Register the feature manager with `game.settings.registerMenu` (GM only).
3. Filter `FEATURES` by system, then by `enabledFeatures[id] === true`.
4. For each active feature: inject styles, call `init()`, collect templates, then `loadTemplates` once.
5. In `ready`: call each active feature's `ready()` and expose `game.modules.get('kaiserkram').api = { features: { party: {...}, trader: {...} }, migrate }`.

Performance rule: a disabled feature must register no hooks, settings, keybindings, sheets, socket handlers, CSS or templates. Code for disabled features is still in the bundle; that's fine (parse cost is negligible). Don't make bootstrap async with dynamic `import()`, because Foundry doesn't await hook callbacks.

Feature manager: lists only features valid for the current system, saves `enabledFeatures`, then if anything changed calls `foundry.applications.settings.SettingsConfig.reloadConfirm({ world: true })` (check it exists in v14; fall back to a DialogV2 confirm plus `foundry.utils.debouncedReload()`).

On `ready` (GM): if a legacy module is active **and** its feature is enabled, show a warning. Running both at once would double hooks, register two trader sheets, or fight over the WebRTC client.

## Namespacing (inside the single module)

- **Settings keys:** prefix by feature in camelCase, no dots. For example `partyDeployOnDrop`, `traderDefaultMarkup`, `earshotMaxRange`, `landingDefaultSceneId`. Keep `SETTINGS` const objects per feature; WE's `clientSettingChanged` handler compares against those values.
- **Flags:** nest per feature: `flags.kaiserkram.trader.isTrader`, `flags.kaiserkram.party.deployBatchId`, `flags.kaiserkram.earshot.voiceProfile`. Make each feature's `FLAGS` values dotted paths (`'trader.isTrader'`); `getFlag`/`setFlag`/`unsetFlag` handle dotted keys. The four places that build flags as **object literals** need `foundry.utils.expandObject` or explicit nesting:
  - `party/spawn.ts:65`
  - `party/partyToken.ts:41`
  - `trader/module.ts:35` (`createTrader`)
  - `trader/restock.ts:128`

  Also update `trader/sheet.ts:431` (`flags.${MODULE_ID}.${FLAGS.CONFIG}.open`). Earshot's `updateActor` check becomes `flags?.kaiserkram?.earshot?.voiceProfile`, and its `updateUser` check should look only at `.earshot`. `trader/transactions.ts:66` deletes all kaiserkram flags from copied items, which is still correct.
- **i18n:** `kaiserkram.<feature>.…` (e.g. `kaiserkram.trader.SETTINGS.defaultMarkup.name`, `kaiserkram.landing.ContextSet`). Check the `.hbs` templates for localize keys too.
- **Keybindings:** namespace `kaiserkram`, action ids prefixed (`earshotToggleGMVoiceGlobal`, `earshotVoiceToken`).
- **CSS:** `.trader-wfrp4e` becomes `.kaiserkram` on the trader sheet and dialogs (check `classes` in `sheet.ts` and dialogs).
- **Sheet:** registered with scope `kaiserkram`, so the class id becomes `kaiserkram.TraderSheet`.
- **Socket:** `module.kaiserkram`, payload `{ feature: 'trader', ... }`, routed by `core/socket.ts`.
- **Asset paths:** `modules/kaiserkram/assets/...`, `modules/kaiserkram/templates/trader/...`.

## Bugs to fix during the port

- **Within Earshot translations never resolve.** `lang/en.json` has top-level `SETTINGS` and `VOICE` keys, but the code looks up `withinearshot.SETTINGS…` / `withinearshot.VOICE…`. Every string falls back to the hard-coded English, and its keys get merged into core's own `SETTINGS` namespace. Nest them under `kaiserkram.earshot`.
- Within Earshot registers settings in `ready`. Move them to `init`.
- Trader and World Landing register hooks at module load time. Move them into `init()`.

## Migration (`core/migration.ts`)

Runs once, as the active GM, on `ready`, when `migrationVersion < 1`. It runs **regardless of which features are enabled**. Also expose it as `api.migrate({ force: true })`. Keep the old flags (copy, don't delete) so nothing is lost if something goes wrong. Set `migrationVersion = 1` at the end. Afterwards, notify the GM which features had data and that they're off until enabled in Kaiserkram Features.

Read old world settings from the raw world settings storage (`game.settings.storage.get('world')`, entries keyed `"<oldId>.<key>"`; the value may be a JSON string, so parse it), because the old namespaces aren't registered.

| Source | What to move |
|---|---|
| World settings | `world-landing-fvtt.defaultSceneId` / `lastBootEpoch`; all `deploy-party.*` (7 keys); all `trader-wfrp4e.*` (15 keys); `withinearshot.maxRange`, `gmVoiceGlobal`, `throughWallGain`, `muteUnresolvedSpeaker`. Map them to the new prefixed keys |
| `deploy-party.defaultTokenImage` | Rewrite `modules/deploy-party/assets/party-token.svg` to `modules/kaiserkram/assets/party-token.svg` |
| Actors (world) | `flags.trader-wfrp4e.*` → `flags.kaiserkram.trader.*`; **`flags.core.sheetClass === 'trader-wfrp4e.TraderSheet'` → `'kaiserkram.TraderSheet'` (critical: otherwise traders open as plain NPC sheets)**; `flags.withinearshot.voiceProfile` → `flags.kaiserkram.earshot.voiceProfile`; `img` and `prototypeToken.texture.src` using `modules/trader-wfrp4e/assets/trader.svg` |
| Actor items | `flags.trader-wfrp4e.{priceOverride,infinite,notForSale}` → `flags.kaiserkram.trader.*` |
| Scene tokens | `flags.deploy-party.*` → `flags.kaiserkram.party.*` (party markers and deployed tokens); `texture.src` for both old asset paths |
| Unlinked tokens | `token.delta` may hold trader flags, sheetClass and items with trader flags (haggle state on synthetic actors). Migrate only what is present in the delta source; don't copy base-actor data into deltas |
| User flags | `withinearshot.voiceTokenId`: skip (cleared on every `ready` anyway) |
| Keybindings | Not migrated; users rebind once |

Compendium actors aren't migrated. Mention that in the README.

## Build and release

- `package.json` scripts: `build` (esbuild `src/main.ts` → `dist/kaiserkram.js`, esm, es2022, sourcemap, minify, then `deploy.mjs`), `watch`, `typecheck` (`tsc --noEmit`), `release-pack`.
- `package-release.mjs` zips `module.json`, `LICENSE`, `dist`, `lang`, `assets`, `templates`, `styles`.
- `module.json`:
  - `manifest`: `https://raw.githubusercontent.com/X4mb/kaiserkram/main/module.json`
  - `download`: `https://github.com/X4mb/kaiserkram/releases/latest/download/module.zip`
  - authors: X4mb, with room to add deppenkaiser
- Start at version `0.1.0` (untested in a live world).

## Verification checklist

1. `npm run typecheck` passes and `npm run release-pack` produces `module.zip`.
2. `grep -rn "trader-wfrp4e\|deploy-party\|withinearshot\|world-landing" src templates styles lang` turns up hits **only** in `migration.ts` and `legacyModuleId` fields.
3. Every `loc('kaiserkram.…')` key used in the code exists in `lang/en.json`. A small script can check this.
4. Optional smoke test: load `dist/kaiserkram.js` in Node with auto-stubbed Foundry globals (a recursive Proxy for `foundry`, `game`, `CONFIG`, `Hooks`), fire `init`/`ready` with all features on and `system.id = 'wfrp4e'`, and assert there are no throws and that keybindings and settings were registered in `init`. Then do it again with all features off and assert zero feature hooks were registered.
5. Manual test in Foundry v14 (the user does this):
   - a fresh world: nothing runs until enabled
   - a world that had the old modules: migration notice appears, traders still open as trader sheets, party markers still deploy and recall, voice profiles kept, landing scene kept
   - a non-WFRP world: no Trader in the feature list

## After it works

1. Release `v0.1.0` (tag push).
2. Install it in both worlds, run the migration, and disable the old modules.
3. Delete the four old repos.

The old manifest URLs will then 404, which only stops updates for old installs. That's fine.
