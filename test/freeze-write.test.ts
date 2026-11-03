import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Text } from '@codemirror/state';
import { MAX_FROZEN_COLUMNS, readFreeze } from '../src/editor/freeze-mark';
import { freezeAt, freezeChanges } from '../src/editor/freeze-write';
import { writtenByObsidian } from '../src/editor/table-text';

const freeze = (rows: number, columns: number) => ({ rows, columns });
const cell = (row: number, column: number) => ({ row, column });
const nothing = freeze(0, 0);

test('rows up to here freeze the cell\'s row and every row above it, and keep the frozen columns', () => {
	assert.deepEqual(freezeAt('rows', freeze(0, 2), cell(2, 1)), { freeze: freeze(3, 2), clamped: false });
	assert.deepEqual(freezeAt('rows', nothing, cell(0, 4)), { freeze: freeze(1, 0), clamped: false });
});

test('columns up to here freeze the cell\'s column and every column left of it, and keep the frozen rows', () => {
	assert.deepEqual(freezeAt('columns', freeze(2, 0), cell(5, 1)), { freeze: freeze(2, 2), clamped: false });
	assert.deepEqual(freezeAt('columns', nothing, cell(0, 0)), { freeze: freeze(0, 1), clamped: false });
});

test('rows and columns up to here freeze the cell\'s row and column and everything above and left of them', () => {
	assert.deepEqual(freezeAt('both', freeze(5, 5), cell(2, 1)), { freeze: freeze(3, 2), clamped: false });
	assert.deepEqual(freezeAt('both', nothing, cell(0, 3)), { freeze: freeze(1, 4), clamped: false });
	assert.deepEqual(freezeAt('both', nothing, cell(4, 0)), { freeze: freeze(5, 1), clamped: false });
});

test('on a table\'s first cell, rows and columns up to here freeze its header row and first column', () => {
	assert.deepEqual(freezeAt('both', nothing, cell(0, 0)), { freeze: freeze(1, 1), clamped: false });
});

test('unfreezing freezes nothing, wherever the cell is', () => {
	assert.deepEqual(freezeAt('none', freeze(2, 1), cell(3, 3)), { freeze: nothing, clamped: false });
});

test('columns past the limit stop at it, and say so', () => {
	assert.deepEqual(freezeAt('columns', nothing, cell(1, 12)), { freeze: freeze(0, MAX_FROZEN_COLUMNS), clamped: true });
	assert.deepEqual(freezeAt('columns', nothing, cell(1, MAX_FROZEN_COLUMNS - 1)), { freeze: freeze(0, MAX_FROZEN_COLUMNS), clamped: false });
	assert.deepEqual(freezeAt('both', nothing, cell(1, MAX_FROZEN_COLUMNS)), { freeze: freeze(2, MAX_FROZEN_COLUMNS), clamped: true });
	assert.deepEqual(freezeAt('rows', freeze(0, MAX_FROZEN_COLUMNS), cell(1, 20)), { freeze: freeze(2, MAX_FROZEN_COLUMNS), clamped: false });
});

/** A note with a table between two lines, and the table's span. */
function noteWith(...rows: string[]) {
	const before = 'Above\n\n';
	const doc = Text.of([...before.split('\n').slice(0, -1), ...rows, '', 'Below']);
	const from = before.length;
	return { doc, table: { from, to: from + rows.join('\n').length } };
}

/** The changes for a freeze that can be written. */
function write(doc: Text, table: { from: number; to: number }, frozen: { rows: number; columns: number }) {
	const written = freezeChanges(doc, table, frozen);
	assert.ok(written, 'the freeze can be written');
	return written;
}

function apply(doc: Text, changes: { from: number; to: number; insert: string }[]): Text {
	return [...changes].reverse().reduce((text, { from, to, insert }) => text.replace(from, to, Text.of(insert.split('\n'))), doc);
}

const SHEDS = ['| Name   | Bed  |', '| ------ | ---- |', '| Shed 1 | Moss |', '| Shed 2 | Fern |'];

test('a table Obsidian wrote gets the mark, and its rows are padded again as Obsidian pads them', () => {
	const { doc, table } = noteWith(...SHEDS);
	const { changes, to } = write(doc, table, freeze(2, 1));
	const after = apply(doc, changes);
	assert.deepEqual(after.toString().split('\n').slice(2, 6), ['| %%freeze 2 1%% Name | Bed  |', '| ------------------- | ---- |', '| Shed 1              | Moss |', '| Shed 2              | Fern |']);
	const span = { from: table.from, to };
	assert.equal(after.sliceString(span.to, span.to + 1), '\n');
	assert.ok(writtenByObsidian(after, span), 'Enter can still open its cells');
	assert.deepEqual(readFreeze(after.lineAt(span.from).text), freeze(2, 1));
});

test('each change is one whole line of the table, and lines that stay are left alone', () => {
	const { doc, table } = noteWith('| Name                 | Bed  |', '| -------------------- | ---- |', '| Shed with a long one | Moss |');
	const { changes } = write(doc, table, freeze(1, 0));
	assert.equal(changes.length, 1);
	assert.deepEqual(changes[0], { from: table.from, to: doc.lineAt(table.from).to, insert: '| %%freeze 1 0%% Name  | Bed  |' });
});

