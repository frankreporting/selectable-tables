import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorState, Transaction } from '@codemirror/state';
import { Action, arrow, Cells, copied, Direction, enter, escape, Grid, noCells, selectedTable, stay, stopsEdit, tab } from '../src/editor/decide';
import { Drawing, layoutOf, note } from './notes';

const TABLE = '| Plant  | Room |\n| ------ | ---- |\n| Fern   | Hall |';

interface Options {
	shift?: boolean;
	drawing?: Drawing;
	/** Whether ↑/↓ would leave the caret's line; false for a caret on a wrapped line's inner rows. */
	leaves?: boolean;
}

function press(marked: string, direction: Direction, { shift = false, drawing, leaves = true }: Options = {}): Action | null {
	const state = note(marked);
	return arrow({ state, layout: layoutOf(state, drawing), leavesLine: () => leaves, cells: noCells }, direction, shift);
}

/** The context of a key on a selected table or cell. */
const on = (state: EditorState, cells: Cells = noCells, drawing?: Drawing) => ({ state, layout: layoutOf(state, drawing), cells });

/** The table's span, and other positions, in the note without its markers. */
function spanOf(marked: string, table = TABLE) {
	const text = marked.replace(/[‸⟨⟩]/g, '');
	const from = text.indexOf(table);
	return { from, to: from + table.length };
}

/** A note with ⟨⟩ around the table, selected from above or from below. */
const selected = (before: string, after: string, fromAbove = true) =>
	fromAbove ? `${before}⟨${TABLE}⟩${after}` : `${before}⟩${TABLE}⟨${after}`;

describe('next to a table', () => {
	test('↓ from the line above passes the table', () => {
		const text = `Intro\n‸\n${TABLE}\n\nAfter`;
		assert.deepEqual(press(text, 'down'), { type: 'pass', table: spanOf(text), forward: true });
	});

	test('↑ from the line below passes the table', () => {
		const text = `Intro\n\n${TABLE}\n‸After`;
		assert.deepEqual(press(text, 'up'), { type: 'pass', table: spanOf(text), forward: false });
	});

	test('↓ steps aside on a wrapped line until its last row', () => {
		assert.equal(press(`# A long heading‸ that wraps\n${TABLE}\nAfter`, 'down', { leaves: false }), null);
	});

	test('↑ steps aside on a wrapped line until its first row', () => {
		assert.equal(press(`\n${TABLE}\nA long paragraph that wr‸aps`, 'up', { leaves: false }), null);
	});

	test('↓ and ↑ away from a table step aside', () => {
		assert.equal(press(`‸Intro\n\n${TABLE}`, 'down'), null);
		assert.equal(press(`${TABLE}\n\nAft‸er`, 'up'), null);
		assert.equal(press(`${TABLE}\n‸After`, 'down'), null);
		assert.equal(press(`‸\n${TABLE}`, 'up'), null);
	});

	test('with no line beyond the table, ↓ and ↑ are left to Obsidian', () => {
		// Obsidian keeps a blank line around the tables it makes, so these come only from notes written
		// elsewhere: a table that ends the note, starts it, or sits right below the properties.
		assert.equal(press(`Intro\n‸\n${TABLE}`, 'down'), null);
		assert.equal(press(`${TABLE}\n‸After`, 'up'), null);
		assert.equal(press(`---\nstatus: draft\n---\n${TABLE}\n‸After`, 'up', { drawing: { properties: true } }), null);
	});

	test('↑ passes a table below frontmatter shown as text, landing on its closing line', () => {
		const text = `---\nstatus: draft\n---\n${TABLE}\n‸After`;
		assert.deepEqual(press(text, 'up'), { type: 'pass', table: spanOf(text), forward: false });
	});

	test('↓ puts the caret at the start of another block widget that follows the table', () => {
		const text = `‸\n${TABLE}\n> [!note] Callout`;
		const callout = { from: spanOf(text).to + 1, to: text.length - 1 };
		assert.deepEqual(press(text, 'down', { drawing: { widgets: [callout] } }), { type: 'caret', pos: spanOf(text).to + 1 });
	});

	test('↓ between two close tables stops on the blank line between them', () => {
		const text = `‸\n${TABLE}\n\n${TABLE}\n`;
		assert.deepEqual(press(text, 'down'), { type: 'pass', table: spanOf(text), forward: true });
	});

	test('→ at the end of the line above selects the table', () => {
		const text = `Intro‸\n${TABLE}\nAfter`;
		assert.deepEqual(press(`#${text}`, 'right'), { type: 'select', table: { from: spanOf(text).from + 1, to: spanOf(text).to + 1 }, fromAbove: true });
		assert.equal(press(`# Intr‸o\n${TABLE}`, 'right'), null);
	});

	test('← at the start of the line below selects the table', () => {
		const text = `\n${TABLE}\n‸After`;
		assert.deepEqual(press(text, 'left'), { type: 'select', table: spanOf(text), fromAbove: false });
		assert.equal(press(`\n${TABLE}\nA‸fter`, 'left'), null);
	});

	test('several carets step aside', () => {
		assert.equal(press(`‸Intro\n‸\n${TABLE}\n`, 'down'), null);
	});

	test('a selection that is not exactly a table steps aside', () => {
		assert.equal(press(`⟨Intro\n⟩\n${TABLE}\n`, 'down'), null);
		assert.equal(press(`⟨\n| Plant  | Ro⟩om |\n| ------ | ---- |\n| Fern   | Hall |\n`, 'down'), null);
	});

	test('a selection ending on a table edge collapses beyond the table, where a line lies beyond', () => {
		assert.equal(press(`⟨\n${TABLE}⟩`, 'down'), null);
		assert.equal(press(`⟩${TABLE}\n⟨After`, 'up'), null);
		const beforeCallout = `⟨\n${TABLE}⟩\n> [!note] Callout`;
		assert.deepEqual(press(beforeCallout, 'right'), { type: 'caret', pos: spanOf(beforeCallout).to + 1 });
		const upToStart = `⟨# Intro\n⟩${TABLE}\n`;
		assert.deepEqual(press(upToStart, 'down'), { type: 'caret', pos: spanOf(upToStart).to + 1 });
	});

	test('a note without a rendered table steps aside', () => {
		assert.equal(press('Intro\n‸\nPlain text', 'down'), null);
		assert.equal(press('> [!note]\n> ‸\n> | a | b |\n> | - | - |\n', 'down'), null);
	});
});

