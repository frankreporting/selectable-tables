# Selectable Tables

An Obsidian plugin (`selectable-tables`) that makes a Live Preview table one block for the arrow keys: ↑/↓ pass it in one press, and ←/→ at its edge select it whole, like an image. `AGENTS.md` holds the generic Obsidian plugin rules (manifest, releases, API use); this file holds what's specific to this repo and overrides it.

## Where things live

- **Backlog:** the Linear team **Selectable Tables** (key `STA`). Plans and test plans are Linear documents on their issue. There are no area labels yet: every issue runs alone.
- **Code:** `src/`. `main.ts` only registers the editor extension.
- **Tests:** `test/*.test.ts`, bundled by `scripts/test.mjs` with esbuild and run by Node's test runner. Tested code must not import `obsidian` as a value (the package is types only), so keep decisions in modules that take plain CodeMirror state.
- **Test vault:** `test-vault/Selectable Tables Test`, invented notes only. `npm run test-vault` builds and copies the plugin in.
- **Timing scripts:** `.dev/measure` in the main clone, ignored through `.git/info/exclude`, so they exist only on Brian's Mac. Their README says how to run them.

## Before every push

`npm run build` (typecheck included), `npm run lint` and `npm test` must pass. CI runs the same on Node 22 and 24.

## Working in Obsidian

- Anything that opens Obsidian takes over Brian's screen: ask first, with what opens, for how long, and whether he must keep off the keyboard.
- Only ever the test vault. Never Brian's own vault, and never restart Obsidian without asking (a restart also installs a pending Obsidian update).
- Obsidian's own code is in `~/Library/Application Support/obsidian/obsidian-<version>.asar`. To read it, extract `app.js` with a small asar reader (a 16-byte header, then a JSON index of offsets) into a scratch folder, never into the repo.

## No personal data

The repo is private, but nothing personal goes into commits, PRs, tests or the test vault: invented notes and values only.
