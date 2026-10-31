// In-Obsidian checks for Selectable Tables. They test the Obsidian behaviors the plugin relies on, then
// the plugin's keys on the test vault's notes, with simulated key presses, and with real ones through the
// browser for the keys the check on key moves has to tell apart. Every check that shouldn't
// edit a note compares its text before and after, and every note is put back as it was.
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
	// The open cell's own editor, its row and column, and those of the selected cell.
	const cellView = (cm) => cm.constructor.findFromDOM(openCell(cm).querySelector('.cm-editor'));
	const placeOf = (cell) => cell && `${cell.parentElement.rowIndex},${cell.cellIndex}`;
	const openAt = (cm) => placeOf(openCell(cm)?.querySelector('.cm-editor').closest('td, th'));
	const marked = (cm) => cm.contentDOM.querySelectorAll('.selectable-tables-cell');
	const at = (cm) => (marked(cm).length === 1 ? placeOf(marked(cm)[0]) : `${marked(cm).length} marked`);
	const box = (el) => {
		const { width, height } = el.getBoundingClientRect();
		return `${width}x${height}`;
	};
	const tint = (t) => getComputedStyle(t.el.querySelector('table'), '::after').display !== 'none' && getComputedStyle(t.el.querySelector('table'), '::after').content !== 'none';
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
	const selectsWhole = (cm, t) => Math.min(sel(cm).anchor, sel(cm).head) === t.from && Math.max(sel(cm).anchor, sel(cm).head) === t.to;
	const keyCodes = { ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace', Delete: 'Delete' };
	async function press(target, key, mods = {}) {
		const el = target.contentDOM ?? target;
		el.dispatchEvent(new KeyboardEvent('keydown', { key, code: keyCodes[key] ?? key, bubbles: true, cancelable: true, ...mods }));
		await settle();
	}
	// The keyboard and mouse as the browser gets them, not an event sent to one element. The check on key
	// moves has to tell these apart, so its own checks use them.
	const cdp = window.electron.remote.getCurrentWebContents().debugger;
	const attachedHere = !cdp.isAttached();
	if (attachedHere) cdp.attach('1.3');
	const virtualKeys = { ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PageUp: 33, PageDown: 34, End: 35, Home: 36 };
	async function real(key, { altKey, ctrlKey, metaKey, shiftKey } = {}, wait = settle) {
		const modifiers = (altKey ? 1 : 0) | (ctrlKey ? 2 : 0) | (metaKey ? 4 : 0) | (shiftKey ? 8 : 0);
		const event = { key, code: key, windowsVirtualKeyCode: virtualKeys[key], modifiers };
		await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'rawKeyDown' });
		await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
		await wait();
	}
	async function realClick(el) {
		const { left, top, width, height } = el.getBoundingClientRect();
		const point = { x: left + width / 2, y: top + height / 2, button: 'left', clickCount: 1 };
		await cdp.sendCommand('Input.dispatchMouseEvent', { ...point, type: 'mousePressed' });
		await cdp.sendCommand('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased' });
		await sleep(400);
	}
	// What each transaction an action sends says about where it came from.
	async function eventsDuring(cm, action) {
		const seen = [];
		const update = cm.update;
		cm.update = function (transactions) {
			for (const tr of transactions) if (tr.selection && !tr.docChanged) seen.push(tr.isUserEvent('select.pointer') ? 'select.pointer' : tr.isUserEvent('select') ? 'select' : 'none');
			return update.call(this, transactions);
		};
		await action();
		delete cm.update;
		return seen;
	}
	const option = { altKey: true };
	const command = { metaKey: true };
	// Closes an open cell: the note's caret leaves the table first, or focusing would open the cell again.
	async function closeCell(cm, pos) {
		cm.dispatch({ selection: { anchor: pos } });
		cm.focus();
		await sleep(250);
	}
	// The caret moves off first: on a selected cell, the edit guard stops this edit too.
	async function restore(cm, text) {
		cm.dispatch({ selection: { anchor: 0 } });
		await settle();
		if (cm.state.doc.toString() !== text) cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } });
		await settle();
	}
	// CodeMirror draws only what's near the view, so a table is scrolled to before it's looked up.
	async function tableUnder(cm, heading) {
		const start = cm.state.doc.toString().indexOf(`## ${heading}`);
		cm.focus();
		cm.dispatch({ selection: { anchor: start }, scrollIntoView: true });
		await sleep(300);
		return tables(cm).find((t) => t.from > start);
	}
	// Selects a table from the line above it, or from the line below.
	async function selectTable(cm, t, fromAbove = true) {
		await caretOnLine(cm, fromAbove ? t.first - 1 : t.last + 1);
		await press(cm, fromAbove ? 'ArrowRight' : 'ArrowLeft');
	}
	// Presses keys on a selected cell. Each press has to open nothing, edit nothing and keep the table's size.
	async function keys(cm, t, ...pressed) {
		const before = { text: cm.state.doc.toString(), size: box(t.el) };
		let quiet = true;
		for (const [key, mods] of pressed.map((p) => (Array.isArray(p) ? p : [p]))) {
			await press(cm, key, mods);
			quiet = quiet && !openCell(cm) && box(t.el) === before.size && cm.state.doc.toString() === before.text;
		}
		return quiet;
	}
	const repeat = (key, times) => Array(times).fill(key);
	// A press on a cell, as the mouse sends it.
	async function click(cell) {
		const { left, top, width, height } = cell.getBoundingClientRect();
		const point = { bubbles: true, cancelable: true, button: 0, clientX: left + width / 2, clientY: top + height / 2, view: window };
		cell.dispatchEvent(new PointerEvent('pointerdown', { ...point, isPrimary: true, pointerId: 1, pointerType: 'mouse' }));
		cell.dispatchEvent(new MouseEvent('click', point));
		await sleep(400);
	}
	// A clipboard event of the browser's own kind, which leaves the real clipboard alone.
	function clipboard(cm, type, text) {
		const data = new DataTransfer();
		if (text) data.setData('text/plain', text);
		const event = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true });
		cm.contentDOM.dispatchEvent(event);
		return { taken: event.defaultPrevented, text: data.getData('text/plain') };
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
		cm.dispatch({ selection: { anchor: t1.from, head: t1.to } });
		await settle();
		check('relies 6: the selected table\'s tint is drawn on the table element', tint(t1), getComputedStyle(t1.el.querySelector('table'), '::after').content);

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
		const frame = getComputedStyle(t1.el.querySelector('table'), '::after');
		check('B5 → selects the whole table, tinted and framed, with no caret showing', s.anchor === t1.from && s.head === t1.to && t1.el.classList.contains('is-selected') && cm.dom.classList.contains('selectable-tables-selected') && getComputedStyle(cm.dom.querySelector('.cm-cursorLayer')).display === 'none' && parseFloat(frame.borderTopWidth) > 0, { ...s, border: frame.borderTopWidth });
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
		check('C9 Enter selects the first cell and opens nothing', at(cm) === '0,0' && !openCell(cm), at(cm));
		await press(cm, 'Enter');
		await sleep(200);
		check('C10 Enter again opens it', openAt(cm) === '0,0' && t1.el.contains(openCell(cm)), openAt(cm));
		const cell = cellEditor(cm);
		if (cell) {
			await press(cell, 'Escape');
			await sleep(200);
			s = sel(cm);
			check('C11 Escape in the cell closes it and selects that cell', !openCell(cm) && at(cm) === '0,0' && s.anchor === t1.from && s.head === t1.to && cm.hasFocus, { ...s, at: at(cm) });
			await press(cm, 'Escape');
			check('C12 Escape again selects the whole table', marked(cm).length === 0 && sel(cm).head === t1.to && tint(t1), sel(cm));
			await press(cm, 'Escape');
			s = sel(cm);
			check('C13 Escape again: the caret back on the side it was selected from', s.head === t1.from - 1 && s.anchor === s.head, s);
		}
		check('C: Enter and Escape left the note unchanged', cm.state.doc.toString() === original);

		// --- What the plugin relies on for selected cells
		cm = await open('Cell moves');
		original = cm.state.doc.toString();
		let seed = await tableUnder(cm, 'Seed trays');
		const seedRows = seed.el.querySelector('table').rows;
		const seedText = (row, column) => seedRows[row].cells[column].querySelector('.table-cell-wrapper').textContent.trim();
		check('relies 4: the rows on screen line up with the text: the header is row 0, the delimiter has no row', seedRows.length === seed.last - seed.first && seedText(0, 0) === 'Tray' && seedText(1, 0) === 'A1' && seedText(4, 2) === 'Water twice', seedRows.length);
		const fern = cm.state.doc.line(seed.first + 2);
		cm.dispatch({ selection: { anchor: fern.from + fern.text.indexOf('Fern') } });
		await sleep(300);
		check('relies 5: a caret in a cell\'s text opens exactly that cell', openAt(cm) === '1,1', openAt(cm));
		await closeCell(cm, seed.from - 1);
		await restore(cm, original);

		// --- Cells A. Moving
		seed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, seed);
		const size = box(seed.el);
		await press(cm, 'Enter');
		const cellFrame = getComputedStyle(marked(cm)[0] ?? cm.contentDOM, '::after');
		check('1 Enter selects the first cell: its frame, no table tint, no caret, nothing opened', at(cm) === '0,0' && parseFloat(cellFrame.borderTopWidth) > 0 && !tint(seed) && getComputedStyle(cm.dom.querySelector('.cm-cursorLayer')).display === 'none' && !openCell(cm), { at: at(cm), border: cellFrame.borderTopWidth, tint: tint(seed) });
		let quiet = await keys(cm, seed, 'ArrowDown', 'ArrowRight');
		check('2 ↓ then → reach Fern, still a rendered link, at the same size', quiet && at(cm) === '1,1' && marked(cm)[0].querySelector('a') && box(seed.el) === size, at(cm));
		quiet = await keys(cm, seed, 'ArrowRight');
		const notes = at(cm);
		quiet = (await keys(cm, seed, 'ArrowRight')) && quiet;
		check('3 → reaches the last column, and the next stops there', quiet && notes === '1,2' && at(cm) === '1,2', at(cm));
		quiet = await keys(cm, seed, ...repeat('ArrowDown', 3));
		const water = at(cm);
		quiet = (await keys(cm, seed, 'ArrowDown')) && quiet;
		check('4 ↓ reaches the last row, and the next stops there', quiet && water === '4,2' && at(cm) === '4,2', at(cm));
		quiet = await keys(cm, seed, ...repeat('ArrowLeft', 4), ...repeat('ArrowUp', 6));
		check('5 holding ← and ↑ runs to the first cell and stops, nothing opening', quiet && at(cm) === '0,0', at(cm));
		quiet = await keys(cm, seed, ...repeat('Tab', 3));
		const wrapped = at(cm);
		quiet = (await keys(cm, seed, ['Tab', { shiftKey: true }])) && quiet;
		check('6 Tab wraps to the next row, Shift+Tab back', quiet && wrapped === '1,0' && at(cm) === '0,2', { wrapped, at: at(cm) });
		quiet = await keys(cm, seed, ...repeat('ArrowDown', 4), 'Tab');
		check('7 Tab on the last cell does nothing, and adds no row', quiet && at(cm) === '4,2' && seedRows.length === 5, at(cm));
		quiet = await keys(cm, seed, ...repeat('ArrowUp', 4), ...repeat('ArrowLeft', 2), ['Tab', { shiftKey: true }]);
		check('8 Shift+Tab on the first cell does nothing', quiet && at(cm) === '0,0', at(cm));

		// --- Cells B. Enter and Escape
		await keys(cm, seed, 'ArrowDown', 'ArrowRight');
		await press(cm, 'Enter');
		await sleep(250);
		let inner = openCell(cm) && cellView(cm);
		check('9 Enter opens that cell, showing its source, the caret at the end', openAt(cm) === '1,1' && inner && inner.state.doc.toString() === '[[Watering schedule|Fern]]' && inner.state.selection.main.head === inner.state.doc.length, openAt(cm));
		inner.dispatch(inner.state.replaceSelection('x'));
		await settle();
		await press(cellEditor(cm), 'Escape');
		await sleep(250);
		check('10 Escape closes it, shows the edit, and selects that cell', !openCell(cm) && at(cm) === '1,1' && marked(cm)[0].textContent.includes('Fernx') && cm.state.doc.toString() !== original, at(cm));
		await press(cm, 'Enter');
		await sleep(250);
		inner = cellView(cm);
		inner.dispatch({ changes: { from: inner.state.doc.length - 1, to: inner.state.doc.length } });
		await settle();
		await press(cellEditor(cm), 'Escape');
		await sleep(250);
		check('11 taking the x back out leaves the note as it was, the cell selected', at(cm) === '1,1' && cm.state.doc.toString() === original, at(cm));
		seed = tables(cm).find((t) => t.first === seed.first);
		await press(cm, 'Escape');
		check('12 Escape selects the whole table, tinted', marked(cm).length === 0 && sel(cm).anchor === seed.from && sel(cm).head === seed.to && tint(seed), sel(cm));
		await press(cm, 'Enter');
		check('13 Enter goes back to the cell it left', at(cm) === '1,1', at(cm));
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		check('14 Escape twice: the caret on the side the table was selected from', sel(cm).line === seed.first - 1 && sel(cm).anchor === sel(cm).head && marked(cm).length === 0, sel(cm));
		await press(cm, 'ArrowRight');
		await press(cm, 'Enter');
		check('15 arriving from outside starts at the first cell', at(cm) === '0,0', at(cm));
		const water2 = cm.state.doc.line(seed.first + 5);
		cm.dispatch({ selection: { anchor: water2.from + water2.text.indexOf('Water') } });
		await sleep(300);
		check('16 opening a cell directly takes the selection off the cell', openAt(cm) === '4,2' && marked(cm).length === 0, openAt(cm));
		await press(cellEditor(cm), 'Escape');
		await sleep(250);
		check('16 Escape selects that cell', at(cm) === '4,2', at(cm));
		await press(cm, 'ArrowUp');
		check('16 ↑ moves on from there', at(cm) === '3,2', at(cm));
		await press(cm, 'Enter');
		await sleep(250);
		check('17 a cell with an escaped pipe opens showing it as a plain pipe', cellView(cm).state.doc.toString() === 'a | b', cellView(cm)?.state.doc.toString());
		await press(cellEditor(cm), 'Escape');
		await sleep(250);
		await keys(cm, seed, 'ArrowUp');
		await press(cm, 'Enter');
		await sleep(250);
		check('18 an empty cell opens, empty', openAt(cm) === '2,2' && cellView(cm).state.doc.length === 0, openAt(cm));
		await press(cellEditor(cm), 'Escape');
		await sleep(250);
		await keys(cm, seed, ...repeat('ArrowUp', 2), ...repeat('ArrowLeft', 2));
		await press(cm, 'Enter');
		await sleep(250);
		await press(cellEditor(cm), 'Tab');
		await sleep(250);
		const tabbed = openAt(cm);
		await press(cellEditor(cm), 'Enter');
		await sleep(250);
		const entered = openAt(cm);
		await press(cellEditor(cm), 'Escape');
		await sleep(250);
		check('19 in an open cell, Tab and Enter are Obsidian\'s, and Escape selects the cell they ended on', tabbed === '0,1' && entered === '1,1' && at(cm) === '1,1', { tabbed, entered, at: at(cm) });
		await press(cm, 'Enter');
		await sleep(250);
		await press(cellEditor(cm), 'ArrowRight', { shiftKey: true });
		await press(cellEditor(cm), 'ArrowRight', { shiftKey: true });
		await sleep(200);
		const widget = seed.el;
		const ranged = widget.classList.contains('has-selection');
		await press(cellEditor(cm), 'Escape');
		await sleep(250);
		check('21 Escape from a range of cells clears it and selects the cell it started on', ranged && !widget.classList.contains('has-selection') && !widget.querySelector('td.is-selected, th.is-selected') && at(cm) === '1,1', { ranged, left: widget.classList.contains('has-selection'), at: at(cm) });
		await restore(cm, original);

		// --- Cells C. Keys that change nothing
		seed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, seed);
		await press(cm, 'Enter');
		await keys(cm, seed, 'ArrowDown', 'ArrowRight');
		const typed = new InputEvent('beforeinput', { inputType: 'insertText', data: 'x', bubbles: true, cancelable: true });
		cm.contentDOM.dispatchEvent(typed);
		await settle();
		quiet = await keys(cm, seed, ' ', ['Enter', { shiftKey: true }]);
		check('22 typing, Space and Shift+Enter do nothing', typed.defaultPrevented && quiet && at(cm) === '1,1', at(cm));
		quiet = await keys(cm, seed, 'Backspace', 'Delete');
		const cut = clipboard(cm, 'cut');
		const paste = clipboard(cm, 'paste', 'pasted');
		await settle();
		check('23 Backspace, Delete, Cut and Paste do nothing', quiet && cut.taken && !cut.text && paste.taken && cm.state.doc.toString() === original && at(cm) === '1,1', { cut, paste });
		quiet = await keys(cm, seed, ['ArrowRight', { shiftKey: true }]);
		app.commands.executeCommandById('editor:swap-line-up');
		await settle();
		app.commands.executeCommandById('editor:swap-line-down');
		await settle();
		check('24 Shift+→ and moving the line change nothing, and the cell stays selected', quiet && cm.state.doc.toString() === original && at(cm) === '1,1', at(cm));
		const copy = clipboard(cm, 'copy');
		check('26 Copy gives the cell\'s Markdown, with a plain pipe', copy.taken && copy.text === '[[Watering schedule|Fern]]', copy);
		await press(cm, 'Escape');
		const whole = clipboard(cm, 'copy');
		check('F Copy on the whole table is still CodeMirror\'s', !whole.text || whole.text.startsWith('| Tray'), whole);
		await press(cm, 'Escape');
		const below = cm.state.doc.line(seed.last + 2);
		cm.dispatch({ changes: { from: below.to, insert: 'y' }, selection: { anchor: below.to + 1 }, userEvent: 'input.type' });
		// Past CodeMirror's half-second grouping, so undo takes back only the y.
		await sleep(700);
		await selectTable(cm, seed);
		await press(cm, 'Enter');
		await keys(cm, seed, 'ArrowDown', 'ArrowRight', 'ArrowDown');
		const undoMac = navigator.platform.startsWith('Mac');
		await press(cm, 'z', { metaKey: undoMac, ctrlKey: !undoMac, code: 'KeyZ' });
		check('25 moving between cells adds no undo step: undo takes back the last edit', cm.state.doc.toString() === original, cm.state.doc.line(seed.last + 2).text);
		await restore(cm, original);

		// --- Cells D. Leaving
		seed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, seed);
		await press(cm, 'Enter');
		await caretOnLine(cm, seed.last + 2);
		check('27 moving the selection elsewhere drops the cell', marked(cm).length === 0 && sel(cm).line === seed.last + 2, at(cm));
		await selectTable(cm, seed);
		await press(cm, 'Enter');
		await press(cm, 'Escape');
		await press(cm, 'ArrowDown', command);
		check('28 Cmd+↓ on the selected table goes to the note\'s end, and no cell stays marked', marked(cm).length === 0 && sel(cm).head === cm.state.doc.length, at(cm));
		seed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, seed);
		await press(cm, 'Enter');
		const leaf = app.workspace.getMostRecentLeaf().view;
		await leaf.setState({ ...leaf.getState(), mode: 'source', source: true }, { history: false });
		await sleep(400);
		const inSource = marked(leaf.editor.cm).length;
		await leaf.setState({ ...leaf.getState(), mode: 'source', source: false }, { history: false });
		await sleep(400);
		cm = leaf.editor.cm;
		check('29 Source mode and back leave no cell marked', inSource === 0 && marked(cm).length === 0, inSource);
		seed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, seed);
		await press(cm, 'Enter');
		cm = await open('Two report tables');
		const elsewhere = marked(cm).length;
		cm = await open('Cell moves');
		check('30 another note and back leave no cell marked', elsewhere === 0 && marked(cm).length === 0, elsewhere);
		const synced = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, synced);
		await press(cm, 'Enter');
		await keys(cm, synced, 'ArrowDown', 'ArrowRight');
		// A reload from disk, which is how Sync arrives, carries the set event.
		const basil = cm.state.doc.line(synced.first + 3);
		const letter = basil.from + basil.text.indexOf('Basil');
		cm.dispatch({ changes: { from: letter, to: letter + 1, insert: 'M' }, userEvent: 'set' });
		await sleep(300);
		const edited = cm.state.doc.toString() !== original;
		const during = at(cm);
		cm.dispatch({ changes: { from: letter, to: letter + 1, insert: 'B' }, userEvent: 'set' });
		await sleep(300);
		check('Sync: a reload from disk passes, and the cell stays marked', edited && during === '1,1' && at(cm) === '1,1' && cm.state.doc.toString() === original, { edited, during, after: at(cm) });

		// A second pane on the same note edits through its own editor.
		const otherLeaf = app.workspace.getLeaf('split');
		await otherLeaf.openFile(app.vault.getAbstractFileByPath('Cell moves.md'), { state: { mode: 'source', source: true } });
		await sleep(500);
		const other = otherLeaf.view.editor;
		const inOther = other.posToOffset({ line: synced.first + 2, ch: 0 });
		const otherLine = other.getLine(synced.first + 2);
		other.replaceRange('M', other.offsetToPos(inOther + otherLine.indexOf('Basil')), other.offsetToPos(inOther + otherLine.indexOf('Basil') + 1));
		await sleep(400);
		const reached = cm.state.doc.toString() === other.getValue() && cm.state.doc.toString() !== original;
		other.replaceRange('B', other.offsetToPos(inOther + otherLine.indexOf('Basil')), other.offsetToPos(inOther + otherLine.indexOf('Basil') + 1));
		await sleep(400);
		otherLeaf.detach();
		await sleep(300);
		cm.focus();
		await settle();
		check('a second pane\'s edit reaches this note, and the cell stays marked', reached && at(cm) === '1,1' && cm.state.doc.toString() === original, { reached, at: at(cm) });

		// Obsidian's commands edit with no user event. Each of these acts on the whole selection.
		const commands = ['set-heading-1', 'toggle-blockquote', 'toggle-comments', 'clear-formatting', 'toggle-bullet-list', 'toggle-checklist-status', 'cycle-list-checklist', 'insert-callout', 'insert-codeblock', 'insert-horizontal-rule', 'insert-mathblock', 'insert-table', 'insert-footnote'];
		const changedBy = [];
		for (const command of commands) {
			const start = await tableUnder(cm, 'Seed trays');
			await selectTable(cm, start);
			await press(cm, 'Enter');
			app.commands.executeCommandById(`editor:${command}`);
			await settle();
			if (cm.state.doc.toString() !== original) changedBy.push(command);
			await restore(cm, original);
		}
		check('Obsidian\'s editor commands leave the table alone while a cell is selected', changedBy.length === 0, changedBy);

		// The + button below a table, and the mouse in general, go through Obsidian's table editor.
		const pressed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, pressed);
		await press(cm, 'Enter');
		const addRow = pressed.el.querySelector('.table-row-btn');
		addRow.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, isPrimary: true }));
		const unmarked = marked(cm).length === 0;
		addRow.click();
		await sleep(300);
		const lines = cm.state.doc.lines;
		const added = lines === original.split('\n').length + 1;
		const drawn = pressed.el.querySelector('table').rows.length;
		await restore(cm, original);
		await sleep(300);
		check('a press drops the cell, and the + button adds a row to the note and the drawn table alike', unmarked && added && drawn === 6, { unmarked, lines, drawn });
		const resumed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, resumed);
		await press(cm, 'Escape');
		await press(cm, 'Escape');

		// --- Cells E. Odd tables
		const uneven = await tableUnder(cm, 'Uneven rows');
		const unevenRows = uneven.el.querySelector('table').rows;
		check('relies 4: a short row is filled, so every row has the same number of cells', Array.from(unevenRows).every((r) => r.cells.length === 4), Array.from(unevenRows).map((r) => r.cells.length));
		await selectTable(cm, uneven);
		await press(cm, 'Enter');
		await keys(cm, uneven, ...repeat('ArrowDown', 2), ...repeat('ArrowRight', 2));
		const filler = at(cm);
		quiet = await keys(cm, uneven, 'Enter');
		const refused = () => marked(cm)[0]?.classList.contains('selectable-tables-refused');
		const redFrame = refused() && getComputedStyle(marked(cm)[0], '::after').borderTopColor;
		check('31 Enter on a table Obsidian didn\'t write opens nothing, changes nothing, and frames the cell in red', filler === '2,2' && quiet && refused() && redFrame !== getComputedStyle(cm.dom.querySelector('.cm-content')).color, { filler, quiet, redFrame });
		await keys(cm, uneven, 'ArrowUp');
		check('31 the red goes when the selection moves on', at(cm) === '1,2' && !refused(), at(cm));
		await click(uneven.el.querySelector('table').rows[2].cells[2]);
		const tidied = cm.state.doc.toString() !== original;
		check('31 a click tidies the table and opens that cell, as it always has', tidied && openAt(cm) === '2,2', { tidied, open: openAt(cm) });
		cellView(cm).dispatch(cellView(cm).state.replaceSelection('x'), { userEvent: 'input.type' });
		await settle();
		await press(cellEditor(cm), 'Escape');
		await sleep(300);
		check('31 what\'s typed there reaches the note', at(cm) === '2,2' && /\| Mid +\| 5 +\| x +\|/.test(cm.state.doc.toString()), cm.state.doc.toString().split('\n').find((l) => l.startsWith('| Mid')));
		await keys(cm, uneven, 'ArrowUp');
		await press(cm, 'Enter');
		await sleep(300);
		check('32 once tidied, Enter opens cells again', openAt(cm) === '1,2', openAt(cm));
		await press(cellEditor(cm), 'Escape');
		await sleep(250);
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		await restore(cm, original);

		// A cell that ends in a space and sets its column's width: closing it trims Obsidian's copy only.
		const trimmed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, trimmed);
		await press(cm, 'Enter');
		await keys(cm, trimmed, 'ArrowDown', 'ArrowRight', 'ArrowRight');
		await press(cm, 'Enter');
		await sleep(300);
		cellView(cm).dispatch(cellView(cm).state.replaceSelection(' and shady '), { userEvent: 'input.type' });
		await settle();
		await press(cellEditor(cm), 'Escape');
		await sleep(300);
		const beforeRefusal = cm.state.doc.toString();
		quiet = await keys(cm, trimmed, 'Enter');
		check('a cell left ending in a space: Enter refuses rather than type in the wrong place', quiet && refused() && cm.state.doc.toString() === beforeRefusal, { quiet, open: openAt(cm) });
		await click(trimmed.el.querySelector('table').rows[1].cells[2]);
		cellView(cm).dispatch(cellView(cm).state.replaceSelection('x'), { userEvent: 'input.type' });
		await settle();
		await press(cellEditor(cm), 'Escape');
		await sleep(300);
		const keptRow = cm.state.doc.toString().split('\n').find((l) => l.includes('Keep damp'));
		// The caret sits where the press landed, mid-cell, so the x lands inside the text.
		check('after a click, what\'s typed stays in that cell, and the row keeps its pipes', (keptRow.match(/(?<!\\)\|/g) ?? []).length === 4 && keptRow.replace('x', '').includes('**Keep damp** and shady'), keptRow);
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		await restore(cm, original);

		// Obsidian ignores the delimiter's dash count, so a click wouldn't change this table: it must open.
		const shortDelimiter = await tableUnder(cm, 'Short delimiter');
		await selectTable(cm, shortDelimiter);
		await press(cm, 'Enter');
		await press(cm, 'Enter');
		await sleep(300);
		check('a table with a short delimiter opens from the keyboard', openAt(cm) === '0,0', openAt(cm));
		await press(cellEditor(cm), 'Escape');
		await sleep(250);
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		await restore(cm, original);

		// Undo can put the selection back on a table other than the one holding the cell.
		const firstTable = await tableUnder(cm, 'Seed trays');
		const secondTable = await tableUnder(cm, 'Uneven rows');
		cm.focus();
		cm.dispatch({ selection: { anchor: secondTable.from, head: secondTable.to } });
		await sleep(700);
		await press(cm, 'Delete');
		await sleep(250);
		const held = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, held);
		await press(cm, 'Enter');
		await press(cm, 'z', { metaKey: navigator.platform.startsWith('Mac'), ctrlKey: !navigator.platform.startsWith('Mac'), code: 'KeyZ' });
		await sleep(300);
		check('undo that selects another table leaves no cell marked', firstTable && marked(cm).length === 0 && cm.state.doc.toString() === original, at(cm));
		await restore(cm, original);

		// An input method's keydown has key code 229, and the caret steps beside the table on it.
		const composed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, composed);
		await press(cm, 'Enter');
		await press(cm, 'Process', { keyCode: 229 });
		check('an input method\'s key on a selected cell moves the caret beside the table', marked(cm).length === 0 && sel(cm).anchor === sel(cm).head && sel(cm).line === composed.first - 1 && cm.state.doc.toString() === original, sel(cm));

		// A held Enter stops at the selected cell, and a drag over the table drops it.
		const heldTable = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, heldTable);
		await press(cm, 'Enter', { repeat: true });
		const repeatedOnTable = marked(cm).length;
		await press(cm, 'Enter');
		await press(cm, 'Enter', { repeat: true });
		await press(cm, 'Enter', { repeat: true });
		check('a held Enter opens nothing', repeatedOnTable === 0 && at(cm) === '0,0' && !openCell(cm), at(cm));
		heldTable.el.querySelector('td').dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true }));
		await sleep(200);
		check('a drag over the table drops the selected cell', marked(cm).length === 0, at(cm));
		await caretOnLine(cm, heldTable.first - 1);
		await restore(cm, original);

		const wide = await tableUnder(cm, 'Wide table');
		await selectTable(cm, wide);
		await press(cm, 'Enter');
		await keys(cm, wide, ...repeat('ArrowRight', 15));
		await sleep(200);
		const shown = (scroller) => {
			const cell = marked(cm)[0].getBoundingClientRect();
			const view = scroller.getBoundingClientRect();
			return cell.left >= view.left - 1 && cell.right <= view.right + 1 && cell.top >= view.top - 1 && cell.bottom <= view.bottom + 1;
		};
		check('33 holding → scrolls the wide table sideways to its last column', at(cm) === '0,15' && wide.el.scrollLeft > 0 && shown(wide.el), { at: at(cm), scrollLeft: wide.el.scrollLeft });
		await keys(cm, wide, ...repeat('ArrowLeft', 15));
		await sleep(200);
		check('33 holding ← scrolls it back', at(cm) === '0,0' && shown(wide.el), wide.el.scrollLeft);
		await press(cm, 'Escape');
		await press(cm, 'Escape');

		const tall = await tableUnder(cm, 'Tall table');
		await selectTable(cm, tall);
		await press(cm, 'Enter');
		await keys(cm, tall, ...repeat('ArrowDown', 42));
		await sleep(200);
		check('34 holding ↓ scrolls the note and stops on the last row, the cell in view', at(cm) === '40,0' && shown(cm.scrollDOM), { at: at(cm), top: cm.scrollDOM.scrollTop });
		await keys(cm, tall, ...repeat('ArrowUp', 42));
		await sleep(200);
		check('34 holding ↑ goes back to the first row, the cell in view', at(cm) === '0,0' && shown(cm.scrollDOM), at(cm));
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		check('Cells: the note is as it was', cm.state.doc.toString() === original);

		// --- What the check on key moves relies on
		cm = await open('Two report tables');
		original = cm.state.doc.toString();
		[t1, t2] = tables(cm);
		await caretOnLine(cm, 3);
		const wordEvents = await eventsDuring(cm, () => real('ArrowRight', option));
		const lineEvents = await eventsDuring(cm, () => real('ArrowDown', option));
		check('relies 9a: a word jump and Option+↓ send select', wordEvents.join() === 'select' && lineEvents.join() === 'select', { wordEvents, lineEvents });
		const textLine = cm.contentDOM.querySelectorAll('.cm-line')[1];
		const clickEvents = await eventsDuring(cm, () => realClick(textLine));
		check('relies 9b: a click sends select.pointer', clickEvents.includes('select.pointer') && !clickEvents.includes('select'), clickEvents);
		const leftOpen = t1.el.querySelector('table').rows[2].cells[0];
		await realClick(leftOpen);
		check('a real click on a cell still opens it', openAt(cm) === '2,0' && cm.state.doc.toString() === original, openAt(cm));
		const betweenCells = await eventsDuring(cm, () => press(cellEditor(cm), 'Tab'));
		await sleep(200);
		check('relies 9c: Obsidian\'s own moves between cells send no user event', openAt(cm) === '2,1' && !betweenCells.some((e) => e.startsWith('select')), { open: openAt(cm), betweenCells });
		await closeCell(cm, t1.from - 1);
		await restore(cm, original);

		// --- Jumps A. Word jumps next to a table
		[t1, t2] = tables(cm);
		await caretOnLine(cm, 3, 100);
		await real('ArrowRight', option);
		check('J1 Option+→ at the end of the line above selects the table, and opens no cell', selectsWhole(cm, t1) && sel(cm).head === t1.to && !openCell(cm) && tint(t1), sel(cm));
		await real('ArrowRight', option);
		check('J2 Option+→ again: the caret on the line below', sel(cm).line === t1.last + 1 && sel(cm).anchor === sel(cm).head && !openCell(cm), sel(cm));
		await caretOnLine(cm, t1.last + 2);
		await real('ArrowLeft', option);
		check('J3 Option+← at the start of the line below selects the table', selectsWhole(cm, t1) && sel(cm).head === t1.from && !openCell(cm), sel(cm));
		await real('ArrowLeft', option);
		check('J4 Option+← again: the caret on the line above', sel(cm).line === t1.first - 1 && sel(cm).anchor === sel(cm).head && !openCell(cm), sel(cm));
		await caretOnLine(cm, 3, 100);
		await real('ArrowRight', option);
		await press(cm, 'Escape');
		check('J5 Escape goes back to the side the word jump came from', sel(cm).line === t1.first - 1 && sel(cm).anchor === sel(cm).head, sel(cm));
		const sizes = `${box(t1.el)} ${box(t2.el)}`;
		// Walks the note with one key: nothing may open, and each table takes exactly one press.
		async function walk(key, mods, done) {
			const walked = { stops: [], onFirst: 0, onSecond: 0, opened: false };
			for (let i = 0; i < 300 && !done(); i++) {
				await real(key, mods, () => sleep(60));
				walked.stops.push(sel(cm).line);
				walked.opened = walked.opened || !!openCell(cm);
				if (selectsWhole(cm, t1)) walked.onFirst++;
				if (selectsWhole(cm, t2)) walked.onSecond++;
			}
			return walked;
		}
		const atEnd = () => sel(cm).head === cm.state.doc.length && sel(cm).anchor === sel(cm).head;
		const atStart = () => sel(cm).head === 0 && sel(cm).anchor === 0;
		await caretOnLine(cm, 1);
		const forward = await walk('ArrowRight', option, atEnd);
		check('J6 holding Option+→: one press on each table, nothing opens, nothing changes size', forward.onFirst === 1 && forward.onSecond === 1 && !forward.opened && atEnd() && `${box(t1.el)} ${box(t2.el)}` === sizes, forward);
		const backward = await walk('ArrowLeft', option, atStart);
		check('J6 holding Option+←: the same, going back', backward.onFirst === 1 && backward.onSecond === 1 && !backward.opened && atStart(), backward);
		const down = await walk('ArrowDown', option, atEnd);
		const up = await walk('ArrowUp', option, atStart);
		results.push({ name: 'J7 Option+↓ and Option+↑, real keys: no cell opens, each table takes one press', ok: !down.opened && !up.opened && down.onFirst === 1 && down.onSecond === 1 && up.onFirst === 1 && up.onSecond === 1, stops: { down: down.stops, up: up.stops } });
		check('Jumps A: the note is as it was', cm.state.doc.toString() === original);

		// --- Jumps B. Page keys and big jumps in the note
		// A note that has just opened, held at key-repeat speed: this outruns Obsidian's parser, so the
		// keys land on tables that are still text.
		await open('Two report tables');
		cm = await open('Long note');
		original = cm.state.doc.toString();
		await caretOnLine(cm, 1);
		const passedDown = { selected: 0, opened: false };
		for (let i = 0; i < 400 && sel(cm).head !== cm.state.doc.length; i++) {
			await real('PageDown', {}, () => sleep(30));
			passedDown.selected += sel(cm).anchor === sel(cm).head ? 0 : 1;
			passedDown.opened = passedDown.opened || !!openCell(cm);
		}
		check('J8 holding Page Down through a long note selects no table and opens no cell', sel(cm).head === cm.state.doc.length && !passedDown.selected && !passedDown.opened, { passedDown, ...sel(cm) });
		for (let i = 0; i < 400 && sel(cm).head !== 0; i++) {
			await real('PageUp', {}, () => sleep(30));
			passedDown.selected += sel(cm).anchor === sel(cm).head ? 0 : 1;
			passedDown.opened = passedDown.opened || !!openCell(cm);
		}
		check('J8 holding Page Up back does the same', sel(cm).head === 0 && !passedDown.selected && !passedDown.opened, { passedDown, ...sel(cm) });

		// Held at key-repeat speed, Option+↓ steps a line at a time, so it stays where tables are drawn.
		await caretOnLine(cm, 1);
		let heldOpened = false;
		for (let i = 0; i < 200; i++) {
			await real('ArrowDown', option, () => sleep(30));
			heldOpened = heldOpened || !!openCell(cm);
		}
		check('J8 holding Option+↓ in a long note opens no cell', !heldOpened, sel(cm));
		await restore(cm, original);

		cm = await open('Cell moves');
		original = cm.state.doc.toString();
		seed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, seed);
		await real('PageDown');
		check('J9 Page Down on a selected table: the caret on the line below', sel(cm).line === seed.last + 1 && sel(cm).anchor === sel(cm).head && !openCell(cm), sel(cm));
		await press(cm, 'ArrowLeft');
		await real('PageUp');
		check('J10 Page Up on a selected table: the caret on the line above', sel(cm).line === seed.first - 1 && sel(cm).anchor === sel(cm).head && !openCell(cm), sel(cm));
		await press(cm, 'ArrowRight');
		await real('ArrowDown', option);
		const optionBelow = sel(cm).line;
		await press(cm, 'ArrowLeft');
		await real('ArrowUp', option);
		check('J11 Option+↓ and Option+↑ leave a selected table the same way', optionBelow === seed.last + 1 && sel(cm).line === seed.first - 1 && !openCell(cm), { optionBelow, ...sel(cm) });
		await press(cm, 'ArrowRight');
		const kept = sel(cm);
		for (const [key, mods] of [['Home'], ['End'], ['ArrowLeft', command], ['ArrowRight', command]]) await real(key, mods);
		check('J12 Home, End, Cmd+← and Cmd+→ do nothing on a selected table', sel(cm).anchor === kept.anchor && sel(cm).head === kept.head && !openCell(cm), sel(cm));
		await real('ArrowDown', command);
		const noteEnd = sel(cm).head;
		await real('ArrowUp', command);
		check('J13 Cmd+↓ and Cmd+↑ go to the note\'s end and start from a selected table', noteEnd === cm.state.doc.length && sel(cm).head === 0 && !openCell(cm), { noteEnd, ...sel(cm) });
		check('Jumps B: the note is as it was', cm.state.doc.toString() === original);

		cm = await open('Table last');
		original = cm.state.doc.toString();
		const [ending] = tables(cm);
		await caretOnLine(cm, 1);
		await real('ArrowDown', command);
		check('J14 Cmd+↓ into a table that ends the note selects it, and opens no cell', selectsWhole(cm, ending) && !openCell(cm), sel(cm));
		for (const [key, mods] of [['ArrowDown', command], ['PageDown'], ['ArrowRight', option], ['End']]) await real(key, mods);
		check('J14 with no line beyond it, the keys keep it selected', selectsWhole(cm, ending) && !openCell(cm) && cm.state.doc.toString() === original, sel(cm));
		await caretOnLine(cm, 1);
		await real('PageDown');
		check('J14 Page Down into a table that ends the note selects it', selectsWhole(cm, ending) && !openCell(cm), sel(cm));
		await press(cm, 'Escape');

		// --- Jumps C. A selected cell
		cm = await open('Cell moves');
		original = cm.state.doc.toString();
		seed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, seed);
		await press(cm, 'Enter');
		await keys(cm, seed, 'ArrowDown', 'ArrowRight');
		const visit = async (t, ...pressed) => {
			const places = [];
			let quietly = true;
			for (const p of pressed) {
				quietly = (await keys(cm, t, p)) && quietly;
				places.push(at(cm));
			}
			return quietly ? places.join(' ') : `not quiet: ${places.join(' ')}`;
		};
		let places = await visit(seed, 'End', 'Home', ['ArrowRight', command], ['ArrowLeft', command]);
		check('J16 End, Home, Cmd+→ and Cmd+← go to the row\'s ends, nothing opening', places === '1,2 1,0 1,2 1,0', places);
		await keys(cm, seed, 'ArrowRight');
		places = await visit(seed, 'PageDown', 'PageUp', ['ArrowDown', command], ['ArrowUp', command], ['End', { metaKey: true }], ['Home', { metaKey: true }], ['ArrowDown', { ctrlKey: true }], ['ArrowUp', { ctrlKey: true }]);
		check('J17 Page keys, Cmd+↑/↓, Cmd+Home/End and Ctrl+↑/↓ go to the column\'s ends, nothing opening', places === '4,1 0,1 4,1 0,1 4,1 0,1 4,1 0,1', places);
		places = await visit(seed, ['ArrowUp', command], 'PageUp');
		check('J18 already at the top, they stay there, and the table stays selected', places === '0,1 0,1' && selectsWhole(cm, seed), places);
		for (const key of ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) await real(key, option);
		check('J19 Option with an arrow does nothing, with real keys', at(cm) === '0,1' && selectsWhole(cm, seed) && !openCell(cm), at(cm));
		places = await visit(seed, ['End', { shiftKey: true }], ['PageDown', { shiftKey: true }], ['ArrowDown', { shiftKey: true, metaKey: true }], ['ArrowRight', { shiftKey: true, altKey: true }]);
		check('J20 Shift with any of these does nothing', places === '0,1 0,1 0,1 0,1' && selectsWhole(cm, seed), places);
		await keys(cm, seed, ['ArrowDown', command], 'Escape', 'Enter');
		const remembered = at(cm);
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		check('J21 a cell reached by a jump is remembered like any other', remembered === '4,1' && sel(cm).line === seed.first - 1 && sel(cm).anchor === sel(cm).head, { remembered, ...sel(cm) });

		const unevenRows2 = await tableUnder(cm, 'Uneven rows');
		await selectTable(cm, unevenRows2);
		await press(cm, 'Enter');
		await keys(cm, unevenRows2, ...repeat('ArrowDown', 2));
		places = await visit(unevenRows2, 'End', 'ArrowDown', 'PageDown', 'PageUp');
		check('J22 on uneven rows, End goes to the filled cell at the table\'s edge, and the column goes on from there', places === '2,3 3,3 4,3 0,3', places);
		await press(cm, 'Escape');
		await press(cm, 'Escape');

		const wideTable = await tableUnder(cm, 'Wide table');
		await selectTable(cm, wideTable);
		await press(cm, 'Enter');
		await press(cm, 'End');
		await sleep(200);
		const lastColumn = at(cm);
		const wideShown = wideTable.el.scrollLeft > 0;
		await press(cm, 'Home');
		await sleep(200);
		check('J23 End and Home scroll a wide table sideways to the cell', lastColumn === '0,15' && wideShown && at(cm) === '0,0' && wideTable.el.scrollLeft < 2, { lastColumn, wideShown, left: wideTable.el.scrollLeft });
		await press(cm, 'Escape');
		await press(cm, 'Escape');

		const tallTable = await tableUnder(cm, 'Tall table');
		await selectTable(cm, tallTable);
		await press(cm, 'Enter');
		await keys(cm, tallTable, 'ArrowRight');
		const inView = () => {
			const cell = marked(cm)[0].getBoundingClientRect();
			const view = cm.scrollDOM.getBoundingClientRect();
			return cell.top >= view.top - 1 && cell.bottom <= view.bottom + 1;
		};
		await press(cm, 'PageDown');
		await sleep(200);
		const bottomShown = at(cm) === '40,1' && inView();
		await press(cm, 'PageUp');
		await sleep(200);
		check('J24 Page Down and Page Up scroll a tall table to the cell', bottomShown && at(cm) === '0,1' && inView(), { at: at(cm), bottomShown });
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		check('Jumps C: the note is as it was', cm.state.doc.toString() === original);

		// --- Jumps D. An open cell
		seed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, seed);
		await press(cm, 'Enter');
		await keys(cm, seed, 'ArrowDown', 'ArrowRight', 'Enter');
		await sleep(250);
		const fernOpen = openAt(cm);
		const scrolled = cm.scrollDOM.scrollTop;
		await press(cellEditor(cm), 'PageDown');
		await sleep(250);
		check('J25 Page Down in a cell closes it and selects the column\'s bottom cell, and the note stays put', fernOpen === '1,1' && !openCell(cm) && at(cm) === '4,1' && selectsWhole(cm, seed) && cm.hasFocus && cm.scrollDOM.scrollTop === scrolled, { fernOpen, at: at(cm), ...sel(cm) });
		await press(cm, 'Enter');
		await sleep(250);
		await press(cellEditor(cm), 'ArrowUp', command);
		await sleep(250);
		check('J26 Cmd+↑ in a cell closes it and selects the column\'s top cell', !openCell(cm) && at(cm) === '0,1', at(cm));
		await press(cm, 'Enter');
		await sleep(250);
		await press(cellEditor(cm), 'ArrowDown', { ctrlKey: true });
		await sleep(250);
		const byControl = at(cm);
		await press(cm, 'Enter');
		await sleep(250);
		await press(cellEditor(cm), 'Home', command);
		await sleep(250);
		check('J26 Ctrl+↓ and Cmd+Home in a cell do the same', byControl === '4,1' && at(cm) === '0,1' && !openCell(cm), { byControl, at: at(cm) });
		await keys(cm, seed, ...repeat('ArrowDown', 4), 'ArrowRight');
		await press(cm, 'Enter');
		await sleep(250);
		cellView(cm).dispatch(cellView(cm).state.replaceSelection('x'), { userEvent: 'input.type' });
		await settle();
		await press(cellEditor(cm), 'ArrowUp', command);
		await sleep(300);
		check('J27 a jump keeps what was typed in the cell it left', at(cm) === '0,2' && !openCell(cm) && cm.state.doc.toString().includes('Water twicex'), at(cm));
		await restore(cm, original);
		seed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, seed);
		await press(cm, 'Enter');
		await keys(cm, seed, 'ArrowDown', 'ArrowRight', 'Enter');
		await sleep(250);
		inner = cellView(cm);
		const textCaret = [];
		for (const [key, mods] of [['Home'], ['End'], ['ArrowLeft', command], ['ArrowRight', command], ['ArrowLeft', option], ['ArrowRight', option]]) {
			await press(cellEditor(cm), key, mods);
			textCaret.push(openCell(cm) ? inner.state.selection.main.head : 'closed');
		}
		check('J28 Home, End, Cmd+←/→ and Option+←/→ move through the open cell\'s text', !textCaret.includes('closed') && openAt(cm) === '1,1' && new Set(textCaret).size > 1, textCaret);
		await press(cellEditor(cm), 'Escape');
		await sleep(250);
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		seed = await tableUnder(cm, 'Seed trays');
		await realClick(seed.el.querySelector('table').rows[1].cells[2]);
		const clicked = openAt(cm);
		await press(cellEditor(cm), 'ArrowDown', command);
		await sleep(250);
		check('J30 a cell opened with a click: Cmd+↓ selects the column\'s bottom cell', clicked === '1,2' && at(cm) === '4,2' && !openCell(cm), { clicked, at: at(cm) });
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		await restore(cm, original);

		// --- Jumps E. What stays as it was
		cm = await open('Two report tables');
		original = cm.state.doc.toString();
		const pastedTable = '| Tool  | Shed |\n| ----- | ---- |\n| Rake  | Back |';
		const noteLength = cm.state.doc.length;
		cm.dispatch({ changes: { from: noteLength, insert: pastedTable }, selection: { anchor: noteLength + pastedTable.length }, userEvent: 'input.paste' });
		await sleep(400);
		await real('ArrowLeft', option);
		await sleep(250);
		s = sel(cm);
		check('J35 Option+← right after pasting a table selects it, and opens no cell', !openCell(cm) && s.anchor === noteLength + pastedTable.length && s.head === noteLength, s);
		await restore(cm, original);
		[t1] = tables(cm);
		await selectTable(cm, t1);
		await press(cm, 'Enter');
		await press(cm, 'a', { metaKey: navigator.platform.startsWith('Mac'), ctrlKey: !navigator.platform.startsWith('Mac'), code: 'KeyA' });
		await settle();
		check('J36 Select all from a selected cell selects the note, and takes the cell off', sel(cm).head === cm.state.doc.length && sel(cm).anchor === 0 && marked(cm).length === 0, sel(cm));
		await caretOnLine(cm, 1);
		const leafView = app.workspace.getMostRecentLeaf().view;
		leafView.editor.setCursor({ line: t1.first + 1, ch: 3 });
		await sleep(300);
		check('J38 a caret set with no user event, as the Search pane and other plugins do, still opens a cell', openCell(cm), sel(cm));
		await closeCell(cm, t1.from - 1);
		await restore(cm, original);
		await leafView.setState({ ...leafView.getState(), mode: 'source', source: true }, { history: false });
		await sleep(400);
		cm = leafView.editor.cm;
		await caretOnLine(cm, 3, 100);
		await real('ArrowRight', option);
		check('J39 Source mode: Option+→ moves through the table\'s text', sel(cm).anchor === sel(cm).head && sel(cm).line === 5, sel(cm));
		await leafView.setState({ ...leafView.getState(), mode: 'source', source: false }, { history: false });
		await sleep(400);

		// --- Vim: its motions stay its own while it's driving, so the check stands aside. Turning it on
		// writes the vault's tracked app.json, so that goes back exactly as it was, whatever happens here.
		const fs = window.require('fs');
		const appConfig = window.require('path').join(app.vault.adapter.basePath, '.obsidian', 'app.json');
		const savedConfig = fs.readFileSync(appConfig, 'utf8');
		cm = await open('Two report tables');
		original = cm.state.doc.toString();
		try {
			app.vault.setConfig('vimMode', true);
			await sleep(800);
			cm = await open('Two report tables');
			check('relies 10: Vim puts cm-vimMode on the scroller outside insert mode', cm.scrollDOM.classList.contains('cm-vimMode'), cm.scrollDOM.className);
			[t1] = tables(cm);
			await caretOnLine(cm, t1.first - 1);
			await press(cm, 'w');
			await sleep(300);
			const vimState = cm.cm?.state?.vim;
			check('in Vim\'s normal mode, w is Vim\'s: it enters the table, and starts no Visual mode', sel(cm).anchor === sel(cm).head && sel(cm).head >= t1.from && !vimState?.visualMode, { ...sel(cm), visual: vimState?.visualMode });
			await closeCell(cm, t1.from - 1);
			await press(cm, 'i');
			await settle();
			const insertClass = cm.scrollDOM.classList.contains('cm-vimMode');
			await caretOnLine(cm, 3, 100);
			await real('ArrowRight', option);
			const insertSelected = selectsWhole(cm, t1) && !openCell(cm);
			await press(cm, 'Escape');
			check('in Vim\'s insert mode, the class is off and a word jump selects the table', !insertClass && insertSelected && cm.state.doc.toString() === original, { insertClass, insertSelected });
		} finally {
			app.vault.setConfig('vimMode', undefined);
			await sleep(2500);
			fs.writeFileSync(appConfig, savedConfig);
		}

		// --- Open cells keep their width
		const columns = (t) => Array.from(t.el.querySelector('table').rows[0].cells, (c) => Math.round(c.getBoundingClientRect().width * 10) / 10).join(', ');
		cm = await open('Markdown in cells');
		original = cm.state.doc.toString();
		const plants = await tableUnder(cm, 'Plants');
		const closedWidths = columns(plants);
		await selectTable(cm, plants);
		await press(cm, 'Enter');
		await keys(cm, plants, 'ArrowDown');
		await press(cm, 'Enter');
		await sleep(300);
		const openFern = cm.contentDOM.querySelector('.cm-table-widget.has-focus .cm-editor').closest('td, th');
		const renderedCopy = Array.from(openFern.querySelectorAll('.table-cell-wrapper')).find((w) => !w.querySelector('.cm-editor'));
		check('relies 8: an open cell keeps its rendered text in a hidden wrapper, beside the one holding its editor', renderedCopy && renderedCopy.style.display === 'none', openFern.innerHTML.slice(0, 200));
		check('opening a cell with a link moves no column', columns(plants) === closedWidths, { closedWidths, open: columns(plants) });
		await press(cellEditor(cm), 'Tab');
		await sleep(300);
		check('moving to another open cell moves no column', columns(plants) === closedWidths, { closedWidths, moved: columns(plants) });
		cellView(cm).dispatch(cellView(cm).state.replaceSelection(' and a good deal more text than the cell had'), { userEvent: 'input.type' });
		await settle();
		check('typing in an open cell moves no column', columns(plants) === closedWidths, { closedWidths, typing: columns(plants) });
		await press(cellEditor(cm), 'Escape');
		await sleep(300);
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		await restore(cm, original);
		cm = await open('Cell moves');
		original = cm.state.doc.toString();
		const empties = await tableUnder(cm, 'Seed trays');
		const emptyClosed = columns(empties);
		await selectTable(cm, empties);
		await press(cm, 'Enter');
		await keys(cm, empties, ...repeat('ArrowDown', 2), ...repeat('ArrowRight', 2));
		await press(cm, 'Enter');
		await sleep(300);
		cellView(cm).dispatch(cellView(cm).state.replaceSelection('a sentence typed into an empty cell, which is wider than the column was'), { userEvent: 'input.type' });
		await settle();
		const emptyTyping = columns(empties);
		await press(cellEditor(cm), 'Escape');
		await sleep(300);
		check('an empty cell still grows as you type, as it always has', emptyTyping !== emptyClosed, { emptyClosed, emptyTyping });
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		await restore(cm, original);

		// --- D. Typing, Tab, delete
		cm = await open('Two report tables');
		original = cm.state.doc.toString();
		[t1] = tables(cm);
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

		// --- Paste and Delete next to a table
		await restore(cm, original);
		const pasted = '| Tool  | Shed |\n| ----- | ---- |\n| Rake  | Back |';
		const end = cm.state.doc.length;
		cm.dispatch({ changes: { from: end, insert: pasted }, selection: { anchor: end + pasted.length }, userEvent: 'input.paste' });
		await sleep(400);
		await press(cm, 'ArrowLeft');
		await sleep(250);
		s = sel(cm);
		check('40 ← right after pasting a table selects it, and opens no cell', !openCell(cm) && s.anchor === end + pasted.length && s.head === end, s);
		await restore(cm, original);
		[t1] = tables(cm);
		await caretOnLine(cm, t1.first - 1);
		await press(cm, 'Delete');
		s = sel(cm);
		check('Delete on the line above a table selects it, and removes nothing', !openCell(cm) && s.anchor === t1.from && s.head === t1.to && cm.state.doc.toString() === original, s);
		await caretOnLine(cm, t1.first - 1);

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
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		check('E35 Table first: Enter, then Escape twice, ends on the line below, with no line added', sel(cm).line === t.last + 1 && cm.state.doc.toString() === original, sel(cm));
		await press(cm, 'ArrowLeft');
		await press(cm, 'Enter');
		await press(cm, 'Enter');
		await sleep(200);
		check('G22 Enter twice on the first table of a note opens its first cell', openAt(cm) === '0,0' && cm.state.doc.toString() === original, sel(cm));
		await closeCell(cm, cm.state.doc.line(t.last + 1).from);

		cm = await open('Table last');
		original = cm.state.doc.toString();
		[t] = tables(cm);
		await caretOnLine(cm, t.first - 1);
		await press(cm, 'ArrowDown');
		await sleep(200);
		check('G23 Table last: ↓ from above is left to Obsidian, which enters the table', openCell(cm) && cm.state.doc.toString() === original, sel(cm));
		await closeCell(cm, cm.state.doc.line(t.first - 1).from);
		await restore(cm, original);
		[t] = tables(cm);
		await selectTable(cm, t);
		await press(cm, 'Enter');
		const lastRow = t.el.querySelector('table').rows.length - 1;
		await keys(cm, t, ...repeat('ArrowDown', lastRow + 1), ...repeat('ArrowRight', 3));
		const bottom = at(cm);
		await keys(cm, t, 'ArrowDown');
		const stayed = bottom === at(cm) && bottom.startsWith(`${lastRow},`);
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		check('E36 Table last: the selection stays on the last row, and Escape twice ends on the line above, with no line added', stayed && sel(cm).line === t.first - 1 && cm.state.doc.toString() === original, { bottom, ...sel(cm) });

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
		original = cm.state.doc.toString();
		[t] = tables(cm);
		check('H a table between two images is rendered', !!t, tables(cm).length);
		await caretOnLine(cm, t.last + 1);
		await press(cm, 'ArrowLeft');
		await press(cm, 'Enter');
		check('E37 a table between images: Enter selects its first cell', at(cm) === '0,0' && !openCell(cm), at(cm));
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		check('E37 Escape twice leaves it, unchanged', marked(cm).length === 0 && cm.state.doc.toString() === original, sel(cm));

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
	if (attachedHere) cdp.detach();

	const failed = results.filter((r) => !r.ok);
	// The obsidian module isn't loadable from the CLI's eval, so the app's version comes from its main process.
	const version = window.electron.ipcRenderer.sendSync('version');
	const summary = { obsidian: version, passed: results.length - failed.length, failed: failed.length, results };
	const path = window.require('path').join(app.vault.adapter.basePath, '..', 'check-results.json');
	window.require('fs').writeFileSync(path, JSON.stringify(summary, null, '\t'));
	console.log(`Selectable Tables check: ${summary.passed} passed, ${summary.failed} failed. Results in ${path}`);
	return `${summary.passed} passed, ${summary.failed} failed`;
})();
