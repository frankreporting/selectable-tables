# Selectable Tables

An Obsidian plugin (`selectable-tables`) that makes a Live Preview table one block for the arrow keys: ↑/↓ pass it in one press, and ←/→ at its edge select it whole, like an image. `AGENTS.md` holds the generic Obsidian plugin rules (manifest, releases, API use); this file holds what's specific to this repo and overrides it.

## Where things live

- **Backlog:** the Linear team **Selectable Tables** (key `STA`). Plans and test plans are Linear documents on their issue. There are no area labels yet: every issue runs alone.
- **Code:** `src/`. `main.ts` only registers the editor extension; `src/editor/decide.ts` holds every key decision, `layout.ts` reads the editor's layout, and `extension.ts` wires them to keys.
- **Tests:** `test/*.test.ts`, bundled by `scripts/test.mjs` with esbuild and run by Node's test runner. Tested code must not import `obsidian` as a value (the package is types only), so keep decisions in modules that take plain CodeMirror state.
- **Test vault:** `test-vault/Selectable Tables Test`, invented notes only. `npm run test-vault` builds and copies the plugin in.
- **Timing scripts:** `.dev/measure` in the main clone, ignored through `.git/info/exclude`, so they exist only on Brian's Mac. Their README says how to run them. `measure-plugin.js` is STA-1's before/after: it holds ↓/↑ with the plugin off, on and off again, in the test vault or a vault clone. Time **Markdown in cells** too: opening a cell whose text holds Markdown costs the most.

## What the plugin relies on in Obsidian

These are Obsidian behaviors, not calls, so any Obsidian update can change them. `scripts/obsidian-check.js` tests all three first; run it after each Obsidian update (its header says how).

1. A rendered table is one block widget in the editor, carrying the class `cm-table-widget`.
2. A caret inside a table's text opens a cell; a selection over the whole table opens none.
3. Focusing the note's editor closes an open cell.

The plugin makes no private Obsidian calls. It reads only CodeMirror's public layout (`lineBlockAt`, `posAtDOM`, `moveVertically`) and `editorLivePreviewField`, plus two classes Obsidian puts in the DOM: `cm-table-widget`, to tell a cell's editor from a note's, and `mod-image-selected`.

A table is a block widget over text that reads as a Markdown table. At a note's start or right below the frontmatter, Obsidian draws a table with an exclusive start, and CodeMirror then reports the line as an empty text part plus the widget; `partAt` in `layout.ts` handles that. Unit tests use a fake layout (`test/notes.ts`), which can't show such details, so check layout changes against a real editor too. Since the check is the text, another plugin's block widget drawn over table Markdown would count as a table too.

## Before every push

`npm run build` (typecheck included), `npm run lint` and `npm test` must pass. CI runs the same on Node 22 and 24.

## Working in Obsidian

- Drive it through the CLI: `obsidian vault="Selectable Tables Test" eval code=...` and `dev:cdp`. The `obsidian` module can't be loaded from that eval; `window.electron.ipcRenderer.sendSync('version')` gives the app's version. `document.execCommand` skips `beforeinput`, so test typing with real key events (`dev:cdp method=Input.dispatchKeyEvent`).
- An `obsidian://open?path=` link to a folder Obsidian doesn't know raises a system error box that blocks Obsidian until someone clicks OK. To open a vault folder, send `window.electron.ipcRenderer.sendSync('vault-open', <path>, false)` from an open vault, as the vault switcher does; `vault-remove` takes it off the list again.

- Anything that opens Obsidian takes over Brian's screen: ask first, with what opens, for how long, and whether he must keep off the keyboard.
- Only ever the test vault. Never Brian's own vault, and never restart Obsidian without asking (a restart also installs a pending Obsidian update).
- Obsidian's own code is in `~/Library/Application Support/obsidian/obsidian-<version>.asar`. To read it, extract `app.js` with a small asar reader (a 16-byte header, then a JSON index of offsets) into a scratch folder, never into the repo.

## No personal data

The repo is private, but nothing personal goes into commits, PRs, tests or the test vault: invented notes and values only.
