import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Action, arrow, Direction, enter, escape, selectedTable, tab } from '../src/editor/decide';
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
	return arrow({ state, layout: layoutOf(state, drawing), leavesLine: () => leaves }, direction, shift);
}

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

	test('Enter puts the caret at the end of the first cell text', () => {
		const text = selected('\n', '\n');
		const state = note(text);
		assert.deepEqual(enter(state, layoutOf(state)), { type: 'caret', pos: spanOf(text).from + '| Plant'.length });
	});

	test('Escape goes back to the side the table was selected from', () => {
		const fromAbove = selected('# Intro\n', '\nAfter');
		const fromBelow = selected('# Intro\n', '\nAfter', false);
		const run = (text: string) => {
			const state = note(text);
			return escape(state, layoutOf(state));
		};
		assert.deepEqual(run(fromAbove), { type: 'caret', pos: spanOf(fromAbove).from - 1 });
		assert.deepEqual(run(fromBelow), { type: 'caret', pos: spanOf(fromBelow).to + 1 });
	});

	test('Escape goes to the other side when the first one is missing', () => {
		const run = (text: string, drawing?: Drawing) => {
			const state = note(text);
			return escape(state, layoutOf(state, drawing));
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
			return escape(state, layoutOf(state));
		};
		const shifted = `⟨\n${TABLE}⟩`;
		assert.deepEqual(run(shifted), { type: 'select', table: spanOf(shifted), fromAbove: true });
		assert.equal(run(`⟨\n| Plant⟩  | Room |\n| ------ | ---- |\n| Fern   | Hall |`), null);
		assert.equal(run(`⟨# Intro⟩\n${TABLE}`), null);
	});

	test('Tab is taken, and does nothing', () => {
		const state = note(selected('\n', '\n'));
		assert.deepEqual(tab(state, layoutOf(state)), { type: 'stay' });
		const caret = note(`‸\n${TABLE}\n`);
		assert.equal(tab(caret, layoutOf(caret)), null);
		assert.equal(enter(caret, layoutOf(caret)), null);
		assert.equal(escape(caret, layoutOf(caret)), null);
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
