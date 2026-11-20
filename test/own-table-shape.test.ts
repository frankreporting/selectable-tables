import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitColumns, linesAt, measureCell, type Metrics, rowHeight } from '../src/own-table/estimate';
import { covers, Heights, wanted } from '../src/own-table/heights';
import { hidingRows, ROW_CLASS } from '../src/own-table/hide-rows';
import { alignOf, cellsOf, columnAt, markdownOf, rowSplices } from '../src/own-table/shape';

/** Invented sizes: every character 10 px wide, a space 5, and simple padding. */
const metrics: Metrics = {
	fonts: { body: 'body', head: 'head', code: 'code', tag: 'tag', bold: 'bold' },
	extra: { code: 4, tag: 6, link: 12, mark: 2 },
	side: { first: 20, middle: 20, last: 20, only: 20 },
	padY: 8,
	border: 1,
	tableBorder: 0,
	outer: 1,
	firstExtra: 1,
	lineHeight: 24,
	headLineHeight: 24,
	minColumn: 30,
	available: 600,
	pad: 32,
	padTop: 16,
	collapsed: true,
	spacing: 0,
	keepSpaces: false,
	stretch: false,
	webkit: false,
};
const measure = (font: string, text: string) => (text === ' ' ? 5 : text.length * 10);

test("a cell's words measure without their Markdown, and styled spans take their extra room", () => {
	const plain = measureCell('two words', metrics, false, measure);
	assert.equal(plain.min, 50);
	assert.equal(plain.max, 30 + 5 + 50);
	assert.equal(measureCell('`code`', metrics, false, measure).max, 40 + 4);
	assert.equal(measureCell('**bold** text', metrics, false, measure).max, 40 + 5 + 40);
	assert.equal(measureCell('[[Note|alias]]', metrics, false, measure).max, 50);
	assert.equal(measureCell('[[Note\\|alias]]', metrics, false, measure).max, 50);
	assert.equal(measureCell('#tag', metrics, false, measure).max, 40 + 6);
});

test('a word runs on across styled text until a space', () => {
	const joined = measureCell('**ab**, cd', metrics, false, measure);
	assert.equal(joined.min, 30);
	assert.equal(joined.max, 30 + 5 + 20);
});

test('where the theme keeps every space, a word not last on its line takes its space with it', () => {
	const keeping = { ...metrics, keepSpaces: true };
	assert.equal(measureCell('aa bb', keeping, false, measure).min, 25);
	assert.equal(measureCell('aa bb', metrics, false, measure).min, 20);
	assert.equal(linesAt(measureCell('aa bb cc dd', metrics, false, measure), 47), 2);
	assert.equal(linesAt(measureCell('aa bb cc dd', keeping, false, measure), 47), 3);
	// A header cell holding a freeze mark drops its spaces, whatever the theme keeps.
	assert.equal(measureCell('%%freeze 1 1%% aa bb', keeping, true, measure).min, 20);
});

test('a freeze mark, a comment, draws nothing and takes no room', () => {
	assert.equal(measureCell('%%freeze 2 1%% Name', metrics, true, measure).max, 40);
});

test('a line break starts a new line, and an embed takes room until it loads', () => {
	const broken = measureCell('first<br>second line', metrics, false, measure);
	assert.equal(broken.max, 60 + 5 + 40);
	assert.equal(linesAt(broken, 1000), 2);
	const embed = measureCell('![[picture.png]]', metrics, false, measure);
	assert.equal(embed.embed, true);
	assert.equal(linesAt(embed, 1000), 3);
});

test('text wraps at spaces to the width it has', () => {
	const words = measureCell('aaaa bbbb cccc', metrics, false, measure);
	assert.equal(linesAt(words, 140), 1);
	assert.equal(linesAt(words, 100), 2);
	assert.equal(linesAt(words, 40), 3);
	assert.equal(linesAt(measureCell('', metrics, false, measure), 40), 1);
});

test('columns take their longest line when it fits, and their widest word when nothing fits', () => {
	assert.deepEqual(fitColumns([40, 50], [100, 120], metrics), [120, 140]);
	assert.deepEqual(fitColumns([300, 400], [900, 900], metrics), [320, 420]);
	const shared = fitColumns([40, 40], [400, 800], metrics);
	assert.ok(shared[0]! >= 60 && shared[1]! > shared[0]! && shared[0]! + shared[1]! <= 601);
	assert.deepEqual(fitColumns([0], [0], metrics), [30]);
});

test('WebKit shares the room by how wide each column wants to be, in order, and takes back any excess from the end', () => {
	const webkit = { ...metrics, webkit: true };
	// Room 599: the first column gets 599 * 400 / 1000, and the second what's left.
	const [a, b] = fitColumns([40, 40], [380, 580], webkit);
	assert.ok(Math.abs(a! - 239.6) < 0.05 && Math.abs(b! - 359.4) < 0.05, `${a} ${b}`);
	// The second column can't be narrower than 220, so the first gives back what that takes beyond the room.
	const [c, d] = fitColumns([30, 200], [300, 210], { ...webkit, available: 300 });
	assert.ok(Math.abs(c! - 79) < 0.05 && d === 220, `${c} ${d}`);
});

test("a row is as tall as its tallest cell's lines", () => {
	const cells = [measureCell('a', metrics, false, measure), measureCell('aaaa bbbb cccc', metrics, false, measure)];
	assert.equal(rowHeight(cells, [100, 120], metrics, false), 2 * 24 + 8 + 1);
});

