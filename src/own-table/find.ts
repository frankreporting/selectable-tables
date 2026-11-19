import type { ChangeSet, Text } from '@codemirror/state';
import { frontmatterEnd, looksLikeTable, type Span } from '../editor/table-text';
import type { LineChange } from './shape';

/**
 * What the parser has read, as finding tables needs it. Obsidian's parser decides where a table starts: after a
 * blank line, a heading or the frontmatter, and not in a callout or a code block. The text decides where it ends.
 */
export interface Rows {
	/** How far the parser has read. Past this, nothing is marked yet. */
	readonly length: number;
	/** The start of the first line starting in [from, to) that the parser marks as a table row, or -1. */
	next(from: number, to: number): number;
	/**
	 * How long a stretch around [from, to] the parser has nothing on: no line class and no token, as in a stretch it
	 * skipped. 0 when it has something on [from, to] itself.
	 */
	gap(from: number, to: number): number;
}

/** A table found in the note, and which table it was before the change, by its place in that list, or -1. */
export interface Found extends Span {
	was: number;
}

/**
 * The rule every line after a table's delimiter passes to belong to the table, as Obsidian's parser has it: a
 * table whose header starts with a pipe goes on while lines start with one, and any other while a line has a pipe
 * after a first character that isn't one. A blank line fails both.
 */
export function rowRule(header: string): RegExp {
	return header.startsWith('|') ? /^\|/ : /^\s*[^|].*\|/;
}

/** Where a table ends, read from its text: the end of its last line. */
export function textEnd(doc: Text, from: number): number {
	const header = doc.lineAt(from);
	const rule = rowRule(header.text);
	let last = Math.min(doc.lines, header.number + 1);
	if (last < doc.lines) {
		const lines = doc.iterLines(last + 1);
		for (let line = lines.next(); !line.done && rule.test(line.value); line = lines.next()) last++;
	}
	return doc.line(last).to;
}

/**
 * Where a table ends after a change, reading only the lines that could have changed it: the changed lines, then
 * the lines past them that were never read. `changed` are the first and last changed lines, by number, and `before`
 * is where the table ended before the change, mapped into the new text. A change to the header or the delimiter
 * reads the whole table again.
 */
export function endAfter(doc: Text, from: number, changed: { first: number; last: number }, before: number): number {
	const header = doc.lineAt(from);
	if (changed.first <= header.number + 1 || header.number >= doc.lines) return textEnd(doc, from);
	const rule = rowRule(header.text);
	const end = doc.lineAt(Math.min(before, doc.length)).number;
	// The line after the old end wasn't changed, and still ends the table.
	if (end + 1 < changed.first) return doc.line(end).to;
	const last = Math.min(changed.last, doc.lines);
	for (let n = changed.first; n <= last; n++) if (!rule.test(doc.line(n).text)) return doc.line(n - 1).to;
	// The old end is past the change: the rows between are as they were, and so is the line that ended the table.
	if (end > last) return doc.line(end).to;
	let n = last;
	while (n < doc.lines && rule.test(doc.line(n + 1).text)) n++;
	return doc.line(n).to;
}

/**
 * The lines changes touched inside a span of the old text, by number in the old text and in the new, or null when
 * none touched it.
 */
export function lineChange(changes: ChangeSet, oldDoc: Text, doc: Text, from: number, to: number): LineChange | null {
	let fromA = -1;
	let toA = -1;
	let fromB = -1;
	let toB = -1;
	changes.iterChangedRanges((changeFromA, changeToA, changeFromB, changeToB) => {
		if (changeToA < from || changeFromA > to) return;
		if (fromA < 0 || changeFromA < fromA) fromA = changeFromA;
		if (fromB < 0 || changeFromB < fromB) fromB = changeFromB;
		toA = Math.max(toA, changeToA);
		toB = Math.max(toB, changeToB);
	});
	if (fromA < 0) return null;
	return { oldFirst: oldDoc.lineAt(fromA).number, oldLast: oldDoc.lineAt(toA).number, first: doc.lineAt(fromB).number, last: doc.lineAt(toB).number };
}

/** The end of the line after the one holding `pos`: a change there can move a table's end. */
export function endOfNextLine(doc: Text, pos: number): number {
	return doc.lineAt(Math.min(doc.length, doc.lineAt(pos).to + 1)).to;
}

/** A header row, as the parser takes one: with a pipe at its start, or with pipes inside and none at its end. */
const PIPED = /^\|(?:[^|]+\|)+?\s*$/;
const BARE = /^\s*[^|].*?\|.*[^|]\s*$/;
/** A delimiter cell: dashes, with a colon on either side for its alignment. */
const DELIMITER_CELL = /^\s*(?::\s*)?-+(?:\s*:)?\s*$/;

/** Whether a header and the line below it start a table, by the parser's rules for each. */
function headerAndDelimiter(header: string, delimiter: string): boolean {
	const piped = PIPED.test(header);
	if (!piped && !BARE.test(header)) return false;
	if (!(piped ? PIPED : BARE).test(delimiter)) return false;
	const cells = piped ? delimiter.replace(/^\s*\|/, '').replace(/\|\s*$/, '') : delimiter;
	return cells.split('|').every((cell) => DELIMITER_CELL.test(cell));
}

/**
 * Whether the text at `from` opens a table by the parser's rules for a start: a header and a delimiter below it,
 * after the note's start, a blank line, a heading or the frontmatter.
 */
