import assert from 'node:assert/strict';
import { test } from 'node:test';
import { layers, opacity, readPaint } from '../src/editor/theme-paint';

test('reads how opaque a computed color is, in the forms browsers give', () => {
	assert.equal(opacity('rgba(0, 0, 0, 0)'), 0);
	assert.equal(opacity('transparent'), 0);
	assert.equal(opacity('rgb(248, 248, 248)'), 1);
	assert.equal(opacity('rgba(120, 120, 255, 0.12)'), 0.12);
	assert.equal(opacity('rgb(120 120 255 / 40%)'), 0.4);
	assert.equal(opacity('oklch(0.97 0.01 250)'), 1);
	assert.equal(opacity('oklch(0.6 0.1 250 / 0.08)'), 0.08);
	assert.equal(opacity('color(srgb 0.5 0.5 0.5 / 0.25)'), 0.25);
	assert.equal(opacity('color(display-p3 1 0 0)'), 1);
	assert.equal(opacity('lab(50 10 10 / none)'), 0);
});

test('a color it can\'t read counts as see-through, so whatever is under it is still laid under', () => {
	assert.ok(Number.isNaN(opacity('color-mix(in srgb, currentcolor 10%, transparent)')));
	assert.ok(Number.isNaN(opacity('rgb(from red r g b / alpha)')));
	assert.ok(!(opacity('color-mix(in srgb, currentcolor 10%, transparent)') >= 1));
});

test('lays colors over each other as one-color gradients, top first', () => {
	assert.equal(layers([]), 'none');
	assert.equal(layers(['rgba(255, 255, 255, 0.5)', 'rgb(236, 238, 230)']), 'linear-gradient(rgba(255, 255, 255, 0.5) 0 0), linear-gradient(rgb(236, 238, 230) 0 0)');
});

/** A stand-in for the page around a table: each element has a background color, and nothing is under the pointer. */
interface Fake {
	color: string;
	parentElement: Fake | null;
	[key: string]: unknown;
}

const fake = (color: string, parentElement: Fake | null, more: Record<string, unknown> = {}): Fake => ({ color, parentElement, matches: () => false, ...more });

/** A table of a header and four body rows, three cells each, in a widget on a note. `colors` sets the table's own and its wrapper's. */
function drawn(colors: { table: string; wrapper: string }) {
	const note = fake('rgb(250, 250, 250)', null);
	const widget = fake('rgba(0, 0, 0, 0)', note);
	const wrapper = fake(colors.wrapper, widget);
	const table = fake(colors.table, wrapper);
	const section = (color: string, count: number, row: string, cell: string) => {
		const element = fake(color, table);
		const rows: Fake[] = [];
		for (let index = 0; index < count; index++) {
			const tr = fake(row, element);
			tr.cells = [0, 1, 2].map(() => fake(cell, tr));
			const previous = rows[rows.length - 1];
			if (previous) previous.nextElementSibling = tr;
			rows.push(tr);
		}
		element.rows = rows;
		return element;
	};
	const head = section('rgba(0, 128, 0, 0.3)', 1, 'rgba(10, 10, 10, 0.4)', 'rgba(20, 20, 20, 0.5)');
	const body = section('rgba(0, 0, 128, 0.3)', 4, 'rgba(30, 30, 30, 0.4)', 'rgba(40, 40, 40, 0.5)');
	Object.assign(table, { tHead: head, tBodies: [body], rows: [...(head.rows as Fake[]), ...(body.rows as Fake[])] });
	return { widget, table, cellColors: ['rgba(0, 128, 0, 0.3)', 'rgba(10, 10, 10, 0.4)', 'rgba(20, 20, 20, 0.5)', 'rgba(0, 0, 128, 0.3)', 'rgba(30, 30, 30, 0.4)', 'rgba(40, 40, 40, 0.5)'] };
}

function read(colors: { table: string; wrapper: string }) {
	const { widget, table, cellColors } = drawn(colors);
	const style = globalThis as { getComputedStyle?: unknown };
	const before = style.getComputedStyle;
	style.getComputedStyle = (element: Fake) => ({ backgroundColor: element.color, borderCollapse: 'separate' });
	try {
		const paint = readPaint(widget as unknown as HTMLElement, table as unknown as HTMLTableElement);
		return { variables: new Map(paint.variables), cellColors };
	} finally {
		style.getComputedStyle = before;
	}
}

test('a cell\'s corners show the table\'s colors over what\'s behind it, never the cell\'s, its row\'s or its header\'s', () => {
	const { variables, cellColors } = read({ table: 'rgba(255, 0, 0, 0.2)', wrapper: 'rgba(0, 0, 255, 0.1)' });
	const corners = variables.get('--selectable-tables-corners') ?? '';
	assert.equal(corners, 'inset 0 0 0 100vmax rgba(255, 0, 0, 0.2), inset 0 0 0 100vmax rgba(0, 0, 255, 0.1), inset 0 0 0 100vmax rgb(250, 250, 250)');
	for (const color of cellColors) assert.ok(!corners.includes(color), color);
	// The cells themselves still take every layer, their own first.
	assert.equal(variables.get('--selectable-tables-head-odd-cell'), layers(['rgba(20, 20, 20, 0.5)', 'rgba(10, 10, 10, 0.4)', 'rgba(0, 128, 0, 0.3)', 'rgba(255, 0, 0, 0.2)', 'rgba(0, 0, 255, 0.1)']));
	assert.equal(variables.get('--selectable-tables-strip'), 'var(--selectable-tables-strip-offset) 0 0 rgb(250, 250, 250)');
});

test('a solid table is all a cell\'s corners show', () => {
	const { variables } = read({ table: 'rgb(200, 210, 220)', wrapper: 'rgba(0, 0, 255, 0.1)' });
	assert.equal(variables.get('--selectable-tables-corners'), 'inset 0 0 0 100vmax rgb(200, 210, 220)');
});

test('a clear table shows the note at a cell\'s corners', () => {
	const { variables } = read({ table: 'rgba(0, 0, 0, 0)', wrapper: 'transparent' });
	assert.equal(variables.get('--selectable-tables-corners'), 'inset 0 0 0 100vmax rgb(250, 250, 250)');
});
