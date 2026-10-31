/** How many of a table's first rows and columns stay in view as it scrolls. */
export interface Freeze {
	rows: number;
	columns: number;
}

/** The most columns a table can freeze. styles.css has a rule for each count, up to this. */
export const MAX_FROZEN_COLUMNS = 9;

const NOTHING_FROZEN: Freeze = { rows: 0, columns: 0 };

const codeSpan = /(`+)[^`]+\1/g;
const mark = /%%\s*freeze\s+(\d+)\s+(\d+)\s*%%/;

/**
 * What a table's header row freezes. `%%freeze 2 1%%` in any of its cells is 2 rows and 1 column: a comment
 * draws as nothing, and it's part of the cell's text, which Obsidian writes back when it rewrites the table.
 * This is the only place a freeze is stored, so nothing can disagree with it. Code shows its text, so the
 * mark in a code span is a table talking about the mark. Rows are clamped by whoever knows the table's size.
 */
export function readFreeze(header: string): Freeze {
	const found = mark.exec(header.replace(codeSpan, ''));
	if (!found) return NOTHING_FROZEN;
	return { rows: Number(found[1]), columns: Math.min(Number(found[2]), MAX_FROZEN_COLUMNS) };
}