describe('a selected table', () => {
	test('is one range over exactly the table text', () => {
		const text = selected('\n', '\n');
		const state = note(text);
		assert.deepEqual(selectedTable(state, layoutOf(state)), spanOf(text));
		const wider = note(`⟨\n${TABLE}⟩\n`);
		assert.equal(selectedTable(wider, layoutOf(wider)), null);
	});

	test('↓ and → put the caret at the start of the line below', () => {
		const text = selected('# Intro\n', '\nAfter');
		const below = spanOf(text).to + 1;
		assert.deepEqual(press(text, 'down'), { type: 'caret', pos: below });
		assert.deepEqual(press(text, 'right'), { type: 'caret', pos: below });
	});

	test('↑ and ← put the caret at the end of the line above', () => {
		const text = selected('# Intro\n', '\nAfter', false);
		const above = spanOf(text).from - 1;
		assert.deepEqual(press(text, 'up'), { type: 'caret', pos: above });
		assert.deepEqual(press(text, 'left'), { type: 'caret', pos: above });
	});

	test('with no line beyond, the arrow is left to Obsidian', () => {
		assert.equal(press(selected('# Intro\n', ''), 'down'), null);
		assert.equal(press(selected('', '\nAfter', false), 'up'), null);
		const underProperties = selected('---\nstatus: draft\n---\n', '\nAfter', false);
		assert.equal(press(underProperties, 'up', { drawing: { properties: true } }), null);
	});

	test('Enter selects the first cell', () => {
		assert.deepEqual(enter(on(note(selected('\n', '\n')))), { type: 'cell', cell: { row: 0, column: 0 } });
	});

	test('Enter goes back to the cell Escape left', () => {
		const cells = { ...noCells, left: { row: 1, column: 1 } };
		assert.deepEqual(enter(on(note(selected('\n', '\n')), cells)), { type: 'cell', cell: { row: 1, column: 1 } });
	});

	test('Escape goes back to the side the table was selected from', () => {
		const fromAbove = selected('# Intro\n', '\nAfter');
		const fromBelow = selected('# Intro\n', '\nAfter', false);
		const run = (text: string) => {
			const state = note(text);
			return escape(on(state));
		};
		assert.deepEqual(run(fromAbove), { type: 'caret', pos: spanOf(fromAbove).from - 1 });
		assert.deepEqual(run(fromBelow), { type: 'caret', pos: spanOf(fromBelow).to + 1 });
	});

	test('Escape goes to the other side when the first one is missing', () => {
		const run = (text: string, drawing?: Drawing) => {
			const state = note(text);
			return escape(on(state, noCells, drawing));
		};
		const tableFirst = selected('', '\nAfter');
		assert.deepEqual(run(tableFirst), { type: 'caret', pos: spanOf(tableFirst).to + 1 });
		const tableLast = selected('# Intro\n', '', false);
		assert.deepEqual(run(tableLast), { type: 'caret', pos: spanOf(tableLast).from - 1 });
		const underProperties = selected('---\nstatus: draft\n---\n', '\nAfter');
		assert.deepEqual(run(underProperties, { properties: true }), { type: 'caret', pos: spanOf(underProperties).to + 1 });
		assert.equal(run(selected('', '')), null);
	});

	test('Escape on a selection whose head is on a table edge selects the table', () => {
		const run = (text: string) => {
			const state = note(text);
			return escape(on(state));
		};
		const shifted = `⟨\n${TABLE}⟩`;
		assert.deepEqual(run(shifted), { type: 'select', table: spanOf(shifted), fromAbove: true });
		assert.equal(run(`⟨\n| Plant⟩  | Room |\n| ------ | ---- |\n| Fern   | Hall |`), null);
		assert.equal(run(`⟨# Intro⟩\n${TABLE}`), null);
	});

	test('Tab is taken, and does nothing', () => {
		assert.deepEqual(tab(on(note(selected('\n', '\n'))), true), { type: 'stay' });
		assert.deepEqual(tab(on(note(selected('\n', '\n'))), false), { type: 'stay' });
		const caret = note(`‸\n${TABLE}\n`);
		assert.equal(tab(on(caret), true), null);
		assert.equal(enter(on(caret)), null);
		assert.equal(escape(on(caret)), null);
	});

	test('Shift+Enter is taken, and does nothing', () => {
		const state = note(selected('\n', '\n'));
		assert.deepEqual(stay(state, layoutOf(state)), { type: 'stay' });
		const caret = note(`‸\n${TABLE}\n`);
		assert.equal(stay(caret, layoutOf(caret)), null);
	});
});

