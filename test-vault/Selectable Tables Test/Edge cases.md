# Edge cases

## A long heading right above a table, long enough to wrap over two or three lines in a normal-width pane, so that ↓ walks its wrapped lines before passing the table
| Step | Note   |
| ---- | ------ |
| One  | First  |
| Two  | Second |
A long paragraph right below the table. It runs on long enough to wrap over several lines in a normal-width pane, so that ↑ from its last line walks up through its wrapped lines first, and only the press from its first line passes the table above it. The quick brown fox jumps over the lazy dog, and then it does so again, until this paragraph wraps at least twice.

> [!note] A callout with a table inside
> | Key   | Value |
> | ----- | ----- |
> | Alpha | 1     |
> | Beta  | 2     |

- A list item with a table under it

	| Col | Val |
	| --- | --- |
	| x   | 1   |

Two tables with one blank line between them:

| A   | B   |
| --- | --- |
| 1   | 2   |

| C   | D   |
| --- | --- |
| 3   | 4   |

The last line.
