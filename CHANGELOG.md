# Changelog

## Unreleased

Move around inside a table from the keyboard, without opening cells or changing the table's size.

### New

- Enter on a selected table now selects a cell. Press Enter again to edit it, and Escape to go back.
- Use the arrow keys or Tab to move between cells. Cells stay rendered as you go, so the table keeps its size.
- Copy on a selected cell copies just that cell.

### Improved

- Moving between cells stays fast, however long the note is.
- Escape in a cell now selects that cell, not the whole table.
- Delete at the end of the line above a table now selects the table, like Backspace from the line below.

### Fixed

- Opening a cell from the keyboard can no longer damage a table Obsidian didn't format, such as a hand-typed one. Its frame turns red instead: click a cell to edit it.
- The arrow keys no longer open a cell right after you paste a table.
- Typing with an input method no longer replaces a selected table at the top of a note. The text lands beside the table.

## 0.1.0 (2026-10-30)

First release.

- ↑ and ↓ pass a Live Preview table in one press, without opening a cell.
- ← and → at a table's edge select the whole table, like an image, framed with the thick border Obsidian draws around selected cells. Enter opens its first cell, Escape goes back, Backspace or Delete removes it (undoable), and Copy copies its Markdown.
- Escape in a table cell selects the whole table.
- Shift with an arrow selects a table whole.