describe('a selected cell', () => {
	const BIG = '| a   | b   | c   |\n| --- | --- | --- |\n| d   | e   | f   |\n| g   | h   | i   |';
	const grid: Grid = { rows: 3, columns: () => 3 };
	const state = () => note(`\n⟨${BIG}⟩\n`);
	const cellAt = (row: number, column: number): Cells => ({ selected: { row, column }, left: null, grid });
	const go = (row: number, column: number, direction: Direction, shift = false) =>
		arrow({ ...on(state(), cellAt(row, column)), leavesLine: () => true }, direction, shift);
	const to = (row: number, column: number): Action => ({ type: 'cell', cell: { row, column } });

	test('the arrows move it one cell', () => {
		assert.deepEqual(go(1, 1, 'up'), to(0, 1));
		assert.deepEqual(go(1, 1, 'down'), to(2, 1));
		assert.deepEqual(go(1, 1, 'left'), to(1, 0));
		assert.deepEqual(go(1, 1, 'right'), to(1, 2));
	});

	test('the arrows stop at the outer edge', () => {
		assert.deepEqual(go(0, 1, 'up'), to(0, 1));
		assert.deepEqual(go(2, 1, 'down'), to(2, 1));
		assert.deepEqual(go(1, 0, 'left'), to(1, 0));
		assert.deepEqual(go(1, 2, 'right'), to(1, 2));
	});

	test('moving onto a shorter row lands on its last cell', () => {
		const uneven: Grid = { rows: 3, columns: (row) => (row === 1 ? 2 : 4) };
		const cells = { selected: { row: 0, column: 3 }, left: null, grid: uneven };
		assert.deepEqual(arrow({ ...on(state(), cells), leavesLine: () => true }, 'down', false), to(1, 1));
	});

	test('a table with no drawn rows keeps the cell where it is', () => {
		const cells = { selected: { row: 1, column: 1 }, left: null, grid: noCells.grid };
		assert.deepEqual(arrow({ ...on(state(), cells), leavesLine: () => true }, 'down', false), to(1, 1));
		assert.deepEqual(tab(on(state(), cells), true), to(1, 1));
	});

	test('Shift with an arrow is taken, and does nothing', () => {
		for (const direction of ['up', 'down', 'left', 'right'] as const) assert.deepEqual(go(1, 1, direction, true), { type: 'stay' });
	});

	test('Tab goes to the next cell, wrapping to the next row', () => {
		assert.deepEqual(tab(on(state(), cellAt(1, 1)), true), to(1, 2));
		assert.deepEqual(tab(on(state(), cellAt(1, 2)), true), to(2, 0));
	});

	test('Tab on the last cell stays there', () => {
		assert.deepEqual(tab(on(state(), cellAt(2, 2)), true), to(2, 2));
	});

	test('Shift+Tab goes to the previous cell, wrapping to the previous row', () => {
		assert.deepEqual(tab(on(state(), cellAt(1, 1)), false), to(1, 0));
		assert.deepEqual(tab(on(state(), cellAt(1, 0)), false), to(0, 2));
	});

	test('Shift+Tab on the first cell stays there', () => {
		assert.deepEqual(tab(on(state(), cellAt(0, 0)), false), to(0, 0));
	});

	test('Enter opens the cell with the caret at the end of its text', () => {
		const start = note(`\n⟨${BIG}⟩\n`).doc.toString().indexOf('| d');
		assert.deepEqual(enter(on(state(), cellAt(1, 1))), { type: 'open', pos: start + '| d   | e'.length });
	});

	test('Enter repairs a table Obsidian would repair for a click, from its delimiter line', () => {
		const shortRow = '| a   | b   |\n| --- | --- |\n| c   |';
		const text = `\n⟨${shortRow}⟩\n`;
		const start = text.replace(/[⟨⟩]/g, '').indexOf('| a');
		assert.deepEqual(enter(on(note(text), cellAt(1, 0))), { type: 'repair', delimiter: start + '| a   | b   |\n'.length, table: start, cell: { row: 1, column: 0 } });
	});

	test('Escape goes back to the selected table', () => {
		assert.deepEqual(escape(on(state(), cellAt(1, 1))), { type: 'table' });
	});

	test('Copy gives the cell\'s Markdown', () => {
		assert.equal(copied(on(state(), cellAt(1, 1))), 'e');
	});

	test('Copy steps aside with no cell selected', () => {
		assert.equal(copied(on(state())), null);
	});
});

