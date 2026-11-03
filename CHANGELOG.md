# Changelog

## 0.2.2 (2026-11-02)

Typing on a selected table now starts a new paragraph below it

### Improved

- Typing on a selected table or cell starts a new paragraph below the table, with a blank line on each side, instead of doing nothing. One undo takes it back.

### Fixed

- Typing with an input method, such as Japanese, or an accent like Option+E, on a table selected from above no longer turns the table into raw Markdown.

## 0.2.1 (2026-11-02)

Expanded theme support for frozen tables

### Fixed

- Freezing a table no longer removes certain themes' lines between rows and columns, as it did in Baseline.
- Frozen rows and columns keep more themes' colors, alternating rows included.
- Tested and working in Obsidian's default theme, Baseline, Minimal, Things, Catppuccin, Prism and Blue Topaz, in light and dark.

## 0.2.0 (2026-11-02)

Frozen rows and columns: Keep a table's first rows and columns in view as you scroll

### New

- Freeze a table's first rows and columns, like freeze panes in a spreadsheet. Add a comment to any cell of its header row: `%%freeze 2 1%%` keeps 2 rows and 1 column in view.
- A note can have any number of frozen tables.
- For now this works in Live Preview only, and dragging across cells in a frozen table selects the wrong cells. Future updates fix that. Commands will also be added so you don't have to manually add the freeze comments to each table.

## 0.1.1 (2026-10-31)

Selectable cells: Navigate cells without opening them or showing their raw Markdown

### New

- Enter on a selected table now selects a cell. Press Enter again to edit it, and Escape to go back.
- Use the arrow keys or Tab to move between cells. Cells stay rendered, so the table doesn't get deformed as you go.
- Home and End jump to the ends of a row, and Page Up and Page Down to the ends of a column.
- Copy on a selected cell copies just that cell.

### Improved

- Moving between cells stays fast, however long the note is. (Note that Obsidian itself struggles with really long Markdown tables of, say, 2,000 rows.)
- An open cell keeps its width, so the columns stay put while you edit. Only its height changes to show everything.
- Escape in a cell now re-selects that cell, not the whole table.
- Delete at the end of the line above a table now selects the table, like Backspace from the line below.
- Word jumps and Option+↑ or ↓ next to a table now select it, instead of opening a cell.
- Page Up, Page Down and Option with an arrow now leave a selected table.
- Page Up, Page Down, Cmd+↑ and Cmd+↓ in an open cell now stay in the table: they select the top or bottom cell of its column.

### Fixed

- Opening a cell from the keyboard can no longer damage a table Obsidian didn't format, such as a hand-typed one. Its frame turns red instead: click a cell to edit it, which usually fixes the table.
- The arrow keys no longer open a cell right after you paste a table.
- Typing with an input method no longer replaces a selected table at the top of a note. The text lands beside the table.

## 0.1.0 (2026-10-30)

First release.

- ↑ and ↓ pass a Live Preview table in one press, without opening a cell.
- ← and → at a table's edge select the whole table, like an image, framed with the thick border Obsidian draws around selected cells. Enter opens its first cell, Escape goes back, Backspace or Delete removes it (undoable), and Copy copies its Markdown.
- Escape in a table cell selects the whole table.
- Shift with an arrow selects a table whole.
