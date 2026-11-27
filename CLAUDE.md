# Better Markdown Tables

An Obsidian plugin, formerly Selectable Tables, whose id stays `selectable-tables`, so installs, settings and hotkeys carry over. It draws every Live Preview table in a note's tab itself, so a large table stays fast (*The plugin's own table*, in `.claude/rules/own-table.md`), and makes it one block for the arrow keys: ↑/↓ stop on it, and ←/→ at its edge select it whole, like an image. Enter then selects a cell, and the arrows move between cells without opening them. The repo, the test vault and the `selectable-tables-` classes in the page keep the old name (Brian, 11/20). `AGENTS.md` holds the generic Obsidian plugin rules (manifest, releases, API use); this file holds what's specific to this repo and overrides it.

## Where things live

- **Repos:** `frankreporting/selectable-tables` is public. The private `frankreporting/selectable-tables-dev` (the `dev` remote) holds the pull requests and history from before it went public on 10/29. Commits use Brian's GitHub no-reply address; never his own address.
- **Backlog:** the Linear team **Better Markdown Tables** (key `BMT`). It was *Selectable Tables* (`STA`) until 11/25, and an `STA-` number still opens the same issue, so those in this file stand. Plans and test plans are Linear documents on their issue. Every issue has an area label: *Plugin*, *Dev tooling*, or *Several areas* with a `Takes:` line naming the areas it holds. Each label's description in Linear lists the files it owns. Issues in different areas can run at the same time, those in the same area one after another, and a spike runs beside anything (see *Parallel work* in the `linear-workflow` skill).
- **Code:** `src/`. `main.ts` registers the array of editor extensions, the freeze commands and `editor-menu`, and `tables.ts` fills the array with the plugin's table and the keys, adds the settings tab and the table commands, and leaves tables to Obsidian when the plugin can't draw them; `src/editor/decide.ts` holds every key decision and the edit guard's rule, `layout.ts` reads the editor's layout, `cells.ts` holds the selected cell, `freeze-mark.ts` reads and writes the mark that freezes a table, `freeze-write.ts` works out what a freeze command writes, `freeze-commands.ts` adds those commands, and the same items to a cell's right-click menu, `freeze.ts` marks a note's frozen tables for `styles.css`, `theme-paint.ts` reads the theme's colors behind their cells, `width-copy.ts` keeps an open cell's column at its width, and `extension.ts` wires them to keys. `src/own-table/` is the plugin's own table (see `.claude/rules/own-table.md`). `width-copy.ts`, most of `freeze.ts` and the parts of the others that handle Obsidian's own table and its cells no longer run since the relaunch; BMT-135 removes them.
- **Tests:** `test/*.test.ts`, bundled by `scripts/test.mjs` with esbuild and run by Node's test runner. Tested code must not import `obsidian` as a value (the package is types only), so keep decisions in modules that take plain CodeMirror state.
- **Test vault:** `test-vault/Selectable Tables Test`, invented notes only. `npm run test-vault` builds the plugin and copies it in; `--to <plugin folder>` on `scripts/install-test-vault.mjs` copies it elsewhere, such as the main clone's test vault from a worktree. *Table 50 by 8* and *Table 2000 by 12* are written by `scripts/make-table-notes.mjs`; git keeps the first, and `npm run test-vault` writes the second, about 860 KB, when it's missing.
- **Timing scripts:** `.dev/measure` in the main clone, ignored through `.git/info/exclude`, so they exist only on Brian's Mac. Their README says how to run them. `measure-plugin.js` is STA-1's before/after: it holds ↓/↑ with the plugin off, on and off again, in the test vault or a vault clone. Time **Markdown in cells** too: opening a cell whose text holds Markdown costs the most. `measure-cells.js` is STA-2's: it holds the arrows across a table's cells, and STA-4's Page and Home/End jumps with `window.__tp = { jumps: true }`.
- **Theme checks:** `.dev/themes` in the main clone, ignored the same way, holds Obsidian's `app.css` and themes' CSS, and runs with no Obsidian open. `compare.cjs` draws a table unfrozen and frozen, marked by a clone's own `DrawnTable`, and compares their pixels at rest, then with rows pinned and the table scrolled sideways, as Obsidian's own table pinned them before the relaunch; with `BASE=<clone>` it also compares the frozen table against another clone's, 0.2.0 say. `timing.cjs` times marking a fresh table, against another clone. `open-cells.cjs` opens a cell as Obsidian does and compares its table's column widths and the cell's height under a clone's rules and another version's (`BASE`, master by default), theme by theme. `center.cjs` checks that a table a theme centers can still be scrolled back to its start, and that no table moves under any other theme, against `BASE`. Their headers say how to run them. `sta88/own.cjs` draws the same invented table as Obsidian's Live Preview widget builds it and as the plugin's own table does, from a clone's real `model.ts` with `sta88/shim.js` standing in for `obsidian`, under Obsidian 1.15.1's `app.css` and the 21 themes of STA-47's survey, and compares column edges, row heights and the pictures with text hidden, within 1 px: one block, across a seam, a short table, a freeze mark, right to left, and with `ENGINE=webkit` on a phone's and a tablet's layout. `sta88/survey.sh` runs a cases file in four shards and `sta88/pivot.py` lists what misses. Run it for any change to how the plugin's table looks. Other themes come from their repos, listed in `community-css-themes.json` in obsidianmd/obsidian-releases.