export function opensTable(doc: Text, from: number): boolean {
	const header = doc.lineAt(from);
	if (header.from !== from || header.number >= doc.lines) return false;
	if (!headerAndDelimiter(header.text, doc.line(header.number + 1).text)) return false;
	if (header.number === 1) return true;
	const above = doc.line(header.number - 1);
	return above.text.trim() === '' || /^#{1,6}(\s|$)/.test(above.text) || above.to === frontmatterEnd(doc);
}

/**
 * How far CodeMirror's parser jumps: when it's this far behind the screen it starts again near the screen, and
 * leaves the stretch between with nothing on it. Less a chunk and a line, since it restarts at a chunk's start.
 */
const SKIP = 100000 - 2048;

/** A table from before the change, placed in the new text. */
interface Known extends Span {
	was: number;
	/** Where its start maps to after text inserted right at it: below that text, where a new line puts the header. */
	after: number;
	/** The lines a change touched, from its header to the line after its end, or null. */
	changed: LineChange | null;
}

/** The line after the one holding `pos`, or the text's end. */
function nextLineStart(doc: Text, pos: number): number {
	return Math.min(doc.length, doc.lineAt(pos).to + 1);
}

/**
 * The note's tables after a change, from the tables before it, rereading only what changed: from the first changed
 * line to where the parser has read, skipping over tables it still marks, and the ends of tables a change touched.
 * Tables past what the parser has read stay where they were. So do tables it skipped, whose text still opens a
 * table: CodeMirror's parser starts afresh near the screen when it's 100,000 characters behind, and leaves the
 * stretch between with nothing on it.
 *
 * `changes` is null when only the parser moved on: it had read up to `readBefore`, and now reads further.
 */
export function updateTables(before: readonly Span[], changes: ChangeSet | null, readBefore: number, oldDoc: Text, doc: Text, rows: Rows): Found[] {
	const known: Known[] = before.map((table, was) => {
		if (!changes) return { ...table, was, after: table.from, changed: null };
		// The span a change could alter the end of: the table and the line after it.
		const changed = lineChange(changes, oldDoc, doc, table.from, endOfNextLine(oldDoc, table.to));
		return { from: changes.mapPos(table.from, -1), to: changes.mapPos(table.to, -1), was, after: changes.mapPos(table.from, 1), changed };
	});
	let lo: number;
	if (changes) {
		let first = doc.length;
		changes.iterChangedRanges((fromA, toA, fromB) => {
			first = Math.min(first, fromB);
		});
		lo = Math.min(first, changes.mapPos(Math.min(readBefore, oldDoc.length), -1));
	} else {
		lo = rows.length < readBefore ? 0 : Math.min(readBefore, doc.length);
	}
	// A changed line can make the line above it a header: its delimiter is below it.
	const first = doc.lineAt(Math.min(lo, doc.length));
	lo = first.number > 1 ? doc.line(first.number - 1).from : first.from;
	// A change in a table, or on the line after it, can move its end: the table is read again from its header.
	for (const table of known) if (table.from < lo && lo <= doc.lineAt(nextLineStart(doc, table.to)).to) lo = table.from;
	const hi = rows.length;
	const out: Found[] = [];
	const endOf = (table: Known) => (table.changed ? endAfter(doc, table.from, table.changed, table.to) : table.to);
	let k = 0;
	for (; k < known.length && known[k]!.from < lo; k++) {
		const table = known[k]!;
		out.push({ from: table.from, to: endOf(table), was: table.was });
	}
	let pos = lo;
	while (pos < hi) {
		while (k < known.length && known[k]!.from < pos) k++;
		const next = known[k];
		const limit = next && next.from < hi ? next.from : hi;
		const head = rows.next(pos, limit);
		if (head >= 0) {
			const delimiter = nextLineStart(doc, head);
			if (head === delimiter || !looksLikeTable(doc, { from: head, to: doc.lineAt(delimiter).to })) {
				pos = delimiter > head ? delimiter : hi;
				continue;
			}
			const end = textEnd(doc, head);
			out.push({ from: head, to: end, was: -1 });
			pos = end + 1;
			continue;
		}
		if (!next || next.from >= hi) break;
		k++;
		// Text inserted right at a table's start, ending in a line break, puts its header below the text.
		const below = doc.lineAt(Math.min(next.after, doc.length)).from;
		const from = rows.next(next.from, next.from + 1) !== next.from && below > next.from && rows.next(below, below + 1) === below ? below : next.from;
		// A table the parser skipped: a long stretch around it has nothing on it, and its text still opens a table.
		const kept = rows.next(from, from + 1) === from || (rows.gap(from, next.to) >= SKIP && opensTable(doc, from));
		if (kept) {
			const end = endOf({ ...next, from });
			out.push({ from, to: end, was: next.was });
			pos = end + 1;
		} else pos = from;
	}
	// Past what the parser has read, tables stay where they were while their text still holds a table, but for one
	// a table found above now reaches.
	let reached = out.length ? out[out.length - 1]!.to : -1;
	for (; k < known.length; k++) {
		const table = known[k]!;
		if (table.from <= reached || table.from < hi || !holdsTable(doc, table.from)) continue;
		const end = endOf(table);
		out.push({ from: table.from, to: end, was: table.was });
		reached = end;
	}
	return out;
}

/** Whether a header and a delimiter still start at `from`, as for a table the parser hasn't read since a change. */
function holdsTable(doc: Text, from: number): boolean {
	if (from > doc.length) return false;
	const header = doc.lineAt(from);
	return header.from === from && header.number < doc.lines && looksLikeTable(doc, { from, to: doc.line(header.number + 1).to });
}

/** Every table in the note. */
export function findTables(doc: Text, rows: Rows): Found[] {
	return updateTables([], null, 0, doc, doc, rows);
}