test("heights give each row's top, the row at a height, and take splices", () => {
	const heights = new Heights([10, 20, 30, 40]);
	assert.equal(heights.top(2), 30);
	assert.equal(heights.total(), 100);
	assert.equal(heights.rowAt(0), 0);
	assert.equal(heights.rowAt(29.9), 1);
	assert.equal(heights.rowAt(30), 2);
	assert.equal(heights.rowAt(5000), 3);
	assert.equal(heights.set(1, 25, true), true);
	assert.equal(heights.measured(1), true);
	assert.equal(heights.top(2), 35);
	heights.splice(1, 2, [5, 5, 5]);
	assert.equal(heights.count, 5);
	assert.equal(heights.total(), 10 + 15 + 40);
	assert.equal(heights.measured(1), false);
});

test('the rows wanted reach past the pane both ways, and are drawn again only when they fall short', () => {
	const heights = new Heights(Array.from({ length: 100 }, () => 10));
	const rows = wanted(heights, { top: 500, bottom: 600 }, 100);
	assert.deepEqual(rows, { first: 40, end: 71 });
	assert.equal(covers(heights, rows, { top: 500, bottom: 600 }, 90), true);
	assert.equal(covers(heights, rows, { top: 650, bottom: 750 }, 90), false);
	assert.deepEqual(wanted(new Heights(), { top: 0, bottom: 100 }, 100), { first: 0, end: 0 });
});

test('cells and alignments come from the row and delimiter text', () => {
	assert.deepEqual(cellsOf('| a | b \\| c |', 3), ['a', 'b \\| c', '']);
	assert.deepEqual(cellsOf('a | b | c', 2), ['a', 'b']);
	assert.deepEqual(['---', ':--', '--:', ':-:'].map(alignOf), [null, 'left', 'right', 'center']);
});

test("the Markdown rendered for a table under a list item starts at the line's start, with every row as wide", () => {
	assert.equal(markdownOf('\t| Col | Val |', ['\t| x |'], 2, [null, 'right']), '| Col | Val |\n| - | -: |\n| x |  |');
});

test('a place in a row is in the cell between its pipes', () => {
	const row = '| ab | cd \\| e | f |';
	assert.equal(columnAt(row, 0), 0);
	assert.equal(columnAt(row, 3), 0);
	assert.equal(columnAt(row, 6), 1);
	assert.equal(columnAt(row, 12), 1);
	assert.equal(columnAt(row, 17), 2);
	assert.equal(columnAt('a | b', 4), 1);
});

test('a change in one row replaces that row, and rows before and after keep what was known', () => {
	// Header on line 3, rows on lines 5 to 14; row 4 (line 9) changed.
	assert.deepEqual(rowSplices({ header: 3, count: 10 }, { header: 3, count: 10 }, { oldFirst: 9, oldLast: 9, first: 9, last: 9 }), [{ at: 4, removed: 1, added: 1 }]);
	// A row added after row 4.
	assert.deepEqual(rowSplices({ header: 3, count: 10 }, { header: 3, count: 11 }, { oldFirst: 9, oldLast: 9, first: 9, last: 10 }), [{ at: 4, removed: 1, added: 2 }]);
	// A row typed on the line after the table.
	assert.deepEqual(rowSplices({ header: 3, count: 10 }, { header: 3, count: 11 }, { oldFirst: 15, oldLast: 15, first: 15, last: 15 }), [{ at: 10, removed: 0, added: 1 }]);
	// The lines above moved the table down, and a row changed.
	assert.deepEqual(rowSplices({ header: 3, count: 10 }, { header: 5, count: 10 }, { oldFirst: 9, oldLast: 9, first: 11, last: 11 }), [{ at: 4, removed: 1, added: 1 }]);
	// The table joined the one below it: the changed line, then the rows past it, are new.
	assert.deepEqual(rowSplices({ header: 3, count: 10 }, { header: 3, count: 14 }, { oldFirst: 15, oldLast: 15, first: 15, last: 15 }), [
		{ at: 10, removed: 0, added: 1 },
		{ at: 11, removed: 0, added: 3 },
	]);
	// The header changed: every row is read again.
	assert.equal(rowSplices({ header: 3, count: 10 }, { header: 3, count: 10 }, { oldFirst: 3, oldLast: 3, first: 3, last: 3 }), null);
});

test("the language copy's rows carry only the plugin's class, and lines outside tables keep their styles", () => {
	type State = { hmdTable: number };
	const styles: Record<string, string> = { header: 'line-HyperMD-table-1 line-HyperMD-table-row line-HyperMD-table-row-0 line-parse-next strong', cell: 'hmd-table-sep', text: 'em' };
	const mode = {
		startState: () => ({ hmdTable: 0 }),
		token(stream: unknown, state: State) {
			const kind = stream as string;
			if (kind === 'header') state.hmdTable = 2;
			if (kind === 'text') state.hmdTable = 0;
			return styles[kind] ?? null;
		},
	};
	const copy = hidingRows<State, typeof mode>(mode);
	const state = copy.startState();
	assert.equal(copy.token('header', state), `line-${ROW_CLASS}`);
	assert.equal(copy.token('cell', state), null);
	assert.equal(copy.token('text', state), 'em');
	assert.equal(state.hmdTable, 0);
});