## Checking Obsidian's behaviors

These are Obsidian behaviors, not calls, so any Obsidian update can change them. **Since the relaunch, this list and the sections after it, up to *The plugin's own table*, describe the plugin on Obsidian's own table, which it no longer runs on.** Parts still hold for the plugin's table, which its own sections point to: the check on key moves, a selected cell being a class, never interfering with a composition, and a theme's colors, which `pins.ts` reads through `theme-paint.ts`. The check script's sections for the rest no longer run, and BMT-135 deletes them. `scripts/obsidian-check.js` tests what the plugin relies on; run it after each Obsidian update. Run it through `node scripts/run-check.mjs` (`--only <section>` for one section or several split by commas, `--install` to build and copy the plugin in first): it sets the test vault up as the checks expect and says what it fixed, runs the sections one at a time, putting the vault back and reloading the plugin between them, reports each as it ends with what it left behind, stops a section that stalls and goes on, always ends with the results or why there are none, and puts back what it changed. Custom hotkeys are set aside in memory and read back from `hotkeys.json`, which it never writes. Its header lists what it fixes. Wait on it, not on the results file.

## How the code works: `.claude/rules/`

How the plugin works, and what it relies on in Obsidian, is in `.claude/rules/`, one file per area. Each loads by itself when a session opens a file it covers (its `paths`). Read the one that covers a behavior before changing it, even from a file it doesn't list. When a PR changes a behavior, update its rule file, not this one: this file holds what every session needs, and has to stay under Claude Code's 40,000-character limit.

- `obsidian-table.md`: what the plugin relies on in Obsidian (the numbered list), the check on key moves, the edit guard, repairing a table, input methods.
- `frozen-tables.md`: frozen rows and columns on Obsidian's table: the mark, its space, a theme's colors and corners, phones and tablets, the iPhone keyboard, keeping a cell clear of what's pinned.
- `own-table.md`: the plugin's own table: what it relies on in Obsidian, matching a theme, timing.
- `own-table-keys.md`: its keys, clicks and typing over a cell.
- `own-table-cell-editing.md`: editing a cell, clearing, cutting and pasting cells, formatting.
- `own-table-frozen.md`: its frozen rows and columns, and the cells of a frozen table.
- `own-table-edits.md`: editing rows and columns, drag handles and + buttons, dragging across cells, a range's menu.

## Before every push

`npm run build` (typecheck included), `npm run lint` and `npm test` must pass. CI runs the same on Node 22 and 24.

`npm run lint` runs what the directory's scan checks, so a release's scorecard holds no surprises:

