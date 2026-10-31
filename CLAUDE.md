# Selectable Tables

An Obsidian plugin (`selectable-tables`) that makes a Live Preview table one block for the arrow keys: ↑/↓ pass it in one press, and ←/→ at its edge select it whole, like an image. Enter then selects a cell, and the arrows move between cells without opening them. `AGENTS.md` holds the generic Obsidian plugin rules (manifest, releases, API use); this file holds what's specific to this repo and overrides it.

## Where things live

- **Repos:** `frankreporting/selectable-tables` is public. The private `frankreporting/selectable-tables-dev` (the `dev` remote) holds the pull requests and history from before it went public on 10/29. Commits use Brian's GitHub no-reply address; never his own address.
- **Backlog:** the Linear team **Selectable Tables** (key `STA`). Plans and test plans are Linear documents on their issue. There are no area labels yet: every issue runs alone, except a spike (see *Parallel work* in the global `CLAUDE.md`).
- **Code:** `src/`. `main.ts` only registers the editor extension; `src/editor/decide.ts` holds every key decision and the edit guard's rule, `layout.ts` reads the editor's layout, `cells.ts` holds the selected cell, and `extension.ts` wires them to keys.
- **Tests:** `test/*.test.ts`, bundled by `scripts/test.mjs` with esbuild and run by Node's test runner. Tested code must not import `obsidian` as a value (the package is types only), so keep decisions in modules that take plain CodeMirror state.
- **Test vault:** `test-vault/Selectable Tables Test`, invented notes only. `npm run test-vault` builds and copies the plugin in.
- **Timing scripts:** `.dev/measure` in the main clone, ignored through `.git/info/exclude`, so they exist only on Brian's Mac. Their README says how to run them. `measure-plugin.js` is STA-1's before/after: it holds ↓/↑ with the plugin off, on and off again, in the test vault or a vault clone. Time **Markdown in cells** too: opening a cell whose text holds Markdown costs the most. `measure-cells.js` is STA-2's: it holds the arrows across a table's cells, and STA-4's Page and Home/End jumps with `window.__tp = { jumps: true }`.

## What the plugin relies on in Obsidian

These are Obsidian behaviors, not calls, so any Obsidian update can change them. `scripts/obsidian-check.js` tests them first; run it after each Obsidian update (its header says how).

1. A rendered table is one block widget in the editor, carrying the class `cm-table-widget`.
2. A caret inside a table's text opens a cell; a selection over the whole table opens none.
3. Focusing the note's editor closes an open cell.
4. A table's rows and cells on screen line up with its text: the header is row 0, the delimiter line has no row, and a short row is filled with empty cells.
5. A caret in a cell's text opens exactly that cell.
6. The selected table's tint is drawn on the table element, so the plugin can take it off while a cell is selected.
7. A press on a cell of a malformed table tidies it, which is what makes Enter work on it again. A table with only unusual padding stays as it is, and a press still opens its cells.
8. An open cell keeps its rendered text in a `.table-cell-wrapper` hidden with an inline `display: none`, beside the wrapper holding its editor. `styles.css` keeps that text in the layout so the column holds its width. If this changes, the rule stops matching, and columns move again as in stock Obsidian.
9. Word jumps, Option+↑/↓, and the other moves a key can make across lines send the user event `select`. A click sends `select.pointer`, and Obsidian's own moves between cells send none.
10. Page Up/Down pass a drawn table from a line of text, since CodeMirror's page move steps out of block widgets. A table only becomes a block once Obsidian's parser reaches it, and a held key outruns the parser, so a table can still be lines of text when a move lands on it.
11. Obsidian binds Page Up/Down, Cmd+↑/↓, Ctrl+↑/↓ and Cmd+Home/End in a cell's editor as plain keys that hand over to the note, at a lower precedence than the plugin's keymap.
12. Vim puts `cm-vimMode` on the editor's scroller outside insert mode.

The plugin makes no private Obsidian calls. It reads only CodeMirror's public layout (`lineBlockAt`, `posAtDOM`, `moveVertically`), `editorLivePreviewField` and `editorEditorField`, plus four classes Obsidian puts in the DOM: `cm-table-widget`, to tell a cell's editor from a note's, `mod-image-selected`, `has-selection`, which marks a dragged range of cells, and `cm-vimMode`.

**The check on key moves.** `landing` in `decide.ts`, run as a transaction filter, is the one place that stops a key opening a cell: a move that sends `select`, other than a click's `select.pointer` or a search's `select.search`, and leaves one caret in a table's text selects the table instead, or is dropped from that same table selected or from a selected cell. So there's no list of keys to keep, and other plugins' move commands are covered too. Obsidian's Home, End and Cmd+←/→ send no user event, so the check can't see them; they can't cross a line, and the plugin's own bindings take them, with or without Shift, on a selected table or cell, and when a head sits on a table's edge. A browser-driven selection change gets `select` by default, so it passes through the check too. A big jump (Page Up/Down, Cmd+↑/↓, Cmd+Home/End, Ctrl+↑/↓) can land on a table that's still text, and a cell opens once Obsidian draws it; stock Obsidian does this too, on a held Page Down, but there the key carries on, while here Page Down in a cell stays in the table. So for these keys alone the check reads the table from the text and goes past it. Other keys don't, since text near the caret that reads as a table really is text, as in a code block. The check stands aside for what must still open a cell: a click, Enter's caret (`opensCell`), and a plain arrow the plugin left to Obsidian, which enters a table with no line beyond it. It also stands aside while Vim is driving, since selecting a table in normal mode would start Visual mode.