describe('the edit guard', () => {
	const text = `# Intro\n⟨${TABLE}⟩\nAfter`;
	const table = spanOf(text);
	const edit = (userEvent?: string) => note(text).update({ changes: { from: table.from, to: table.to }, ...(userEvent ? { userEvent } : {}) });
	const outside = (userEvent: string) => note(text).update({ changes: { from: 0, insert: 'x' }, userEvent });

	test('on a selected table, typing and indenting are stopped', () => {
		assert.ok(stopsEdit(edit('input.type'), table, false));
		assert.ok(stopsEdit(edit('indent.more'), table, false));
	});

	test('on a selected table, deleting, cutting, pasting and dropping pass', () => {
		for (const event of ['delete.backward', 'delete.cut', 'input.paste', 'input.drop']) assert.ok(!stopsEdit(edit(event), table, false), event);
	});

	test('on a selected cell, every user edit that touches the table is stopped', () => {
		for (const event of ['input.type', 'indent.more', 'delete.backward', 'delete.forward', 'delete.cut', 'input.paste', 'input.drop', 'move.line']) {
			assert.ok(stopsEdit(edit(event), table, true), event);
		}
	});

	test('on a selected cell, an edit with no user event is stopped, as Obsidian\'s commands send', () => {
		assert.ok(stopsEdit(edit(), table, true));
	});

	test('on a selected table, an edit with no user event passes', () => {
		assert.ok(!stopsEdit(edit(), table, false));
	});

	test('on a selected cell, undo and redo pass', () => {
		assert.ok(!stopsEdit(edit('undo'), table, true));
		assert.ok(!stopsEdit(edit('redo'), table, true));
	});

	test('on a selected cell, a reload from disk passes: that is how Sync arrives', () => {
		assert.ok(!stopsEdit(edit('set'), table, true));
	});

	test('on a selected cell, a search and replace passes', () => {
		assert.ok(!stopsEdit(edit('searchReplace'), table, true));
	});

	test('on a selected cell, a remote edit passes: that is how a second pane arrives', () => {
		const remote = note(text).update({ changes: { from: table.from, to: table.to }, annotations: Transaction.remote.of(true) });
		assert.ok(!stopsEdit(remote, table, true));
	});

	test('composed input passes: dropping it leaves the composition stuck', () => {
		assert.ok(!stopsEdit(edit('input.type.compose'), table, true));
		assert.ok(!stopsEdit(edit('input.type.compose'), table, false));
	});

	test('edits elsewhere in the note pass', () => {
		assert.ok(!stopsEdit(outside('input.type'), table, true));
		assert.ok(!stopsEdit(outside('delete.backward'), table, true));
		assert.ok(!stopsEdit(outside('input.type'), table, false));
	});
});