- **ESLint** with `eslint-plugin-obsidianmd`.
- **Obsidian's CSS rules** (`stylelint-config-obsidianmd`) on `styles.css`, failing on any warning. Their warnings, such as `:has()` and `!important`, are what the scan reports. The formatting rules the config inherits, which the scan doesn't report, are off in `stylelint.config.mjs`.
- **A typecheck of `src` without `@types/node`** (`tsconfig.scan.json`), as the scan's lint runs. Node's types declare newer methods, such as `Array.prototype.at`, than our `lib` has, so the usual typecheck passes them and the scan reports them.
- **`scripts/check-version.mjs`:** `package.json`, `manifest.json` and `versions.json` name the same version. The release workflow runs it with the tag too, and makes no release if they differ.

When `eslint-plugin-obsidianmd` or `stylelint-config-obsidianmd` publishes a new version, update to it before the next release, since the scan may already apply it.

## Releases

Every release gets one set of release notes, written when we're ready to release. They're drafted and edited on the release in Linear, and published on the GitHub release, whose page is the plugin's history of releases. There's no `CHANGELOG.md`, and PRs don't add notes. The README still changes in the PR.

The notes read like Obsidian's own, for an average user:

- **A headline**, an H2 alone, on what the release brings: short like a news headline, not a sentence, and without the plugin's name or version, which the release already shows.
- **Three sections under it, each an H3, in this order: New, Improved, Fixed.** Leave out any that's empty. A release that takes something away starts with a fourth, **Breaking changes**, before them.
- **Short, plain bullets:** one line each, on what the user will notice, in their words. Name keys and buttons, not internals: no issue numbers, function names or Obsidian's internals, and no reasons they don't need.

Linear's release pipeline *Better Markdown Tables*, the plugin's name from the relaunch on, holds the release being built: each push to `master` that changes what ships in the plugin adds its issues to the open release (`.github/workflows/linear-release.yml`, whose paths say what counts). Its access key is the repository's `LINEAR_ACCESS_KEY` secret, and lives nowhere else. Run that workflow by hand, with a tag or commit to sync from, when the open release has to be filled again from scratch; it's a dry run unless that box is unticked.

To release:

1. Draft the notes on the open release in Linear. List its issues with `list_issues` by `release`, read each and its PR, and write the notes with `save_release_note` (`pipeline`, `releases: [<release>]`), not the pipeline's generated ones. Send Brian the link. He edits them there, and his words are the notes. Wait for his OK.
2. Bump the version, and merge that.
3. Tag the release. The release workflow builds a draft on GitHub with the plugin's files, and no notes.
4. Read the notes back with `get_release_note`, write them as they are to a file, and publish the draft with them in one command, so it never goes out without them: `gh release edit <version> --notes-file <file> --draft=false`. Read its body back with `gh release view <version> --json body`, in Node rather than `--jq`, which adds a newline, and compare it with the file. Obsidian's plugin page links to it, and update checkers show it. Publishing runs the Linear workflow: it names the Linear release by its version, links it to the GitHub release and marks it complete, and the next merge that changes the plugin starts a new one. That needs a person's token, as `gh` has: a release published by a workflow's own token starts no workflow. If the run fails, complete the Linear release with `save_release` (stage completed, the version, the link).

## Working in Obsidian

- Drive it through the CLI: `obsidian vault="Selectable Tables Test" eval code=...` and `dev:cdp`. The `obsidian` module can't be loaded from that eval; `window.electron.ipcRenderer.sendSync('version')` gives the app's version. `document.execCommand` skips `beforeinput`, so test typing with real key events (`dev:cdp method=Input.dispatchKeyEvent`).
- An `obsidian://open?path=` link to a folder Obsidian doesn't know raises a system error box that blocks Obsidian until someone clicks OK. To open a vault folder, send `window.electron.ipcRenderer.sendSync('vault-open', <path>, false)` from an open vault, as the vault switcher does; `vault-remove` takes it off the list again.

- Anything that opens Obsidian takes over Brian's screen: ask first, with what opens, for how long, and whether he must keep off the keyboard.
- Only ever the test vault. Never Brian's own vault, and never restart Obsidian without asking (a restart also installs a pending Obsidian update).
- Obsidian's own code is in `~/Library/Application Support/obsidian/obsidian-<version>.asar`. To read it, extract `app.js` with a small asar reader (a 16-byte header, then a JSON index of offsets) into a scratch folder, never into the repo.

## No personal data

The repo is public, so nothing personal goes into commits, PRs, tests or the test vault: invented notes and values only.
