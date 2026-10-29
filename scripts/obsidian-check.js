// In-Obsidian checks for Selectable Tables. They test the three Obsidian behaviors the plugin relies on,
// then the plugin's keys on the test vault's notes, with simulated key presses. Every check that
// shouldn't edit a note compares its text before and after, and every note is put back as it was.
//
// Run in the test vault only, with the plugin built and copied in (npm run test-vault):
//   obsidian vault="Selectable Tables Test" dev:cdp method=Emulation.setFocusEmulationEnabled params='{"enabled":true}'
//   obsidian vault="Selectable Tables Test" eval code="eval(require('fs').readFileSync('<repo>/scripts/obsidian-check.js','utf8'))"
// Results go to test-vault/check-results.json (git ignores it) and to the console.
(async () => {
	const app = window.app;
	const results = [];
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	const settle = () => sleep(120);
	const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: ok ? undefined : detail });

	async function open(name) {
		const file = app.vault.getAbstractFileByPath(`${name}.md`);
		const leaf = app.workspace.getLeaf(false);
		await leaf.openFile(file, { state: { mode: 'source', source: false } });
		await sleep(400);
		const cm = leaf.view.editor.cm;
		cm.focus();
		await settle();
		return cm;
	}

	/** The rendered tables, found the way the plugin finds them: a block widget with the table class. */
	function tables(cm) {
		return Array.from(cm.contentDOM.querySelectorAll(':scope > .cm-table-widget')).map((el) => {
			const block = cm.lineBlockAt(cm.posAtDOM(el));
			const first = cm.state.doc.lineAt(block.from).number;
			const last = cm.state.doc.lineAt(block.to).number;
			return { el, from: block.from, to: block.to, first, last, type: block.type };
		});
	}

	const openCell = (cm) => cm.contentDOM.querySelector('.cm-table-widget.has-focus');
	const cellEditor = (cm) => openCell(cm)?.querySelector('.cm-content');
	const sel = (cm) => {
		const { anchor, head } = cm.state.selection.main;
		return { anchor, head, line: cm.state.doc.lineAt(head).number, ranges: cm.state.selection.ranges.length };
	};
	const caretOnLine = async (cm, n, column = 0) => {
		const line = cm.state.doc.line(n);
		cm.focus();
		cm.dispatch({ selection: { anchor: Math.min(line.to, line.from + column) }, scrollIntoView: true });
		await settle();
	};
	const keyCodes = { ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete' };
	async function press(target, key, mods = {}) {
		const el = target.contentDOM ?? target;
		el.dispatchEvent(new KeyboardEvent('keydown', { key, code: keyCodes[key] ?? key, bubbles: true, cancelable: true, ...mods }));
		await settle();
	}
	// Closes an open cell: the note's caret leaves the table first, or focusing would open the cell again.
	async function closeCell(cm, pos) {
		cm.dispatch({ selection: { anchor: pos } });
		cm.focus();
		await sleep(250);
	}
	async function restore(cm, text) {
		if (cm.state.doc.toString() !== text) cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } });
		await settle();
	}

	try {
		// --- What the plugin relies on in Obsidian
		let cm = await open('Two report tables');
		let original = cm.state.doc.toString();
		let [t1, t2] = tables(cm);
		check('relies 1: a rendered table is one block widget carrying cm-table-widget', t1 && t2 && typeof t1.type === 'number' && t1.el.classList.contains('cm-table-widget') && cm.state.sliceDoc(t1.from, t1.to).startsWith('| Plant'), { t1, t2 });
		cm.dispatch({ selection: { anchor: t1.from + 3 } });
		await sleep(300);
		check('relies 2a: a caret inside a table opens a cell', openCell(cm), sel(cm));
		// With the cell open, select the whole table, then focus the note's editor, as Escape in a cell
		// does. (Focusing it with the note's caret still inside the table opens the cell again.)
		cm.dispatch({ selection: { anchor: t1.from, head: t1.to } });
		await sleep(200);
		check('relies 2b: a selection over the whole table opens no cell and tints the table', t1.el.classList.contains('is-selected'), sel(cm));
		cm.focus();
		await sleep(300);
		check('relies 3: focusing the note\'s editor closes an open cell', !openCell(cm) && cm.hasFocus, sel(cm));

		// --- A. Passing
		await caretOnLine(cm, t1.first - 1);
		await press(cm, 'ArrowDown');
		check('A1 ↓ from the line above lands on the line below, no cell opened', sel(cm).line === t1.last + 1 && !openCell(cm), sel(cm));
		await press(cm, 'ArrowUp');
		check('A2 ↑ goes back to the line above', sel(cm).line === t1.first - 1 && !openCell(cm), sel(cm));
		await caretOnLine(cm, 1, 100);
		const visited = [];
		for (let i = 0; i < cm.state.doc.lines + 2; i++) {
			await press(cm, 'ArrowDown');
			visited.push(sel(cm).line);
			if (openCell(cm)) break;
		}
		const inside = (l) => (l >= t1.first && l <= t1.last) || (l >= t2.first && l <= t2.last);
		check('A3 holding ↓ never stops in a table', !visited.some(inside) && !openCell(cm) && sel(cm).line === cm.state.doc.lines, visited);
		const back = [];
		for (let i = 0; i < cm.state.doc.lines + 2; i++) {
			await press(cm, 'ArrowUp');
			back.push(sel(cm).line);
		}
		check('A4 holding ↑ back to the top never stops in a table', !back.some(inside) && sel(cm).line === 1, back);
		check('A: passing left the note unchanged', cm.state.doc.toString() === original);

		// --- B. Selecting from the side
		await caretOnLine(cm, t1.first - 1);
		await press(cm, 'ArrowRight');
		let s = sel(cm);
		check('B5 → selects the whole table, tinted, with no caret showing', s.anchor === t1.from && s.head === t1.to && t1.el.classList.contains('is-selected') && cm.dom.classList.contains('selectable-tables-selected') && getComputedStyle(cm.dom.querySelector('.cm-cursorLayer')).display === 'none', s);
		await press(cm, 'ArrowRight');
		s = sel(cm);
		check('B6 → again: the caret at the start of the line below', s.head === t1.to + 1 && s.anchor === s.head, s);
		await press(cm, 'ArrowLeft');
		await press(cm, 'ArrowLeft');
		s = sel(cm);
		check('B7 ← selects it, ← again: the end of the line above', s.head === t1.from - 1 && s.anchor === s.head && !openCell(cm), s);

		// --- C. Enter, Escape
		await press(cm, 'ArrowRight');
		await press(cm, 'Enter');
		await sleep(200);
		check('C9 Enter opens the first cell', openCell(cm) && openCell(cm).querySelector('.cm-editor') && t1.el.contains(openCell(cm)), sel(cm));
		const cell = cellEditor(cm);
		if (cell) {
			await press(cell, 'Escape');
			await sleep(200);
			s = sel(cm);
			check('C11 Escape in the cell closes it and selects the whole table', !openCell(cm) && s.anchor === t1.to && s.head === t1.from && cm.hasFocus, s);
			await press(cm, 'Escape');
			s = sel(cm);
			check('C12 Escape again: the caret on the line below', s.head === t1.to + 1 && s.anchor === s.head, s);
		}
		check('C: Enter and Escape left the note unchanged', cm.state.doc.toString() === original);

		// --- D. Typing, Tab, delete
		await caretOnLine(cm, t1.first - 1);
		await press(cm, 'ArrowRight');
		// The guard against typing works on the browser's beforeinput event. (document.execCommand skips
		// that event, so it can't stand in for typing. Real key presses, sent through the CLI's dev:cdp
		// with Input.dispatchKeyEvent, were checked on 10/29 and changed nothing.)
		const input = new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true });
		cm.contentDOM.dispatchEvent(input);
		await settle();
		await press(cm, 'Tab');
		await press(cm, 'Enter', { shiftKey: true });
		s = sel(cm);
		check('D18 typing, Tab and Shift+Enter on a selected table change nothing', input.defaultPrevented && cm.state.doc.toString() === original && s.anchor === t1.from && s.head === t1.to && !openCell(cm), s);
		await restore(cm, original);
		[t1] = tables(cm);
		cm.dispatch({ selection: { anchor: t1.from, head: t1.to } });
		// Past CodeMirror's half-second grouping, so undo takes back only the delete.
		await sleep(700);
		await press(cm, 'Backspace');
		check('D16 Backspace deletes the selected table', cm.state.doc.toString() === original.slice(0, t1.from) + original.slice(t1.to));
		// Cmd+Z (Ctrl+Z elsewhere): Obsidian's undo command doesn't run from the CLI's eval.
		const mac = navigator.platform.startsWith('Mac');
		await press(cm, 'z', { metaKey: mac, ctrlKey: !mac, code: 'KeyZ' });
		check('D16 undo brings it back unchanged', cm.state.doc.toString() === original);
		await restore(cm, original);

		// --- E. Shift
		[t1] = tables(cm);
		await caretOnLine(cm, t1.first - 1);
		await press(cm, 'ArrowDown', { shiftKey: true });
		s = sel(cm);
		check('E19 Shift+↓ takes the whole table', s.anchor === t1.from - 1 && s.head === t1.to + 1 && !openCell(cm) && t1.el.classList.contains('is-selected'), s);
		await press(cm, 'ArrowUp', { shiftKey: true });
		s = sel(cm);
		check('E19 Shift+↑ shrinks it back to nothing', s.anchor === s.head && s.head === t1.from - 1, s);

		// --- G. Edges
		cm = await open('Table first');
		original = cm.state.doc.toString();
		let [t] = tables(cm);
		// Obsidian keeps a blank line around the tables it makes; at a note's edge, the plugin steps aside.
		await caretOnLine(cm, t.last + 1);
		await press(cm, 'ArrowUp');
		await sleep(200);
		check('G22 Table first: ↑ from below is left to Obsidian, which enters the table', openCell(cm) && cm.state.doc.toString() === original, sel(cm));
		await closeCell(cm, cm.state.doc.line(t.last + 1).from);
		await restore(cm, original);
		[t] = tables(cm);
		await caretOnLine(cm, t.last + 1);
		await press(cm, 'ArrowLeft');
		await press(cm, 'Enter');
		await sleep(200);
		check('G22 Enter on the first table of a note opens its first cell', openCell(cm) && cm.state.doc.toString() === original, sel(cm));
		cm.focus();
		await settle();

		cm = await open('Table last');
		original = cm.state.doc.toString();
		[t] = tables(cm);
		await caretOnLine(cm, t.first - 1);
		await press(cm, 'ArrowDown');
		await sleep(200);
		check('G23 Table last: ↓ from above is left to Obsidian, which enters the table', openCell(cm) && cm.state.doc.toString() === original, sel(cm));
		await closeCell(cm, cm.state.doc.line(t.first - 1).from);
		await restore(cm, original);

		cm = await open('Properties then table');
		original = cm.state.doc.toString();
		[t] = tables(cm);
		check('G24 a table right below the properties is rendered', t && cm.state.sliceDoc(t.from, t.to).startsWith('| Task'), t);
		if (t) {
			await caretOnLine(cm, t.last + 1);
			await press(cm, 'ArrowUp');
			await sleep(200);
			check('G24 ↑ from below is left to Obsidian, which enters the table', openCell(cm) && cm.state.doc.toString() === original, sel(cm));
			await closeCell(cm, cm.state.doc.line(t.last + 1).from);
			await restore(cm, original);
		}

		cm = await open('Edge cases');
		original = cm.state.doc.toString();
		const edge = tables(cm);
		check('G26/27 the callout and the list item hold no rendered table', edge.length === 3, edge.map((e) => e.first));
		const [heading, a, b] = edge;
		await caretOnLine(cm, heading.first - 1, 0);
		const rows = [];
		for (let i = 0; i < 6 && sel(cm).line === heading.first - 1; i++) {
			await press(cm, 'ArrowDown');
			rows.push(sel(cm).line);
		}
		check('G25 ↓ walks the wrapped heading, then passes the table', rows.length > 1 && rows.at(-1) === heading.last + 1 && !openCell(cm), rows);
		await caretOnLine(cm, a.first - 1);
		await press(cm, 'ArrowDown');
		const between = sel(cm).line;
		await press(cm, 'ArrowDown');
		check('G28 two close tables: one stop on the blank line between, then past the second', between === a.last + 1 && sel(cm).line === b.last + 1, { between, after: sel(cm).line });
		check('G: the edge notes are unchanged', cm.state.doc.toString() === original);

		cm = await open('Images and tables');
		[t] = tables(cm);
		check('H a table between two images is rendered', !!t, tables(cm).length);

		// --- I. Source mode: no rendered tables, the plugin steps aside
		cm = await open('Two report tables');
		const view = app.workspace.getMostRecentLeaf().view;
		await view.setState({ ...view.getState(), mode: 'source', source: true }, { history: false });
		await sleep(400);
		cm = view.editor.cm;
		check('I32 Source mode draws no table widgets', tables(cm).length === 0);
		await view.setState({ ...view.getState(), mode: 'source', source: false }, { history: false });
	} catch (error) {
		results.push({ name: 'the check script itself', ok: false, detail: String(error && error.stack || error) });
	}

	const failed = results.filter((r) => !r.ok);
	// The obsidian module isn't loadable from the CLI's eval, so the app's version comes from its main process.
	const version = window.electron.ipcRenderer.sendSync('version');
	const summary = { obsidian: version, passed: results.length - failed.length, failed: failed.length, results };
	const path = window.require('path').join(app.vault.adapter.basePath, '..', 'check-results.json');
	window.require('fs').writeFileSync(path, JSON.stringify(summary, null, '\t'));
	console.log(`Selectable Tables check: ${summary.passed} passed, ${summary.failed} failed. Results in ${path}`);
	return `${summary.passed} passed, ${summary.failed} failed`;
})();