describe('Shift with an arrow', () => {
	test('Shift+↓ from the line above takes the whole table, onto the line below', () => {
		const text = `‸\n${TABLE}\n\nAfter`;
		assert.deepEqual(press(text, 'down', { shift: true }), { type: 'extendPast', table: spanOf(text), forward: true });
	});

	test('Shift+↑ back over the table shrinks the selection past it', () => {
		const text = `⟨\n${TABLE}\n⟩\nAfter`;
		assert.deepEqual(press(text, 'up', { shift: true }), { type: 'extendPast', table: spanOf(text), forward: false });
	});

	test('Shift+↓ ends on the table edge when no line follows it', () => {
		const text = `‸\n${TABLE}`;
		assert.deepEqual(press(text, 'down', { shift: true }), { type: 'extendTo', pos: spanOf(text).to });
	});

	test('Shift+→ and Shift+← take the whole table at once', () => {
		const down = `# Intro‸\n${TABLE}\nAfter`;
		assert.deepEqual(press(down, 'right', { shift: true }), { type: 'extendTo', pos: spanOf(down).to + 1 });
		const up = `# Intro\n${TABLE}\n‸After`;
		assert.deepEqual(press(up, 'left', { shift: true }), { type: 'extendTo', pos: spanOf(up).from - 1 });
	});

	test('a head inside a table leaves it whole', () => {
		const text = `⟨# Intro\n| Plant  | Ro⟩om |\n| ------ | ---- |\n| Fern   | Hall |\nAfter`;
		assert.deepEqual(press(text, 'down', { shift: true }), { type: 'extendPast', table: spanOf(text), forward: true });
	});

	test('Shift never shrinks a selection to a caret on the table edge', () => {
		// A table that ends the note, selected backwards (as Escape in a cell leaves it): Shift+↓ would
		// shrink the selection to nothing at the table's end.
		const last = selected('# Intro\n', '', false);
		assert.deepEqual(press(last, 'down', { shift: true }), { type: 'select', table: spanOf(last), fromAbove: true });
		assert.deepEqual(press(last, 'right', { shift: true }), { type: 'select', table: spanOf(last), fromAbove: true });
		const first = selected('', '\n> [!note] Callout');
		const callout = { from: spanOf(first).to + 1, to: first.replace(/[⟨⟩]/g, '').length };
		assert.deepEqual(press(first, 'up', { shift: true, drawing: { widgets: [callout] } }), { type: 'select', table: spanOf(first), fromAbove: false });
	});

	test('a head on the far edge of a selected table steps aside', () => {
		assert.equal(press(selected('# Intro\n', '\nAfter'), 'right', { shift: true }), null);
		assert.equal(press(selected('# Intro\n', '\nAfter', false), 'left', { shift: true }), null);
	});

	test('Shift keeps the head out of frontmatter hidden behind the properties', () => {
		const text = selected('---\nstatus: draft\n---\n', '\nAfter', false);
		assert.deepEqual(press(text, 'left', { shift: true, drawing: { properties: true } }), { type: 'stay' });
		assert.deepEqual(press(text, 'up', { shift: true, drawing: { properties: true } }), { type: 'stay' });
		assert.equal(press(text, 'left', { shift: true }), null);
	});

	test('Shift+↓ on a wrapped line steps aside until its last row', () => {
		assert.equal(press(`# Lo‸ng\n${TABLE}\n`, 'down', { shift: true, leaves: false }), null);
	});
});
