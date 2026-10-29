# Selectable Tables

An Obsidian plugin for Live Preview. It lets the arrow keys pass a table in one press, and select a whole table as one block, the way Obsidian treats an image.

Without it, every arrow press that lands in a table opens an editor for that cell. Holding ↓ through a note stalls at every table, and links in the table flicker as cells switch between rendered and source text.

The plugin is in development and not yet in the community plugin list.

## Development

Requires Node.js 22 or later.

```bash
npm install
npm run dev         # build main.js and rebuild on every change
npm run build       # typecheck, then a production build
npm test            # unit tests (Node's built-in test runner)
npm run lint        # ESLint with Obsidian's plugin rules
```

### Test vault

`test-vault/Selectable Tables Test` is a vault of invented notes for trying the plugin by hand. Each note matches a section of the test plan.

```bash
npm run test-vault  # build, then copy the plugin into the test vault
```

Open the folder as a vault in Obsidian (**Open another vault → Open folder as vault**), turn on community plugins when asked, and enable **Selectable Tables** in **Settings → Community plugins**. Obsidian keeps its own state in the vault's `.obsidian` folder; git ignores all of it except `app.json` and `community-plugins.json`.

`scripts/make-long-note.mjs` regenerates the vault's **Long note**, which is used only for timing.

## License

[MIT](LICENSE)
