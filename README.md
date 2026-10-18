# Kaiserkram

A box of opt-in Foundry VTT tools by X4mb, merged from four stand-alone modules. **Foundry v14 only.**

Every feature is **off** until you enable it. A disabled feature registers nothing: no settings, hooks, keybindings, sheets, socket handlers, CSS or templates.

| Feature | Group | What it does | Replaces |
|---|---|---|---|
| **World Landing** | General | Right-click a scene → *Set as Default Scene*. It is activated whenever the world starts (GM only). | `world-landing-fvtt` |
| **Deploy Party** | General | Drag an actor folder onto the canvas to get one party marker. Players can move the marker and see from it (it is backed by an actor every player owns, kept in a *Party Markers* actor folder; turn this off in the settings). The marker's actor is also the party's shared inventory: items dragged between it and a character (onto its sheet or onto the marker token) move rather than copy. **Party stash** (players double-click the marker, or use its Token HUD button; the GM's double-click still opens the sheet) shows the party's inventory beside one of your characters: use the arrows to move an amount, or drag a whole stack across. A *Party sheet* button in the stash opens the actor sheet. From its Token HUD the GM *Deploys* every actor as its own token and *Recalls* them. **Trading:** right-click another character's or an NPC's token → *Offer … a trade*, or use the **Trade** tool in the token controls (or the Trade button on your own token's HUD) for your target or someone nearby. The trade window shows your inventory beside the two offers: drag (or click) goods into your offer, and type how much money to add. Both sides accept; the GM's client makes the swap, so a GM must be online. A player's character is answered only by its own player (if they're offline, you're told so); NPCs are answered by the GM. **Give** (same right-click menu, token-control tool and HUD) hands items or money over at once, without the receiver having to accept; their player is told and a chat card records it. | `deploy-party` |
| **Within Earshot** | General | Proximity voice: how loud others are follows token distance and walls. Optional global GM voice, and a voice-token shortcut (default Ctrl+Shift+V). **Whisper** (token controls, or Alt+W): while on, a player is only heard by those within one square (the GM still hears them), and everyone who can see their token sees a purple speech-bubble badge on it. **Speaking ring:** a soft green ring shows on a token while its player is talking, for everyone who can see the token (turn it off per client in the settings). GM voice changer: **Assign Voice** (Token HUD, token or Actors right-click, Token Config) gives an actor a voice (presets, pitch, bass/treble, growl, echo, with a live headphone preview); the GM speaks with it while their voice is pinned to that actor's token. Replaces Foundry's A/V client. | `withinearshot` |
| **Trader** | WFRP4e | Turns a WFRP4e NPC into a shop: players buy and sell with the coins on their character, and haggle. Only offered in WFRP4e worlds. | `trader-wfrp4e` |

## Installation

Setup → **Add-on Modules** → **Install Module**, paste this manifest URL and click Install:

```
https://raw.githubusercontent.com/X4mb/kaiserkram/main/module.json
```

Enable **Kaiserkram** in the world's **Manage Modules**, then as GM open **Configure Settings → Kaiserkram → Kaiserkram Features**, tick the features you want and save. Foundry asks to reload once at the end.

Each enabled feature adds its own settings under Configure Settings → Kaiserkram, and Within Earshot's keybindings appear under Configure Controls → Kaiserkram.

## Using the Trader

A trader is an ordinary WFRP4e NPC that keeps its normal NPC sheet (for stats and the trader's coins). Its shop opens in a window of its own, with **Buy**, **Sell** and, for the GM, **Manage** tabs.

1. **Make a trader.** In the Actors sidebar, click **Create Trader**, or right-click an NPC → **Make Trader**. The shop window opens on the Manage tab.
2. **Stock it.** Drag items from the Items sidebar, a compendium or an actor onto the shop window. In Manage, set each item's count, ∞ for unlimited stock, a fixed price, and whether it is for sale.
3. **Set prices.** *Markup* is what the trader charges, as a % of book price; *Buy-back rate* is what it pays players.
4. **Open the shop.** The GM's buttons sit in a bar under the trader's name. **Open shop** lets players in and posts an *open for business* card in chat; **Close shop** shuts them out. **Show to players** opens the shop if needed and pops the window up on every connected player's screen.
   The bar also has **NPC sheet** for the trader's stats and coins.
5. **Players trade.** They get in through the chat card's **Enter the shop** button, the **Shops** button at the top of the Actors sidebar, or by double-clicking the trader's token. They pick the character they trade as, then buy or haggle in **Buy** and sell in **Sell** (or drag an item from their character sheet onto the shop). Coins move automatically. A GM has to be online, because the trades run on the GM's client.

**Haggling** is an opposed Haggle test against the trader. The player picks a discount up to 80%; their test gets harder the more they ask, the trader's has no modifier:

| Discount asked | up to 10% | 20% | 30% | 40% | 50% | 60% | 70% | 80% |
|---|---|---|---|---|---|---|---|---|
| Player's modifier | ±0 | −10 | −20 | −30 | −45 | −55 | −65 | −80 |

Higher SL wins (on a tie, the higher skill). Win, and the next purchase of that item gets exactly the discount asked for; lose, and the price stays. Each character gets one try per item unless *Haggle: allow repeat attempts* is on; **Reset haggling** in Manage clears all tries and deals.

The GM can also open any shop from the trader's Token HUD, from right-click → **Open Shop**, or from **Shops**. The Manage tab has a collapsible **How this works** box with these steps.

## Moving from the old modules

The first time a GM loads a world with Kaiserkram enabled, Kaiserkram copies the old modules' data into its own namespace. This happens once, whether or not any feature is enabled yet:

- world settings of all four modules
- traders: their flags and their stock flags (fixed prices, unlimited stock, not for sale). They go back to the normal NPC sheet and shop in their own window
- party markers and deployed tokens, so Deploy and Recall keep working
- per-actor voice profiles
- the landing scene
- image paths that pointed into the old modules' folders
- unlinked tokens: trader flags and haggle state stored on the token itself

A notice lists which features had data. **Those features stay off until you enable them.** Nothing is deleted: the old flags and settings stay where they were. The one thing that is switched over is each trader's sheet (back to the NPC sheet), so if you go back to the old Trader module, pick its sheet again in the trader's sheet configuration.

Then disable the four old modules. Running a feature next to the module it replaces doubles its hooks, registers two trader sheets, or fights over the A/V client; Kaiserkram warns the GM if it sees that.

Not migrated:

- **Compendium actors.** Traders stored in a compendium still carry the old module's data; after importing one, right-click it → **Make Trader**.
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
