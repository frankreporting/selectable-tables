# Changelog

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
