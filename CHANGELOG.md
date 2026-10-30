# Changelog

## Unreleased

- Enter on a selected table selects a cell. The arrows and Tab move the selection between cells without opening them, so the table keeps its size and each press stays fast, whatever the note's length or your plugins. Enter opens the selected cell, and Escape climbs back up.
- Escape in a cell selects that cell, not the whole table.
- Copy on a selected cell copies its Markdown.

## 0.1.0 (2026-10-30)

First release.

- ↑ and ↓ pass a Live Preview table in one press, without opening a cell.
- ← and → at a table's edge select the whole table, like an image, framed with the thick border Obsidian draws around selected cells. Enter opens its first cell, Escape goes back, Backspace or Delete removes it (undoable), and Copy copies its Markdown.
- Escape in a table cell selects the whole table.
- Shift with an arrow selects a table whole.