test('unfreezing takes the mark out and narrows its column back, so a freeze and an unfreeze leave the text as it was', () => {
	const { doc, table } = noteWith(...SHEDS);
	const frozen = write(doc, table, freeze(2, 1));
	const after = apply(doc, frozen.changes);
	const thawed = write(after, { from: table.from, to: frozen.to }, nothing);
	assert.equal(apply(after, thawed.changes).toString(), doc.toString());
	assert.equal(thawed.to, table.to);
});

test('a new freeze on a frozen table writes over its mark', () => {
	const { doc, table } = noteWith('| %%freeze 2 1%% Name | Bed  |', '| ------------------- | ---- |', '| Shed 1              | Moss |');
	const after = apply(doc, write(doc, table, freeze(1, 2)).changes);
	assert.equal(after.lineAt(table.from).text, '| %%freeze 1 2%% Name | Bed  |');
});

test('nothing changes when the table already says it', () => {
	const { doc, table } = noteWith('| %%freeze 2 1%% Name | Bed  |', '| ------------------- | ---- |', '| Shed 1              | Moss |');
	assert.deepEqual(freezeChanges(doc, table, freeze(2, 1)), { changes: [], to: table.to });
	const plain = noteWith(...SHEDS);
	assert.deepEqual(freezeChanges(plain.doc, plain.table, nothing), { changes: [], to: plain.table.to });
});

test('aligned columns keep their alignment, and the delimiter is written as Obsidian writes it', () => {
	const { doc, table } = noteWith('| Name | Count | Bed |', '| :--- | ----: | :-: |', '| Fern |    10 | ab  |');
	assert.ok(writtenByObsidian(doc, table));
	const after = apply(doc, write(doc, table, freeze(1, 1)).changes);
	assert.deepEqual(after.toString().split('\n').slice(2, 5), ['| %%freeze 1 1%% Name | Count | Bed |', '| :------------------ | ----: | :-: |', '| Fern                |    10 | ab  |']);
	assert.ok(writtenByObsidian(after, { from: table.from, to: after.line(5).to }));
});

test('a table Obsidian didn\'t write keeps its spacing, and only its header row changes', () => {
	const { doc, table } = noteWith('|Name|Bed|', '|---|---|', '|Shed 1|Moss|');
	const { changes, to } = write(doc, table, freeze(1, 0));
	assert.equal(changes.length, 1);
	const after = apply(doc, changes);
	assert.deepEqual(after.toString().split('\n').slice(2, 5), ['| %%freeze 1 0%% Name|Bed|', '|---|---|', '|Shed 1|Moss|']);
	assert.equal(to, after.line(5).to);
});

test('a table with a short row keeps every cell it has', () => {
	const { doc, table } = noteWith('| Name   | Bed  |', '| ------ | ---- |', '| Shed 1 |');
	const after = apply(doc, write(doc, table, freeze(1, 1)).changes);
	assert.deepEqual(after.toString().split('\n').slice(2, 5), ['| %%freeze 1 1%% Name   | Bed  |', '| ------ | ---- |', '| Shed 1 |']);
});

test('the same freeze again changes nothing, even where the delimiter isn\'t written as Obsidian writes it', () => {
	const { doc, table } = noteWith('| %%freeze 2 1%% Name | Bed  |', '|---------------------|------|', '| Shed 1              | Moss |');
	assert.deepEqual(freezeChanges(doc, table, freeze(2, 1)), { changes: [], to: table.to });
});

test('the delimiter stays as it is while no column changes width', () => {
	const { doc, table } = noteWith('| %%freeze 2 1%% Name | Bed  |', '|---------------------|------|', '| Shed 1              | Moss |');
	const { changes } = write(doc, table, freeze(3, 1));
	assert.deepEqual(changes.map(({ insert }) => insert), ['| %%freeze 3 1%% Name | Bed  |']);
});

test('a mark that filled the last cell of a row with no closing pipe leaves that cell, empty', () => {
	const piped = noteWith('| Name | %%freeze 1 0%%', '| --- | ---', '| Shed | x');
	assert.equal(apply(piped.doc, write(piped.doc, piped.table, nothing).changes).line(3).text, '| Name | |');
	const bare = noteWith('Name | Bed | %%freeze 1 0%%', '--- | --- | ---', 'Shed | Moss | x');
	assert.equal(apply(bare.doc, write(bare.doc, bare.table, nothing).changes).line(3).text, 'Name | Bed | |');
	const second = noteWith('Name %%freeze 1 0%% | %%freeze 2 2%%', '--- | ---', 'Shed | x');
	assert.equal(apply(second.doc, write(second.doc, second.table, freeze(3, 1)).changes).line(3).text, 'Name %%freeze 3 1%% | |');
});

test('a header the mark can\'t go in safely is left alone', () => {
	const escaped = noteWith('| Name \\%%freeze 2 1%%| Bed |', '| --- | --- |', '| Shed | Moss |');
	assert.equal(freezeChanges(escaped.doc, escaped.table, nothing), null, 'taking the mark out would escape the pipe after it');
	const dashes = noteWith('| %%freeze 3 2%%- |', '| --------------- |', '| a               |');
	assert.equal(freezeChanges(dashes.doc, dashes.table, nothing), null, 'a header of only dashes isn\'t a row to Obsidian');
	const code = noteWith('Bob`s | Ann`s', '--- | ---', 'a | b');
	assert.equal(freezeChanges(code.doc, code.table, freeze(2, 1)), null, 'the mark would land in what reads as code');
});
