import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { Action, arrow, Cells, copied, deleteForward, Direction, enter, escape, Grid, landing, noCells, noteEnd, opensCell, option, page, rowEnd, selectedTable, shifted, shiftedRowEnd, stay, stopsEdit, tab } from '../src/editor/decide';
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

describe('a caret on a table\'s outer edge, as a paste leaves it', () => {
	test('← and ↑ from its end select the table, rather than step into its last cell', () => {
		for (const text of [`Intro\n\n${TABLE}‸`, `Intro\n\n${TABLE}‸\n\nAfter`]) {
			assert.deepEqual(press(text, 'left'), { type: 'select', table: spanOf(text), fromAbove: false });
			assert.deepEqual(press(text, 'up'), { type: 'select', table: spanOf(text), fromAbove: false });
		}
	});

	test('→ and ↓ from its start select the table, rather than step into its first cell', () => {
		const text = `Intro\n\n‸${TABLE}\n\nAfter`;
		assert.deepEqual(press(text, 'right'), { type: 'select', table: spanOf(text), fromAbove: true });
		assert.deepEqual(press(text, 'down'), { type: 'select', table: spanOf(text), fromAbove: true });
	});

	test('moving away from the table is left to Obsidian', () => {
		assert.equal(press(`Intro\n\n${TABLE}‸\n\nAfter`, 'right'), null);
		assert.equal(press(`Intro\n\n${TABLE}‸\n\nAfter`, 'down'), null);
		assert.equal(press(`Intro\n\n‸${TABLE}\n\nAfter`, 'left'), null);
		assert.equal(press(`Intro\n\n‸${TABLE}\n\nAfter`, 'up'), null);
	});
});

