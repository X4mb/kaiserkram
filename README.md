# Kaiserkram

A box of opt-in Foundry VTT tools by X4mb, merged from four stand-alone modules. **Foundry v14 only.**

Every feature is **off** until you enable it. A disabled feature registers nothing: no settings, hooks, keybindings, sheets, socket handlers, CSS or templates.

| Feature | Group | What it does | Replaces |
|---|---|---|---|
| **World Landing** | General | Right-click a scene → *Set as Default Scene*. It is activated whenever the world starts (GM only). | `world-landing-fvtt` |
| **Deploy Party** | General | Drag an actor folder onto the canvas to get one party marker. From its Token HUD, *Deploy* drops every actor as its own token; *Recall* brings them back. | `deploy-party` |
| **Within Earshot** | General | Proximity voice: how loud others are follows token distance and walls. Optional global GM voice, and a voice-token shortcut (default Ctrl+Shift+V). Replaces Foundry's A/V client. | `withinearshot` |
| **Trader** | WFRP4e | Turns a WFRP4e NPC into a shop sheet: buy and sell with the coins on your character, restock from a RollTable with Availability tests, and haggle. Only offered in WFRP4e worlds. | `trader-wfrp4e` |

## Installation

Setup → **Add-on Modules** → **Install Module**, paste this manifest URL and click Install:

```
https://raw.githubusercontent.com/X4mb/kaiserkram/main/module.json
```

Enable **Kaiserkram** in the world's **Manage Modules**, then as GM open **Configure Settings → Kaiserkram → Kaiserkram Features**, tick the features you want and save. Foundry asks to reload once at the end.

Each enabled feature adds its own settings under Configure Settings → Kaiserkram, and Within Earshot's keybindings appear under Configure Controls → Kaiserkram.

## Moving from the old modules

The first time a GM loads a world with Kaiserkram enabled, Kaiserkram copies the old modules' data into its own namespace. This happens once, whether or not any feature is enabled yet:

- world settings of all four modules
- traders: their flags, their stock flags (fixed prices, unlimited stock, not for sale) and **their sheet**, so they still open as trader sheets
- party markers and deployed tokens, so Deploy and Recall keep working
- per-actor voice profiles
- the landing scene
- image paths that pointed into the old modules' folders
- unlinked tokens: trader flags and haggle state stored on the token itself

A notice lists which features had data. **Those features stay off until you enable them.** Nothing is deleted: the old flags and settings stay where they were. The one thing that is switched over is each trader's sheet, so if you go back to the old Trader module, pick its sheet again in the trader's sheet configuration.

Then disable the four old modules. Running a feature next to the module it replaces doubles its hooks, registers two trader sheets, or fights over the A/V client; Kaiserkram warns the GM if it sees that.

Not migrated:

- **Compendium actors.** Traders stored in a compendium still point at the old sheet; re-import them, or pick the *Trader* sheet in their sheet configuration.
- **Keybindings.** Rebind Within Earshot's shortcuts once under Configure Controls.
- Within Earshot's per-user voice token pin, which is cleared on every load anyway.

To run the migration again (for example after importing more old data), use the console:

```js
await game.modules.get('kaiserkram').api.migrate({ force: true });
```

## API

```js
const api = game.modules.get('kaiserkram').api;
api.features.party?.deployParty(tokenDocument);
api.features.trader?.createTrader();
api.features.earshot?.setVoiceProfileForActor(actor, { gainMultiplier: 1.2 });
```

`api.features` only contains enabled features.

## Development

```sh
npm ci
npm run typecheck     # tsc --noEmit (strict)
npm run check:i18n    # every kaiserkram.* key used in src/ and templates/ exists in lang/en.json
npm run smoke         # loads the bundle against stubbed Foundry globals: all on, all off, non-WFRP
npm run build         # esbuild → dist/kaiserkram.js, then copies into your Foundry data folder
npm run watch
npm run release-pack  # build + module.zip
```

`npm run build` copies the module into `%LOCALAPPDATA%/FoundryVTT/Data/modules/kaiserkram`, or into `FOUNDRY_MODULE_PATH` if set.

Layout: `src/main.ts` boots the module; `src/core/` holds the feature toggles, the Kaiserkram Features window, the shared socket (`module.kaiserkram`, messages tagged by feature) and the migration; each feature lives in `src/features/<id>/` and exports a `Feature` from its `index.ts`.

Naming inside the module: settings are `kaiserkram.<feature><Key>` (e.g. `traderDefaultMarkup`), flags are nested per feature (`flags.kaiserkram.trader.isTrader`), i18n keys are `kaiserkram.<feature>.…`.

### Branches and releases

- **`test`**: every push builds a pre-release under the reused tag `test-latest`, versioned `<module.json version>.<run number>`. Install it in Foundry with:

  ```
  https://github.com/X4mb/kaiserkram/releases/download/test-latest/module.json
  ```

  It is titled *Kaiserkram (Test)* but uses the same module id as the release, so only one of the two can be installed at a time. Dependabot opens its PRs against `test`.
- **`main`**: bump `version` in `module.json` (and `package.json`), merge `test` into `main`, then push a matching tag (`v0.1.0`). The release workflow checks the version matches the tag, builds `module.zip` and attaches it to a GitHub Release; the manifest's `download` URL always points at the latest release.

Published builds load a version-stamped bundle (`dist/kaiserkram-<version>.js`, set by `scripts/stamp.mjs`), so browsers behind a caching proxy pick up updates right away. Local builds use `dist/kaiserkram.js`.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). The World Landing code was MIT-licensed; its notice is kept in `LICENSE`.
