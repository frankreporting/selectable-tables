# Selectable Tables

An Obsidian plugin (`selectable-tables`) that makes a Live Preview table one block for the arrow keys: ↑/↓ pass it in one press, and ←/→ at its edge select it whole, like an image. Enter then selects a cell, and the arrows move between cells without opening them. `AGENTS.md` holds the generic Obsidian plugin rules (manifest, releases, API use); this file holds what's specific to this repo and overrides it.

## Where things live

- **Repos:** `frankreporting/selectable-tables` is public. The private `frankreporting/selectable-tables-dev` (the `dev` remote) holds the pull requests and history from before it went public on 10/29. Commits use Brian's GitHub no-reply address; never his own address.
- **Backlog:** the Linear team **Selectable Tables** (key `STA`). Plans and test plans are Linear documents on their issue. There are no area labels yet: every issue runs alone.
- **Code:** `src/`. `main.ts` only registers the editor extension; `src/editor/decide.ts` holds every key decision and the edit guard's rule, `layout.ts` reads the editor's layout, `cells.ts` holds the selected cell, and `extension.ts` wires them to keys.
- **Tests:** `test/*.test.ts`, bundled by `scripts/test.mjs` with esbuild and run by Node's test runner. Tested code must not import `obsidian` as a value (the package is types only), so keep decisions in modules that take plain CodeMirror state.
- **Test vault:** `test-vault/Selectable Tables Test`, invented notes only. `npm run test-vault` builds and copies the plugin in.
- **Timing scripts:** `.dev/measure` in the main clone, ignored through `.git/info/exclude`, so they exist only on Brian's Mac. Their README says how to run them. `measure-plugin.js` is STA-1's before/after: it holds ↓/↑ with the plugin off, on and off again, in the test vault or a vault clone. Time **Markdown in cells** too: opening a cell whose text holds Markdown costs the most. `measure-cells.js` is STA-2's: it holds the arrows across a table's cells.

## What the plugin relies on in Obsidian

These are Obsidian behaviors, not calls, so any Obsidian update can change them. `scripts/obsidian-check.js` tests them first; run it after each Obsidian update (its header says how).

1. A rendered table is one block widget in the editor, carrying the class `cm-table-widget`.
2. A caret inside a table's text opens a cell; a selection over the whole table opens none.
3. Focusing the note's editor closes an open cell.
4. A table's rows and cells on screen line up with its text: the header is row 0, the delimiter line has no row, and a short row is filled with empty cells.
5. A caret in a cell's text opens exactly that cell.
6. The selected table's tint is drawn on the table element, so the plugin can take it off while a cell is selected.
7. A press on a cell of a table Obsidian didn't write tidies the table, which is what makes Enter work on it again.

The plugin makes no private Obsidian calls. It reads only CodeMirror's public layout (`lineBlockAt`, `posAtDOM`, `moveVertically`) and `editorLivePreviewField`, plus three classes Obsidian puts in the DOM: `cm-table-widget`, to tell a cell's editor from a note's, `mod-image-selected`, and `has-selection`, which marks a dragged range of cells.

**A selected cell is a class, not a selection.** The note's selection stays on the whole table, and a move between cells dispatches no transaction, because each one walks the whole note in Live Preview and runs every plugin's listeners. So the edit guard is all that stops an edit meant for "the selection" from hitting the whole table. How edits reach it, read from Obsidian 1.15.0 and run on 10/30:

- Obsidian's editor commands, such as Toggle comment (Cmd+/), Toggle checkbox (Cmd+L) and Insert horizontal rule, send no user event. The table's own menus and + buttons send none either, and by then Obsidian has already changed the drawn table, so they must never be dropped: a press in the note takes the cell off first.
- A reload from disk, which is how Sync arrives, carries `userEvent: "set"`.
- A second pane on the same note arrives as a remote edit with `filter: false`, so it skips transaction filters.

**A caret doesn't repair a table; a press does.** Obsidian keeps its own model of a table's cells, and marks the table malformed when its text isn't what the table editor writes (uneven rows, other padding), or after closing a cell trims it, which changes the model without telling the note. A press opens a cell through `setCellFocus`, which rewrites a malformed table first. A caret landing in a cell skips that, and then typing can eat a pipe, or never reach the note. So Enter opens a cell only when `writtenByObsidian` in `table-text.ts` says the table's text is exactly what Obsidian's editor would write. That check rebuilds the text and compares it, on purpose: a wrong answer costs a click, while a check that tries to predict Obsidian's private flag can let a corrupting caret through. Don't bring back a keyboard repair by putting the caret on the delimiter line: it rewrites the table with the caret there, so undo goes back to that caret and Obsidian rewrites the table again, and undo can never get past it. Stock Obsidian has the corruption too when you arrow into a table.

**Never interfere with a running composition.** Dropping composed input in the guard, or moving the selection in `compositionstart`, leaves `view.composing` true for good. CodeMirror then ignores keys, and Live Preview stops rebuilding, so new notes draw no tables until the editor is replaced. An input method's keydown (key code 229) comes before its composition, and that's the only safe moment to move the selection. Simulated composition (`Input.imeSetComposition`) must be finished with `Input.insertText`, or it freezes the test window the same way. Editor commands like Toggle line numbers are saved to the vault's tracked `app.json`, so a sweep of commands has to skip them.

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

The repo is public, so nothing personal goes into commits, PRs, tests or the test vault: invented notes and values only.
