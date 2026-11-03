import type { Text } from '@codemirror/state';
import { Freeze, hasMark, MAX_FROZEN_COLUMNS, readFreeze, withFreeze, withoutMark } from './freeze-mark';
import { Cell, onlyDashes, rewrittenWith, rowCells, Span, writtenByObsidian } from './table-text';

/** The commands: freeze rows up to a cell, columns up to it, everything above it and to its left, or nothing. */
export type FreezeCommand = 'rows' | 'columns' | 'cell' | 'none';

/**
 * What a command freezes from a cell, given what's frozen now. Rows up to the cell's keep the frozen columns,
 * and columns up to it keep the rows. At the cell, as in a spreadsheet, the cell itself isn't frozen.
 * `clamped` says the columns asked for were more than a table can freeze.
 */
export function freezeAt(command: FreezeCommand, now: Freeze, { row, column }: Cell): { freeze: Freeze; clamped: boolean } {
	const columns = command === 'columns' ? column + 1 : command === 'cell' ? column : now.columns;
	const freeze = {
		rows: command === 'rows' ? row + 1 : command === 'cell' ? row : command === 'none' ? 0 : now.rows,
		columns: command === 'none' ? 0 : Math.min(columns, MAX_FROZEN_COLUMNS),
	};
	return { freeze, clamped: command !== 'none' && columns > MAX_FROZEN_COLUMNS };
}

/** A change to one line of a table. */
export interface LineChange {
	from: number;
	to: number;
	insert: string;
}

/**
 * A header row with a new freeze, or null when the mark can't go there safely. A mark that filled the last
 * cell of a row with no closing pipe leaves nothing there, so the row gets that pipe, or the cell would go.
 * Then every cell has to keep its text, the mark aside, and the row has to read back as the freeze: a mark
 * taken out after a backslash would escape the pipe after it, and one written inside what reads as code
 * wouldn't count. Nor can the row be left with only dashes, which Obsidian doesn't read as a row.
 */
function headerWith(header: string, freeze: Freeze): string | null {
	const cells = rowCells(header).map(withoutMark);
	let written = withFreeze(header, freeze);
	if (rowCells(written).length < cells.length) written = `${written.trimEnd()} |`;
	const kept = rowCells(written).map(withoutMark);
	if (kept.length !== cells.length || kept.some((text, column) => text !== cells[column]) || onlyDashes(written)) return null;
	const { rows, columns } = readFreeze(written);
	const reads = freeze.rows || freeze.columns ? rows === freeze.rows && columns === freeze.columns : !hasMark(written);
	return reads ? written : null;
}

/**
 * The changes that give a table a new freeze, one for each line that changes, and where the table ends after
 * them, or null when its header row can't take the mark. The mark widens its column, and Enter opens a cell
 * only in a table padded as Obsidian pads it, so a table Obsidian wrote is padded again that way. Any other
 * table keeps its own spacing, and only its header row changes. No changes when the header already says this.
 */
export function freezeChanges(doc: Text, table: Span, freeze: Freeze): { changes: LineChange[]; to: number } | null {
	const first = doc.lineAt(table.from);
	const header = headerWith(first.text, freeze);
	if (header === null) return null;
	if (header === first.text) return { changes: [], to: table.to };
	const rewritten = rewrittenWith(doc, table, header);
	if (!rewritten && writtenByObsidian(doc, table)) return null;
	const lines = rewritten ?? [header];
	const changes: LineChange[] = [];
	let to = table.to;
	lines.forEach((text, index) => {
		const line = doc.line(first.number + index);
		if (line.text === text) return;
		changes.push({ from: line.from, to: line.to, insert: text });
		to += text.length - line.length;
	});
	return { changes, to };
}