describe('Delete above a table', () => {
	const run = (text: string) => {
		const state = note(text);
		return deleteForward(state, layoutOf(state));
	};

	test('at the end of the line above, it selects the table, as Backspace does from below', () => {
		const blank = `Intro\n‸\n${TABLE}\n`;
		assert.deepEqual(run(blank), { type: 'select', table: spanOf(blank), fromAbove: true });
		const text = `# Intro‸\n${TABLE}\n`;
		assert.deepEqual(run(text), { type: 'select', table: spanOf(text), fromAbove: true });
	});

	test('anywhere else it is left to Obsidian', () => {
		assert.equal(run(`# Int‸ro\n${TABLE}\n`), null);
		assert.equal(run(`‸Intro\n\n${TABLE}\n`), null);
		assert.equal(run(`\n${TABLE}\n‸After`), null);
		assert.equal(run('‸Plain text\nMore text'), null);
	});

	test('a selection or several carets are left to Obsidian', () => {
		assert.equal(run(`⟨Intro⟩\n${TABLE}\n`), null);
		assert.equal(run(`‸Intro‸\n${TABLE}\n`), null);
		assert.equal(run(selected('\n', '\n')), null);
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

	test('Enter refuses a table Obsidian did not write, and opens nothing', () => {
		const shortRow = '| a   | b   |\n| --- | --- |\n| c   |';
		assert.deepEqual(enter(on(note(`\n⟨${shortRow}⟩\n`), cellAt(1, 0))), { type: 'refuse' });
	});

	test('a table Obsidian did not write can still have its cells selected', () => {
		const shortRow = '| a   | b   |\n| --- | --- |\n| c   |';
		assert.deepEqual(enter(on(note(`\n⟨${shortRow}⟩\n`))), { type: 'cell', cell: { row: 0, column: 0 } });
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

describe('a selected cell and the keys that jump', () => {
	const BIG = '| a   | b   | c   |\n| --- | --- | --- |\n| d   | e   | f   |\n| g   | h   | i   |';
	const grid: Grid = { rows: 3, columns: () => 3 };
	const on3 = (row: number, column: number, cells: Grid = grid) => on(note(`\n⟨${BIG}⟩\n`), { selected: { row, column }, left: null, grid: cells });
	const to = (row: number, column: number): Action => ({ type: 'cell', cell: { row, column } });

	test('Home and Cmd+← go to the first cell of the row', () => {
		assert.deepEqual(rowEnd(on3(1, 1), false), to(1, 0));
	});

	test('End and Cmd+→ go to the last cell of the row', () => {
		assert.deepEqual(rowEnd(on3(1, 1), true), to(1, 2));
	});

	test('Page Up goes to the top of the column', () => {
		assert.deepEqual(page(on3(2, 1), false), to(0, 1));
	});

	test('Page Down goes to the bottom of the column', () => {
		assert.deepEqual(page(on3(0, 1), true), to(2, 1));
	});

	test('Cmd+↑ and Cmd+Home go to the top of the column', () => {
		assert.deepEqual(noteEnd(on3(2, 1), false), to(0, 1));
	});

	test('Cmd+↓ and Cmd+End go to the bottom of the column', () => {
		assert.deepEqual(noteEnd(on3(0, 1), true), to(2, 1));
	});

	test('already on that cell, a jump stays on it', () => {
		assert.deepEqual(rowEnd(on3(1, 0), false), to(1, 0));
		assert.deepEqual(rowEnd(on3(1, 2), true), to(1, 2));
		assert.deepEqual(page(on3(0, 1), false), to(0, 1));
		assert.deepEqual(noteEnd(on3(2, 1), true), to(2, 1));
	});

	test('End goes to the last cell drawn on the row', () => {
		const uneven: Grid = { rows: 3, columns: (row) => (row === 1 ? 2 : 4) };
		assert.deepEqual(rowEnd(on3(1, 0, uneven), true), to(1, 1));
	});

	test('a jump onto a shorter row lands on its last cell', () => {
		const uneven: Grid = { rows: 3, columns: (row) => (row === 2 ? 2 : 4) };
		assert.deepEqual(page(on3(0, 3, uneven), true), to(2, 1));
	});

	test('a table with no drawn rows keeps the cell where it is', () => {
		assert.deepEqual(page(on3(1, 1, noCells.grid), true), to(1, 1));
		assert.deepEqual(rowEnd(on3(1, 1, noCells.grid), true), to(1, 1));
	});

	test('Option with an arrow is taken, and does nothing', () => {
		assert.deepEqual(option(on3(1, 1), true), { type: 'stay' });
		assert.deepEqual(option(on3(1, 1), false), { type: 'stay' });
	});

	test('Shift with a jump is taken, and does nothing', () => {
		assert.deepEqual(shifted(on3(1, 1)), { type: 'stay' });
		assert.deepEqual(shiftedRowEnd(on3(1, 1)), { type: 'stay' });
	});
});

describe('a selected table and the keys that jump', () => {
	const text = selected('Above\n\n', '\nBelow');
	const span = spanOf(text);

	test('Page Down and Option+→ put the caret at the start of the line below', () => {
		assert.deepEqual(page(on(note(text)), true), { type: 'caret', pos: span.to + 1 });
		assert.deepEqual(option(on(note(text)), true), { type: 'caret', pos: span.to + 1 });
	});

	test('Page Up and Option+← put the caret at the end of the line above', () => {
		assert.deepEqual(page(on(note(text)), false), { type: 'caret', pos: span.from - 1 });
		assert.deepEqual(option(on(note(text)), false), { type: 'caret', pos: span.from - 1 });
	});

	test('with no line beyond the table, they are left to the check on key moves', () => {
		assert.equal(page(on(note(`\n⟨${TABLE}⟩`)), true), null);
		assert.equal(option(on(note(`⟨${TABLE}⟩\n`)), false), null);
	});

	test('Home, End, Cmd+← and Cmd+→ do nothing', () => {
		assert.deepEqual(rowEnd(on(note(text)), false), { type: 'stay' });
		assert.deepEqual(rowEnd(on(note(text)), true), { type: 'stay' });
	});

	test('Shift with Home, End, Cmd+← or Cmd+→ does nothing, since Obsidian would shrink it to a caret on its edge', () => {
		assert.deepEqual(shiftedRowEnd(on(note(text))), { type: 'stay' });
		assert.deepEqual(shiftedRowEnd(on(note(selected('Above\n\n', '\nBelow', false)))), { type: 'stay' });
	});

	test('Cmd+↑ and Cmd+↓ are left to Obsidian, which goes to the note\'s start or end', () => {
		assert.equal(noteEnd(on(note(text)), false), null);
		assert.equal(noteEnd(on(note(text)), true), null);
	});

	test('Shift with a jump is left to Obsidian', () => {
		assert.equal(shifted(on(note(text))), null);
	});
});

describe('a caret and the keys that jump', () => {
	const state = () => note(`Ab‸ove\n\n${TABLE}\n`);

	test('every one of them is left to Obsidian', () => {
		for (const forward of [true, false]) {
			assert.equal(rowEnd(on(state()), forward), null);
			assert.equal(page(on(state()), forward), null);
			assert.equal(noteEnd(on(state()), forward), null);
			assert.equal(option(on(state()), forward), null);
		}
		assert.equal(shifted(on(state())), null);
		assert.equal(shiftedRowEnd(on(state())), null);
	});

	test('Home and End with a caret on a table\'s edge, as a paste leaves it, select the table', () => {
		const text = `Above\n\n${TABLE}‸`;
		assert.deepEqual(rowEnd(on(note(text)), false), { type: 'select', table: spanOf(text), fromAbove: false });
		assert.deepEqual(rowEnd(on(note(text)), true), { type: 'select', table: spanOf(text), fromAbove: false });
		const top = `\n‸${TABLE}\n`;
		assert.deepEqual(rowEnd(on(note(top)), true), { type: 'select', table: spanOf(top), fromAbove: true });
	});

	test('Home and End with a selection Shift left on a table\'s edge select the table', () => {
		const text = `⟨Above\n\n${TABLE}⟩\n\nBelow`;
		assert.deepEqual(rowEnd(on(note(text)), true), { type: 'select', table: spanOf(text), fromAbove: true });
	});

	test('with several carets, they stay with Obsidian', () => {
		assert.equal(rowEnd(on(note(`‸Above\n\n${TABLE}‸`)), false), null);
	});
});

describe('the check on key moves', () => {
	const outside = (text: string) => ({ state: note(text), inside: text.replace(/[‸⟨⟩]/g, '').indexOf('Fern') });
	const editor = (state: EditorState) => ({ layout: layoutOf(state), active: true, vim: false, left: null, cellSelected: false });
	const move = (state: EditorState, anchor: number, userEvent = 'select') => state.update({ selection: { anchor }, userEvent });

	test('a word jump into a table from above selects it from above', () => {
		const text = `Above‸\n\n${TABLE}\n\nBelow`;
		const { state, inside } = outside(text);
		assert.deepEqual(landing(move(state, inside), editor(state)), { type: 'select', table: spanOf(text), fromAbove: true });
	});

	test('a word jump into a table from below selects it from below', () => {
		const text = `Above\n\n${TABLE}\n‸Below`;
		const { state, inside } = outside(text);
		assert.deepEqual(landing(move(state, inside), editor(state)), { type: 'select', table: spanOf(text), fromAbove: false });
	});

	test('a jump to the note\'s end, where a table ends it, selects it', () => {
		const text = `Ab‸ove\n\n${TABLE}`;
		const { state } = outside(text);
		assert.deepEqual(landing(move(state, state.doc.length), editor(state)), { type: 'select', table: spanOf(text), fromAbove: true });
	});

	test('a jump to the note\'s start, where a table starts it, selects it from below', () => {
		const text = `${TABLE}\n\nBel‸ow`;
		const { state } = outside(text);
		assert.deepEqual(landing(move(state, 0), editor(state)), { type: 'select', table: spanOf(text), fromAbove: false });
	});

	test('a move in a caret left on a table\'s edge, as a paste leaves it, selects the table', () => {
		const text = `Above\n\n${TABLE}‸`;
		const { state, inside } = outside(text);
		assert.deepEqual(landing(move(state, inside), editor(state)), { type: 'select', table: spanOf(text), fromAbove: false });
	});

	test('Cmd+U and Cmd+Shift+U, which put a selection back from the history, select the table', () => {
		const text = `Above‸\n\n${TABLE}\n\nBelow`;
		const { state, inside } = outside(text);
		assert.deepEqual(landing(move(state, inside, 'select.undo'), editor(state)), { type: 'select', table: spanOf(text), fromAbove: true });
		assert.deepEqual(landing(move(state, inside, 'select.redo'), editor(state)), { type: 'select', table: spanOf(text), fromAbove: true });
	});

	test('a move that lands outside a table is left alone', () => {
		const { state } = outside(`‸Above\n\n${TABLE}\n\nBelow`);
		assert.equal(landing(move(state, 3), editor(state)), null);
	});

	test('from that same table selected, the key does nothing', () => {
		const { state, inside } = outside(selected('Above\n\n', '\nBelow'));
		assert.deepEqual(landing(move(state, inside), editor(state)), { type: 'stay' });
	});

	test('from another selected table, it selects the one it lands in', () => {
		const second = TABLE.replace('Fern', 'Moss');
		const text = `⟨${TABLE}⟩\n\n${second}\n\nBelow`;
		const state = note(text);
		const inside = state.doc.toString().indexOf('Moss');
		assert.deepEqual(landing(move(state, inside), editor(state)), { type: 'select', table: spanOf(text, second), fromAbove: true });
	});

	test('from a selected cell, the move is dropped', () => {
		const { state, inside } = outside(selected('Above\n\n', '\nBelow'));
		assert.deepEqual(landing(move(state, inside), { ...editor(state), cellSelected: true }), { type: 'stay' });
	});

	test('from a selected cell, a move out of the table is left alone', () => {
		const { state } = outside(selected('Above\n\n', '\nBelow'));
		assert.equal(landing(move(state, 0), { ...editor(state), cellSelected: true }), null);
	});

	describe('a big jump and a table Obsidian has not drawn yet', () => {
		const undrawn = (state: EditorState) => ({ ...editor(state), layout: layoutOf(state, { undrawn: true }), left: 'jump down' as const });

		test('going down, it lands on the line below the table', () => {
			const text = `Ab‸ove\n\n${TABLE}\n\nBelow`;
			const { state, inside } = outside(text);
			assert.deepEqual(landing(move(state, inside), undrawn(state)), { type: 'caret', pos: spanOf(text).to + 1 });
		});

		test('going up, it lands on the line above the table', () => {
			const text = `Above\n\n${TABLE}\n\nBel‸ow`;
			const { state, inside } = outside(text);
			assert.deepEqual(landing(move(state, inside), { ...undrawn(state), left: 'jump up' }), { type: 'caret', pos: spanOf(text).from - 1 });
		});

		test('the way it goes comes from the key, not from where the caret was', () => {
			const text = `⟨Above\n\n${TABLE}⟩\n\nBelow`;
			const state = note(text);
			assert.deepEqual(landing(move(state, spanOf(text).to), undrawn(state)), { type: 'caret', pos: spanOf(text).to + 1 });
		});

		test('with no line beyond it, the text is left alone, since Obsidian may never draw it', () => {
			const { state, inside } = outside(`Ab‸ove\n\n${TABLE}`);
			assert.equal(landing(move(state, inside), undrawn(state)), null);
		});

		test('a line that only has a pipe in it is left alone', () => {
			const { state, inside } = outside('Ab‸ove\n\nFern | Hall\n\nBelow');
			assert.equal(landing(move(state, inside), undrawn(state)), null);
		});

		test('any other key move leaves text that looks like a table alone, as in a code block', () => {
			const { state, inside } = outside(`Ab‸ove\n\n${TABLE}\n\nBelow`);
			assert.equal(landing(move(state, inside), { ...undrawn(state), left: null }), null);
			assert.equal(landing(move(state, inside), { ...undrawn(state), left: 'arrow' }), null);
		});

		test('a table that is drawn is selected, as with any other key', () => {
			const text = `Ab‸ove\n\n${TABLE}`;
			const { state, inside } = outside(text);
			assert.deepEqual(landing(move(state, inside), { ...editor(state), left: 'jump down' }), { type: 'select', table: spanOf(text), fromAbove: true });
		});
	});

	describe('stands aside', () => {
		const text = `Above‸\n\n${TABLE}\n\nBelow`;
		const { state, inside } = outside(text);

		test('for a click', () => {
			assert.equal(landing(move(state, inside, 'select.pointer'), editor(state)), null);
		});

		test('for a search result', () => {
			assert.equal(landing(move(state, inside, 'select.search'), editor(state)), null);
		});

		test('for a move with no user event, such as another plugin\'s setCursor', () => {
			assert.equal(landing(state.update({ selection: { anchor: inside } }), editor(state)), null);
		});

		test('for Enter\'s caret, which is meant to open a cell', () => {
			const opening = state.update({ selection: { anchor: inside }, userEvent: 'select', annotations: opensCell.of(true) });
			assert.equal(landing(opening, editor(state)), null);
		});

		test('in an editor without the keyboard, in a composition, or in a cell\'s editor', () => {
			assert.equal(landing(move(state, inside), { ...editor(state), active: false }), null);
		});

		test('in Vim\'s normal and visual modes', () => {
			assert.equal(landing(move(state, inside), { ...editor(state), vim: true }), null);
		});

		test('for a plain arrow left to Obsidian', () => {
			assert.equal(landing(move(state, inside), { ...editor(state), left: 'arrow' as const }), null);
		});

		test('for several carets', () => {
			const several = state.update({ selection: EditorSelection.create([EditorSelection.cursor(0), EditorSelection.cursor(inside)]), userEvent: 'select' });
			assert.equal(landing(several, editor(state)), null);
		});

		test('for a range', () => {
			assert.equal(landing(state.update({ selection: { anchor: 0, head: inside }, userEvent: 'select' }), editor(state)), null);
		});

		test('for an edit', () => {
			assert.equal(landing(state.update({ changes: { from: 0, insert: 'x' }, selection: { anchor: inside }, userEvent: 'select' }), editor(state)), null);
		});
	});
});