**A selected cell is a class, not a selection.** The note's selection stays on the whole table, and a move between cells dispatches no transaction, because each one walks the whole note in Live Preview and runs every plugin's listeners. So the edit guard is all that stops an edit meant for "the selection" from hitting the whole table. How edits reach it, read from Obsidian 1.15.0 and run on 10/30:

- Obsidian's editor commands, such as Toggle comment (Cmd+/), Toggle checkbox (Cmd+L) and Insert horizontal rule, send no user event. The table's own menus and + buttons send none either, and by then Obsidian has already changed the drawn table, so they must never be dropped: a press in the note takes the cell off first.
- A reload from disk, which is how Sync arrives, carries `userEvent: "set"`.
- A second pane on the same note arrives as a remote edit with `filter: false`, so it skips transaction filters.

**A caret doesn't repair a table; a press does.** Obsidian keeps its own model of a table's cells, and marks the table malformed when its text isn't what the table editor writes (uneven rows, other padding), or after closing a cell trims it, which changes the model without telling the note. A press opens a cell through `setCellFocus`, which rewrites a malformed table first. A caret landing in a cell skips that, and then typing can eat a pipe, or never reach the note. So Enter opens a cell only when `writtenByObsidian` in `table-text.ts` says the table's rows are exactly what Obsidian's editor would write. That check rebuilds the rows and compares them, on purpose: a wrong answer usually costs a click, while a check that tries to predict Obsidian's private flag can let a corrupting caret through. It can't see a stale model behind exact text, which undo can leave after a cell's trailing spaces are trimmed; a stock click does the same damage there. Don't bring back a keyboard repair by putting the caret on the delimiter line: it rewrites the table with the caret there, so undo goes back to that caret and Obsidian rewrites the table again, and undo can never get past it. Stock Obsidian has the corruption too when you arrow into a table.

**Never interfere with a running composition.** Dropping composed input in the guard, or moving the selection in `compositionstart`, leaves `view.composing` true for good. CodeMirror then ignores keys, and Live Preview stops rebuilding, so new notes draw no tables until the editor is replaced. An input method's keydown (key code 229) comes before its composition, and that's the only safe moment to move the selection. Simulated composition (`Input.imeSetComposition`) must be finished with `Input.insertText`, or it freezes the test window the same way. Editor commands like Toggle line numbers are saved to the vault's tracked `app.json`, so a sweep of commands has to skip them.

A table is a block widget over text that reads as a Markdown table. At a note's start or right below the frontmatter, Obsidian draws a table with an exclusive start, and CodeMirror then reports the line as an empty text part plus the widget; `partAt` in `layout.ts` handles that. Obsidian keeps a blank line around the tables it makes, so a table with no line beside it only comes from a note written elsewhere, and isn't a case to plan or test for. `Table first`, `Table last` and `Properties then table` in the test vault are written that way by hand, so they don't show what real notes do. Unit tests use a fake layout (`test/notes.ts`), which can't show such details, so check layout changes against a real editor too. Since the check is the text, another plugin's block widget drawn over table Markdown would count as a table too.

## Before every push

`npm run build` (typecheck included), `npm run lint` and `npm test` must pass. CI runs the same on Node 22 and 24.

## Releases

Every release gets one set of release notes, written when we're ready to release. `CHANGELOG.md` holds only released versions, so there's no Unreleased section, and PRs don't add to it: this replaces the usual changelog entry in each PR. The README still changes in the PR.

The notes read like Obsidian's own, for an average user:

- **One opening sentence** on what the release brings.
- **Three headings, in this order: New, Improved, Fixed.** Leave out any that's empty.
- **Short, plain bullets:** one line each, on what the user will notice, in their words. Name keys and buttons, not internals: no issue numbers, function names or Obsidian's internals, and no reasons they don't need.

To release:

1. Draft the notes in `.dev/release-notes.md` in the main clone, which git ignores, from what merged since the last tag (`git log <tag>..master` and those PRs' descriptions). Keep anything already in that file.
2. Open that file in Zed for Brian (`zed <path>`; he's asked for this each time, so it needs no asking first). He edits it there and saves, and his words are the notes. Wait for his OK.
3. Add them to `CHANGELOG.md` as `## <version> (<date>)`, bump the version, and merge that.
4. Tag the release. The release workflow builds a draft on GitHub with no notes.
5. Paste the same notes into that draft, and publish. Obsidian's plugin page links to it, and update checkers show it. Then empty `.dev/release-notes.md`.

## Working in Obsidian

- Drive it through the CLI: `obsidian vault="Selectable Tables Test" eval code=...` and `dev:cdp`. The `obsidian` module can't be loaded from that eval; `window.electron.ipcRenderer.sendSync('version')` gives the app's version. `document.execCommand` skips `beforeinput`, so test typing with real key events (`dev:cdp method=Input.dispatchKeyEvent`).
- An `obsidian://open?path=` link to a folder Obsidian doesn't know raises a system error box that blocks Obsidian until someone clicks OK. To open a vault folder, send `window.electron.ipcRenderer.sendSync('vault-open', <path>, false)` from an open vault, as the vault switcher does; `vault-remove` takes it off the list again.

- Anything that opens Obsidian takes over Brian's screen: ask first, with what opens, for how long, and whether he must keep off the keyboard.
- Only ever the test vault. Never Brian's own vault, and never restart Obsidian without asking (a restart also installs a pending Obsidian update).
- Obsidian's own code is in `~/Library/Application Support/obsidian/obsidian-<version>.asar`. To read it, extract `app.js` with a small asar reader (a 16-byte header, then a JSON index of offsets) into a scratch folder, never into the repo.

## No personal data

The repo is public, so nothing personal goes into commits, PRs, tests or the test vault: invented notes and values only.
