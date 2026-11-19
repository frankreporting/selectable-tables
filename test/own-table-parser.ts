import type { Text } from '@codemirror/state';
import { looksLikeTable } from '../src/editor/table-text';
import { type Rows, rowRule } from '../src/own-table/find';

/** Whether a line starts a table, by the parser's rule: a header and a delimiter after a blank line or a heading. */
function opens(doc: Text, n: number): boolean {
	if (n >= doc.lines) return false;
	const line = doc.line(n);
	if (!/^\|(?:[^|]+\|)+?\s*$/.test(line.text) && !/^\s*[^|].*?\|.*[^|]\s*$/.test(line.text)) return false;
	if (!looksLikeTable(doc, { from: line.from, to: doc.line(n + 1).to })) return false;
	if (n === 1) return true;
	const above = doc.line(n - 1).text;
	return above.trim() === '' || /^#{1,6}(\s|$)/.test(above);
}

/**
 * A stand-in for Obsidian's parser with the plugin's language copy: it marks every line of a table as a row, and
 * nothing else. It reads the text up to `read`, as the real one reads up to near the screen.
 */
export function parsed(doc: Text, read = doc.length): Rows {
	const rows: number[] = [];
	for (let n = 1; n <= doc.lines; n++) {
		const line = doc.line(n);
		if (line.from >= read) break;
		if (!opens(doc, n)) continue;
		const rule = rowRule(line.text);
		let last = n + 1;
		while (last < doc.lines && rule.test(doc.line(last + 1).text)) last++;
		for (let k = n; k <= last && doc.line(k).from < read; k++) rows.push(doc.line(k).from);
		n = last;
	}
	return {
		length: read,
		next(from, to) {
			return rows.find((start) => start >= from && start < to) ?? -1;
		},
		gap(from, to) {
			const ends = rows.map((start) => [start, doc.lineAt(start).to]);
			if (ends.some(([start, end]) => start! < to && end! > from)) return 0;
			const before = Math.max(0, ...ends.filter(([, end]) => end! <= from).map(([, end]) => end!));
			const after = Math.min(read, ...ends.filter(([start]) => start! >= to).map(([start]) => start!));
			return after - before;
		},
	};
}
