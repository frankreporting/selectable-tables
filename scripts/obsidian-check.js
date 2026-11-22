// In-Obsidian checks for Selectable Tables. They test the Obsidian behaviors the plugin relies on, then
// the plugin's keys on the test vault's notes, with simulated key presses, and with real ones through the
// browser for the keys the check on key moves has to tell apart. Every check that shouldn't
// edit a note compares its text before and after, and every note is put back as it was.
//
// Run in the test vault only, with the plugin built and copied in (npm run test-vault). A preview build adds a
// section for the plugin's own table, run with its switch on; the sections before it run with the switch off:
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
	// The key's own character, which macOS needs to match a Cmd or Ctrl shortcut to its menu item: without one it takes the
	// first item with no key of its own, About Obsidian, whose dialog then holds every Obsidian window until someone answers it.
	const macChars = { Escape: '\u001b', Enter: '\r', Tab: '\t', Backspace: '\u007f', ArrowUp: '\uf700', ArrowDown: '\uf701', ArrowLeft: '\uf702', ArrowRight: '\uf703', Home: '\uf729', End: '\uf72b', PageUp: '\uf72c', PageDown: '\uf72d' };
	const macChar = (name) => macChars[name] ?? (name.length === 1 ? name.toLowerCase() : '');
	async function real(key, { altKey, ctrlKey, metaKey, shiftKey } = {}, wait = settle) {
		const modifiers = (altKey ? 1 : 0) | (ctrlKey ? 2 : 0) | (metaKey ? 4 : 0) | (shiftKey ? 8 : 0);
		const event = { key, code: key, windowsVirtualKeyCode: virtualKeys[key], modifiers, unmodifiedText: macChar(key) };
		await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'rawKeyDown' });
		await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
		await wait();
	}
	// Typing as the keyboard sends it: each key's keydown, then its text. An event sent to one element types nothing.
	async function realType(text) {
		for (const char of text) {
			const [code, virtual] = char === ' ' ? ['Space', 32] : /\d/.test(char) ? [`Digit${char}`, char.charCodeAt(0)] : [`Key${char.toUpperCase()}`, char.toUpperCase().charCodeAt(0)];
			const event = { key: char, code, text: char, unmodifiedText: char, windowsVirtualKeyCode: virtual };
			await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyDown' });
			await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
		}
		await settle();
	}
	// An input method's first key, as Chromium sends it, then its composition. On a Mac the key has its real
	// letter, elsewhere Process, and a dead key is Dead, all with key code 229 and before the composition
	// starts. A composition left running freezes the window, so it always ends, with Input.insertText.
	async function realCompose({ key, code, altKey }, steps, commit) {
		const event = { key, code, windowsVirtualKeyCode: 229, modifiers: altKey ? 1 : 0 };
		try {
			await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'rawKeyDown' });
			for (const text of steps) await cdp.sendCommand('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
		} finally {
			await cdp.sendCommand('Input.insertText', { text: commit });
			await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
		}
		await settle();
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

	// A preview build's switch is off for the sections before the own table's, saved off too, since some sections
	// turn the plugin off and on again. It's put back as it was at the end.
	const atStart = app.plugins.plugins['selectable-tables'];
	const previewWasOn = !!atStart?.preview?.isOn();
	if (previewWasOn) {
		atStart.preview.use(false);
		await atStart.saveData({ ...(await atStart.loadData()), ownTables: false });
		await sleep(400);
	}
	try {
		// Every section but the own table's, which comes last: window.__checkOwnOnly skips them.
		existing: {
		if (window.__checkOwnOnly) break existing;
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
		quiet = await keys(cm, seed, ['Enter', { shiftKey: true }]);
		check('22 Shift+Enter does nothing', quiet && at(cm) === '1,1', at(cm));
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

		// An input method's first key on a selected cell starts a paragraph below the table, before its text.
		const composed = await tableUnder(cm, 'Seed trays');
		await selectTable(cm, composed);
		await press(cm, 'Enter');
		await press(cm, 'Process', { keyCode: 229 });
		const paragraphAt = composed.to + 2;
		check('an input method\'s key on a selected cell starts a paragraph below the table', marked(cm).length === 0 && sel(cm).anchor === paragraphAt && sel(cm).head === paragraphAt && cm.state.doc.toString() === `${original.slice(0, paragraphAt)}\n\n${original.slice(paragraphAt)}`, sel(cm));
		await restore(cm, original);

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
		for (const [key, mods] of [['Home', { shiftKey: true }], ['End', { shiftKey: true }], ['ArrowLeft', { metaKey: true, shiftKey: true }], ['ArrowRight', { metaKey: true, shiftKey: true }]]) await real(key, mods);
		check('J12 Shift with them does nothing, and opens no cell', sel(cm).anchor === kept.anchor && sel(cm).head === kept.head && !openCell(cm), sel(cm));
		await press(cm, 'ArrowRight');
		await press(cm, 'ArrowLeft');
		const fromBelow = sel(cm);
		for (const [key, mods] of [['Home', { shiftKey: true }], ['End', { shiftKey: true }]]) await real(key, mods);
		check('J12 the same on a table selected from below', sel(cm).anchor === fromBelow.anchor && sel(cm).head === fromBelow.head && !openCell(cm), sel(cm));
		await press(cm, 'ArrowLeft');
		await press(cm, 'ArrowRight');
		await real('ArrowDown', command);
		const noteEnd = sel(cm).head;
		await real('ArrowUp', command);
		check('J13 Cmd+↓ and Cmd+↑ go to the note\'s end and start from a selected table', noteEnd === cm.state.doc.length && sel(cm).head === 0 && !openCell(cm), { noteEnd, ...sel(cm) });
		check('Jumps B: the note is as it was', cm.state.doc.toString() === original);

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
		cm.dispatch({ changes: { from: noteLength, insert: pastedTable }, selection: { anchor: noteLength + pastedTable.length }, userEvent: 'input.paste' });
		await sleep(400);
		await real('Home');
		await sleep(250);
		s = sel(cm);
		check('J35 Home right after pasting a table selects it from below, and opens no cell', !openCell(cm) && s.anchor === noteLength + pastedTable.length && s.head === noteLength, s);
		await restore(cm, original);
		[t1] = tables(cm);
		await caretOnLine(cm, t1.first - 1);
		await real('ArrowDown', { altKey: true, shiftKey: true });
		await real('End');
		await sleep(250);
		check('J35 End with a selection Shift left on a table\'s edge selects the table, and opens no cell', selectsWhole(cm, t1) && !openCell(cm), sel(cm));
		await caretOnLine(cm, 1);
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
			// Back in normal mode, a letter on a selected table is Vim's, and starts no paragraph.
			[t1] = tables(cm);
			cm.dispatch({ selection: { anchor: t1.from, head: t1.to } });
			await settle();
			const vimSelected = cm.scrollDOM.classList.contains('cm-vimMode') && cm.dom.classList.contains('selectable-tables-selected');
			await press(cm, 'l');
			check('in Vim\'s normal mode, a letter on a selected table is Vim\'s, and starts no paragraph', vimSelected && cm.state.doc.toString() === original, { vimSelected, ...sel(cm) });
			await press(cm, 'Escape');
			await closeCell(cm, t1.from - 1);
		} finally {
			app.vault.setConfig('vimMode', undefined);
			await sleep(2500);
			fs.writeFileSync(appConfig, savedConfig);
		}

		// --- Open cells keep their width
		const columns = (t) => Array.from(t.el.querySelector('table').rows[0].cells, (c) => Math.round(c.getBoundingClientRect().width * 10) / 10).join(', ');
		const WIDTH_COPY = 'selectable-tables-width-copy';
		const copiesIn = (el) => el.querySelectorAll(`.${WIDTH_COPY}`).length;
		// A copy anywhere but in the box holding an open cell's editor was left behind.
		const strayCopies = (el) => Array.from(el.querySelectorAll(`.${WIDTH_COPY}`)).filter((copy) => !copy.parentElement.querySelector(':scope > * > .cm-editor')).length;
		// A cell's boxes: its rendered text, and while it's open, the box Obsidian builds for its editor.
		const boxesOf = (cell) => {
			const wrappers = Array.from(cell.children).filter((child) => child.classList.contains('table-cell-wrapper'));
			const editorBox = wrappers.find((wrapper) => wrapper.querySelector(':scope > * > .cm-editor'));
			return { wrappers, editorBox, rendered: wrappers.find((wrapper) => wrapper !== editorBox) };
		};
		const openTd = (cm) => cm.contentDOM.querySelector('.cm-table-widget.has-focus .cm-editor')?.closest('td, th');
		const lineElement = (cm, text) => Array.from(cm.contentDOM.querySelectorAll('.cm-line')).find((line) => line.textContent === text);
		cm = await open('Markdown in cells');
		original = cm.state.doc.toString();
		const plants = await tableUnder(cm, 'Plants');
		const closedWidths = columns(plants);
		await selectTable(cm, plants);
		await press(cm, 'Enter');
		await keys(cm, plants, 'ArrowDown');
		await press(cm, 'Enter');
		await sleep(300);
		const openFern = openTd(cm);
		const fernBoxes = boxesOf(openFern);
		const editorElement = fernBoxes.editorBox?.querySelector(':scope > * > .cm-editor')?.parentElement;
		check('relies 8a: an open cell has its rendered text hidden, and a box of its own holding the editor\'s element, which holds .cm-editor', fernBoxes.wrappers.length === 2 && fernBoxes.rendered?.style.display === 'none' && editorElement, openFern.innerHTML.slice(0, 200));
		const fernCopy = fernBoxes.editorBox?.querySelector(`:scope > .${WIDTH_COPY}`);
		check('an open cell gets one copy of its rendered text, right after the editor\'s element, unseen', copiesIn(openFern) === 1 && fernCopy && editorElement.nextElementSibling === fernCopy && fernCopy.textContent === fernBoxes.rendered.textContent && getComputedStyle(fernCopy).visibility === 'hidden' && fernCopy.getBoundingClientRect().height === 0, { copies: copiesIn(openFern), text: fernCopy?.textContent });
		check('opening a cell with a link moves no column', columns(plants) === closedWidths, { closedWidths, open: columns(plants) });
		// Focus leaving and coming back to a cell that's still open, as when the window comes forward again.
		cellView(cm).contentDOM.blur();
		await settle();
		cellView(cm).focus();
		await settle();
		check('focus back on an open cell adds no second copy', openTd(cm) === openFern && copiesIn(openFern) === 1, { same: openTd(cm) === openFern, copies: copiesIn(openFern) });
		await press(cellEditor(cm), 'Tab');
		await sleep(300);
		check('moving to another open cell moves no column', columns(plants) === closedWidths, { closedWidths, moved: columns(plants) });
		check('Tab to the next cell leaves no copy behind, and the cell it opens has one', openTd(cm) !== openFern && boxesOf(openFern).wrappers.length === 1 && copiesIn(openFern) === 0 && copiesIn(openTd(cm)) === 1 && strayCopies(plants.el) === 0, { left: copiesIn(openFern), opened: copiesIn(openTd(cm)) });
		cellView(cm).dispatch(cellView(cm).state.replaceSelection(' and a good deal more text than the cell had'), { userEvent: 'input.type' });
		await settle();
		check('typing in an open cell moves no column', columns(plants) === closedWidths, { closedWidths, typing: columns(plants) });
		const typedIn = openTd(cm);
		await press(cellEditor(cm), 'Escape');
		await sleep(300);
		check('relies 8b: once a cell closes, its editor\'s box is gone, and its rendered text shows', !openCell(cm) && boxesOf(typedIn).wrappers.length === 1 && !typedIn.querySelector('.cm-editor') && boxesOf(typedIn).rendered.style.display !== 'none', typedIn.innerHTML.slice(0, 200));
		check('Escape leaves no copy behind', copiesIn(plants.el) === 0, copiesIn(plants.el));
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		await restore(cm, original);
		// A click out of an open cell, onto a line of text.
		await selectTable(cm, plants);
		await press(cm, 'Enter');
		await keys(cm, plants, 'ArrowDown');
		await press(cm, 'Enter');
		await sleep(300);
		const openedBeforeClick = copiesIn(plants.el);
		await realClick(lineElement(cm, 'A line between the tables.'));
		check('a click out of an open cell leaves no copy behind', openedBeforeClick === 1 && !openCell(cm) && copiesIn(plants.el) === 0, { openedBeforeClick, after: copiesIn(plants.el) });
		// A row added with the + button while a cell is open: Obsidian builds the table anew.
		await selectTable(cm, plants);
		await press(cm, 'Enter');
		await keys(cm, plants, 'ArrowDown');
		await press(cm, 'Enter');
		await sleep(300);
		const addRowOpen = plants.el.querySelector('.table-row-btn');
		addRowOpen.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, isPrimary: true }));
		addRowOpen.click();
		await sleep(300);
		const rowAdded = cm.state.doc.lines === original.split('\n').length + 1;
		check('a row added with a cell open leaves no copy behind', rowAdded && strayCopies(plants.el) === 0 && copiesIn(plants.el) <= 1, { rowAdded, copies: copiesIn(plants.el), stray: strayCopies(plants.el) });
		await restore(cm, original);
		await sleep(300);
		check('Open cells: the note is as it was', cm.state.doc.toString() === original);
		cm = await open('Cell moves');
		original = cm.state.doc.toString();
		const empties = await tableUnder(cm, 'Seed trays');
		const emptyClosed = columns(empties);
		await selectTable(cm, empties);
		await press(cm, 'Enter');
		await keys(cm, empties, ...repeat('ArrowDown', 2), ...repeat('ArrowRight', 2));
		await press(cm, 'Enter');
		await sleep(300);
		const emptyCopies = copiesIn(openTd(cm));
		cellView(cm).dispatch(cellView(cm).state.replaceSelection('a sentence typed into an empty cell, which is wider than the column was'), { userEvent: 'input.type' });
		await settle();
		const emptyTyping = columns(empties);
		await press(cellEditor(cm), 'Escape');
		await sleep(300);
		check('an empty cell gets no copy, and still grows as you type, as it always has', emptyCopies === 0 && emptyTyping !== emptyClosed, { emptyCopies, emptyClosed, emptyTyping });
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		await restore(cm, original);
		cm = await open('Pictures in cells');
		original = cm.state.doc.toString();
		const pictures = await tableUnder(cm, 'Picture');
		const picturesClosed = columns(pictures);
		await selectTable(cm, pictures);
		await press(cm, 'Enter');
		await keys(cm, pictures, 'ArrowDown', 'ArrowRight');
		await press(cm, 'Enter');
		await sleep(300);
		const pictureCell = openTd(cm);
		const pictureCopy = pictureCell && boxesOf(pictureCell).editorBox?.querySelector(`.${WIDTH_COPY}`);
		check('a cell with a picture keeps its column\'s width open, its copy holding the picture', placeOf(pictureCell) === '1,1' && pictureCopy?.querySelector('img') && columns(pictures) === picturesClosed, { open: placeOf(pictureCell), closed: picturesClosed, opened: columns(pictures) });
		await press(cellEditor(cm), 'Escape');
		await sleep(300);
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		const player = await tableUnder(cm, 'Player');
		await selectTable(cm, player);
		await press(cm, 'Enter');
		await keys(cm, player, 'ArrowDown', 'ArrowRight');
		await press(cm, 'Enter');
		await sleep(300);
		const playerCell = openTd(cm);
		check('a cell holding a player gets no copy, which would load it again', placeOf(playerCell) === '1,1' && boxesOf(playerCell).rendered?.querySelector('audio') && copiesIn(playerCell) === 0, { open: placeOf(playerCell), audio: !!boxesOf(playerCell ?? document.body).rendered?.querySelector('audio') });
		await press(cellEditor(cm), 'Escape');
		await sleep(300);
		await press(cm, 'Escape');
		await press(cm, 'Escape');
		await restore(cm, original);
		check('Pictures: the note is as it was', cm.state.doc.toString() === original);

		// --- D. Typing, Tab, delete
		cm = await open('Two report tables');
		original = cm.state.doc.toString();
		[t1] = tables(cm);
		await caretOnLine(cm, t1.first - 1);
		await press(cm, 'ArrowRight');
		await press(cm, 'Tab');
		await press(cm, 'Enter', { shiftKey: true });
		s = sel(cm);
		check('D18 Tab and Shift+Enter on a selected table change nothing', cm.state.doc.toString() === original && s.anchor === t1.from && s.head === t1.to && !openCell(cm), s);
		await restore(cm, original);

		// Typing on a selected table or cell starts a paragraph below the table, with a blank line on each
		// side, and one undo takes it all back and selects the table again, from the side it was selected from.
		// Cmd+Z (Ctrl+Z elsewhere): Obsidian's undo command doesn't run from the CLI's eval.
		const mac = navigator.platform.startsWith('Mac');
		const undo = () => press(cm, 'z', { metaKey: mac, ctrlKey: !mac, code: 'KeyZ' });
		// The note with `text` in a paragraph of its own below the table ending at `end`, past its blank line.
		const typedBelow = (end, text) => `${original.slice(0, end + 2)}${text}\n\n${original.slice(end + 2)}`;
		const selectedFrom = (t, fromAbove) => sel(cm).anchor === (fromAbove ? t.from : t.to) && sel(cm).head === (fromAbove ? t.to : t.from);
		const near = (t) => JSON.stringify(cm.state.doc.toString().slice(t.to - 3, t.to + 20));
		let typed;
		let after;
		for (const [name, text] of [['a letter', 'h'], ['a digit', '5'], ['Space', ' ']]) {
			[t1] = tables(cm);
			await selectTable(cm, t1);
			await realType(text);
			typed = cm.state.doc.toString() === typedBelow(t1.to, text) && sel(cm).head === t1.to + 2 + text.length;
			after = near(t1);
			await undo();
			check(`D19 ${name} on a selected table starts a paragraph below it, and one undo selects the table again`, typed && cm.state.doc.toString() === original && selectedFrom(t1, true), { after, ...sel(cm) });
			await restore(cm, original);
		}
		[, t2] = tables(cm);
		await selectTable(cm, t2, false);
		await realType('h');
		typed = cm.state.doc.toString() === typedBelow(t2.to, 'h');
		after = near(t2);
		await undo();
		check('D19 typing on a table selected from below starts the paragraph below it too, and undo selects it from below', typed && cm.state.doc.toString() === original && selectedFrom(t2, false), { after, ...sel(cm) });
		await restore(cm, original);
		[t1] = tables(cm);
		await selectTable(cm, t1);
		await press(cm, 'Enter');
		const cellBefore = at(cm);
		await realType('h');
		typed = cm.state.doc.toString() === typedBelow(t1.to, 'h') && marked(cm).length === 0;
		after = near(t1);
		await undo();
		check('D20 typing on a selected cell starts a paragraph below the table, and one undo selects the table again', cellBefore === '0,0' && typed && cm.state.doc.toString() === original && selectedFrom(t1, true) && marked(cm).length === 0, { cellBefore, after, ...sel(cm) });
		await restore(cm, original);

		// An input method's composition, and a dead key's, lands in the new paragraph and ends normally.
		const compositions = [
			['an input method on a Mac', { key: 'n', code: 'KeyN' }, ['n', 'に', 'にh', 'にほ', 'にほn', 'にほん', '日本'], '日本'],
			['an input method on Windows', { key: 'Process', code: 'KeyN' }, ['n', 'に', '日本'], '日本'],
			['Option+E', { key: 'Dead', code: 'KeyE', altKey: true }, ['´'], 'é'],
		];
		for (const [name, key, steps, commit] of compositions) {
			[t1] = tables(cm);
			await selectTable(cm, t1);
			await realCompose(key, steps, commit);
			typed = cm.state.doc.toString() === typedBelow(t1.to, commit) && sel(cm).head === t1.to + 2 + commit.length;
			const ended = !cm.composing && !cm.compositionStarted;
			after = near(t1);
			await undo();
			check(`D21 ${name} on a selected table composes in a paragraph below it and ends, and one undo selects the table again`, typed && ended && cm.state.doc.toString() === original && selectedFrom(t1, true), { after, ended, ...sel(cm) });
			await restore(cm, original);
		}
		cm = await open('Markdown in cells');
		check('D21 a note opened after the compositions still draws its tables', tables(cm).length > 0, tables(cm).length);
		cm = await open('Two report tables');

		[t1] = tables(cm);
		await selectTable(cm, t1);
		clipboard(cm, 'paste', 'pasted');
		await settle();
		check('D22 Paste still replaces a selected table', cm.state.doc.toString() === original.slice(0, t1.from) + 'pasted' + original.slice(t1.to), near(t1));
		await restore(cm, original);

		[t1] = tables(cm);
		cm.dispatch({ selection: { anchor: t1.from, head: t1.to } });
		// Past CodeMirror's half-second grouping, so undo takes back only the delete.
		await sleep(700);
		await press(cm, 'Backspace');
		check('D16 Backspace deletes the selected table', cm.state.doc.toString() === original.slice(0, t1.from) + original.slice(t1.to));
		await undo();
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
		// A short window draws only the note's top, so its end is drawn too before the tables are counted.
		const top = tables(cm);
		cm.dispatch({ effects: cm.constructor.scrollIntoView(cm.state.doc.length, { y: 'end' }) });
		await sleep(300);
		const edge = [...top, ...tables(cm)].filter((t, i, all) => all.findIndex((u) => u.from === t.from) === i).sort((x, y) => x.from - y.from);
		cm.dispatch({ effects: cm.constructor.scrollIntoView(0, { y: 'start' }) });
		await sleep(300);
		// Drawn: the table under the long heading, the two a blank line apart, and the right-to-left one (STA-88).
		check('G26/27 the callout and the list item hold no rendered table', edge.length === 4, edge.map((e) => e.first));
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
		await sleep(400);

		// --- What frozen rows and columns rely on
		{
			const frames = async (count = 3) => {
				for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
			};
			const FROZEN = 'selectable-tables-frozen', ROW = 'selectable-tables-frozen-row';
			cm = await open('Frozen tables');
			original = cm.state.doc.toString();
			const pane = () => cm.scrollDOM.getBoundingClientRect();
			// A table with its top at the pane's top, and its element, which Obsidian can replace.
			// The tables above it change height as they're drawn, so in a short window the first scroll can fall
			// short of the table, and it scrolls again.
			async function frozenTable(heading, past = 0) {
				const start = cm.state.doc.toString().indexOf(`## ${heading}`);
				const line = cm.state.doc.lineAt(start).number;
				const under = () => tables(cm).find((t) => t.from > start && t.first - line <= 3);
				let found = null;
				for (let tries = 0; tries < 5 && !found; tries++) {
					cm.dispatch({ effects: cm.constructor.scrollIntoView(start, { y: 'start' }) });
					await sleep(300);
					found = under();
				}
				cm.scrollDOM.scrollTop += found.el.getBoundingClientRect().top - pane().top + 16 + past;
				await frames();
				await sleep(150);
				return { ...under(), heading };
			}
			const rowsOf = (t) => t.el.querySelector('table').rows;
			const frozenRows = (t) => Array.from(rowsOf(t)).filter((row) => row.classList.contains(ROW)).map((row) => row.rowIndex);
			const topInPane = (el) => el.getBoundingClientRect().top - pane().top;
			// A mark's space (STA-56): the header cells holding a mark, by column, and how many lines a cell's text takes.
			const MARK_CELL = 'selectable-tables-mark-cell';
			const markCells = (t) => Array.from(rowsOf(t)[0].cells).flatMap((cell, column) => (cell.classList.contains(MARK_CELL) ? [column] : [])).join();
			// Lines by where the text sits: a tag's padded box starts a few pixels above the text beside it, and a
			// space that collapses away has no width.
			const linesIn = (cell) => {
				const range = document.createRange();
				range.selectNodeContents(cell.querySelector('.table-cell-wrapper') ?? cell);
				const rects = Array.from(range.getClientRects()).filter((rect) => rect.width > 0).sort((a, b) => a.top - b.top);
				let lines = 0, last = -Infinity;
				for (const rect of rects) {
					if (rect.top - last > rect.height / 2) lines++;
					last = rect.top;
				}
				return lines;
			};
			// A narrow table squeezes every column to its longest word, its first to "Name", whatever the pane's
			// width. A long cell of the fourth column wrapping shows it.
			const squeeze = async (t) => {
				t.el.style.setProperty('width', '600px');
				await frames();
				return linesIn(rowsOf(t)[1].cells[3]) >= 2;
			};
			const unsqueeze = async (t) => {
				t.el.style.removeProperty('width');
				if (!t.el.getAttribute('style')) t.el.removeAttribute('style');
				await frames();
			};

			const plain = await frozenTable('Sheds');
			const padding = getComputedStyle(plain.el);
			check('relies 13: a table widget is padded by the drag handle size, and scrolls sideways', parseFloat(padding.paddingLeft) === 16 && padding.paddingLeft === padding.getPropertyValue('--table-drag-handle-size').trim() && padding.overflowX === 'auto' && padding.overflowY === 'hidden', { padding: padding.paddingLeft, x: padding.overflowX, y: padding.overflowY });
			const rebuilt = { table: plain.el.querySelector('table'), widget: plain.el };
			plain.el.querySelector('.table-row-btn').click();
			await sleep(300);
			check('relies 14: building a table anew keeps the widget and empties what\'s in it', tables(cm).some((t) => t.el === rebuilt.widget) && rebuilt.widget.querySelector('table') !== rebuilt.table && !rebuilt.table.isConnected, rebuilt.widget.isConnected);
			await restore(cm, original);
			await sleep(300);

			const reading = app.workspace.getMostRecentLeaf().view;
			await reading.setState({ ...reading.getState(), mode: 'preview' }, { history: false });
			await sleep(600);
			const box = reading.containerEl.querySelector('.markdown-preview-view .el-table');
			check('relies 15: a table in Reading view sits in an .el-table box with its own scroll', box && getComputedStyle(box).overflowX === 'auto', box && getComputedStyle(box).overflowX);
			await reading.setState({ ...reading.getState(), mode: 'source', source: false }, { history: false });
			await sleep(400);
			cm = reading.editor.cm;

			// --- Frozen rows and columns
			const plants = await frozenTable('Plants');
			check('Frozen 1 a mark of 2 rows and 1 column marks those', plants.el.classList.contains(FROZEN) && plants.el.classList.contains(`${FROZEN}-rows`) && plants.el.classList.contains(`${FROZEN}-columns-1`) && frozenRows(plants).join() === '0,1', { classes: plants.el.className, rows: frozenRows(plants) });
			check('Frozen 1 a frozen table draws its own borders, and stays the note\'s text', getComputedStyle(plants.el.querySelector('table')).borderCollapse === 'separate' && cm.state.doc.toString() === original);
			check('Frozen 1 the mark doesn\'t show in the cell', rowsOf(plants)[0].cells[0].textContent.trim() === 'Name', rowsOf(plants)[0].cells[0].textContent);
			const header = rowsOf(plants)[0];
			const height = header.offsetHeight + rowsOf(plants)[1].offsetHeight;
			const tableBox = plants.el.querySelector('table');
			const widgetTop = plants.el.getBoundingClientRect().top - pane().top + cm.scrollDOM.scrollTop;
			const placed = [];
			for (const past of [-200, 0, 16, 40, 400, 1000, tableBox.offsetHeight - height - 10, tableBox.offsetHeight - height + 16, tableBox.offsetHeight - 40]) {
				cm.scrollDOM.scrollTop = widgetTop + past;
				await frames();
				const top = topInPane(tableBox), bottom = top + tableBox.offsetHeight;
				placed.push({ past, row: topInPane(header), wanted: Math.min(Math.max(0, top), bottom - height) });
			}
			check('Frozen 1 the rows wait for the table\'s top, pin at the pane\'s top, and leave at its end', placed.every(({ row, wanted }) => Math.abs(row - wanted) <= 1), placed);
			const body = rowsOf(plants)[10];
			cm.scrollDOM.scrollTop = widgetTop + 500;
			await frames();
			const under = document.elementFromPoint(pane().left + pane().width / 2, pane().top + 6);
			check('Frozen 1 the rows are solid, and on top of what passes under them', under && !!under.closest(`.${ROW}`) && getComputedStyle(header.cells[3]).backgroundColor !== 'rgba(0, 0, 0, 0)', under?.tagName);
			const lefts = [];
			for (const x of [0, 1, 8, 16, 17, 60, 300, 8, 0]) {
				plants.el.scrollLeft = x;
				await frames(2);
				lefts.push(body.cells[0].getBoundingClientRect().left - plants.el.getBoundingClientRect().left);
			}
			check('Frozen 3 the frozen column doesn\'t move as sideways scrolling starts or ends', lefts.every((left) => Math.abs(left - 16) < 0.5), lefts);
			plants.el.scrollLeft = 300;
			await frames();
			check('Frozen 3 the first column covers the strip beside it, and what passes is below it', parseFloat(getComputedStyle(body.cells[0]).boxShadow.match(/-?\d+(\.\d+)?px/)[0]) === -16 && parseInt(getComputedStyle(body.cells[0]).zIndex) === 2, getComputedStyle(body.cells[0]).boxShadow);
			const corner = rowsOf(plants)[0].cells[0];
			const cornerPoint = corner.getBoundingClientRect();
			check('Frozen 3 the top-left cell stays above everything', document.elementFromPoint(cornerPoint.left + 6, cornerPoint.top + 6)?.closest('th, td') === corner);
			plants.el.scrollLeft = 0;
			await frames();

			await selectTable(cm, plants);
			cm.scrollDOM.scrollTop = widgetTop + 500;
			await frames();
			check('Frozen 5 the selected table\'s tint lies over the frozen rows and column', plants.el.classList.contains('is-selected') && parseInt(getComputedStyle(tableBox, '::after').zIndex) > parseInt(getComputedStyle(header).zIndex), getComputedStyle(tableBox, '::after').zIndex);
			plants.el.scrollLeft = 300;
			await frames();
			const cover = plants.el.querySelector('.selectable-tables-tint-cover');
			const covered = document.elementsFromPoint(plants.el.getBoundingClientRect().left + 6, pane().top + 200);
			const coverBox = cover && getComputedStyle(cover, '::before');
			check('Frozen 5 scrolled sideways, a cover keeps the tint out of the strip beside the frozen column, and sticks with it', cover && getComputedStyle(cover).display === 'block' && getComputedStyle(cover).position === 'sticky' && parseFloat(coverBox.width) === 14 && parseInt(getComputedStyle(cover).zIndex) > parseInt(getComputedStyle(tableBox, '::after').zIndex) && Math.abs(cover.getBoundingClientRect().left - body.cells[0].getBoundingClientRect().left) < 1, { cover: !!cover, width: coverBox?.width, hit: covered.length });
			plants.el.scrollLeft = 0;
			await frames();
			await press(cm, 'Enter');
			const frame = getComputedStyle(rowsOf(plants)[0].cells[0], '::after');
			check('Frozen 5 Enter selects a cell, and its frame sits inside it, where no neighbor covers it', at(cm) === '0,0' && parseFloat(frame.borderTopWidth) > 0 && [frame.top, frame.right, frame.bottom, frame.left].every((side) => side === '0px'), { at: at(cm), top: frame.top, right: frame.right, bottom: frame.bottom, left: frame.left });
			cm.scrollDOM.scrollTop = widgetTop + 700;
			await frames();
			await sleep(100);
			const pinnedAt = cm.scrollDOM.scrollTop;
			await keys(cm, plants, 'ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowLeft');
			await sleep(100);
			check('Frozen 5 moving across a pinned row leaves the note where it is', Math.abs(cm.scrollDOM.scrollTop - pinnedAt) < 1 && at(cm) === '0,0', { moved: cm.scrollDOM.scrollTop - pinnedAt, at: at(cm) });
			await press(cm, 'ArrowUp');
			await sleep(100);
			check('Frozen 5 ↑ on the top row takes the table back to its start', at(cm) === '0,0' && Math.abs(topInPane(plants.el)) <= 1, { at: at(cm), top: topInPane(plants.el) });
			await keys(cm, plants, 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight');
			plants.el.scrollLeft = 300;
			cm.scrollDOM.scrollTop = widgetTop + 700;
			await frames();
			await sleep(100);
			await press(cm, 'ArrowLeft');
			await press(cm, 'ArrowLeft');
			await sleep(100);
			check('Frozen 5 ← into the frozen column takes the table back to its left', at(cm) === '3,0' && plants.el.scrollLeft === 0, { at: at(cm), left: plants.el.scrollLeft });
			cm.scrollDOM.scrollTop = widgetTop + 700;
			await frames();
			await sleep(100);
			await press(cm, 'PageUp');
			await sleep(100);
			check('Frozen 5 a jump to the top of the column does too', at(cm) === '0,0' && Math.abs(topInPane(plants.el)) <= 1, { at: at(cm), top: topInPane(plants.el) });
			await press(cm, 'Escape');
			await press(cm, 'Escape');

			// --- Cells stay in view around frozen rows and columns
			// What shows at a cell's top corners is the cell, not what's drawn over it, and its bottom is in the pane.
			const inView = (cell) => {
				const { left, right, top, bottom } = cell.getBoundingClientRect();
				return [left + 3, right - 3].every((x) => document.elementFromPoint(x, top + 3)?.closest('td, th') === cell) && bottom <= pane().bottom + 1;
			};
			const selectedCell = () => marked(cm)[0];
			const opened = () => openCell(cm)?.querySelector('.cm-editor').closest('td, th');
			// Scrolls a cell to just below the frozen rows, as a hand would, and on under them by `under` px.
			async function placeBelow(t, cell, under = 0) {
				const last = Array.from(rowsOf(t)).filter((row) => row.classList.contains(ROW)).pop();
				cm.scrollDOM.scrollTop += cell.getBoundingClientRect().top - last.getBoundingClientRect().bottom + under;
				await frames();
				await sleep(100);
			}
			// The same sideways, with the cell against the last of `columns` frozen columns.
			async function placeBeside(t, cell, columns) {
				t.el.scrollLeft += cell.getBoundingClientRect().left - cell.parentElement.cells[columns - 1].getBoundingClientRect().right;
				await frames();
				await sleep(100);
			}

			const stay = await frozenTable('Plants', 600);
			const stayCell = (row, column) => rowsOf(stay)[row].cells[column];
			await selectTable(cm, stay);
			await press(cm, 'Enter');
			await keys(cm, stay, ...repeat('ArrowDown', 20), 'ArrowRight', 'ArrowRight');
			await placeBelow(stay, selectedCell());
			const upward = [];
			for (let i = 0; i < 4; i++) {
				await press(cm, 'ArrowUp');
				upward.push(inView(selectedCell()));
			}
			check('Stay 1 a selected cell moving ↑ is never under the frozen rows', at(cm) === '16,2' && upward.every(Boolean), { at: at(cm), upward });
			check('Stay 1 its margins are gone once it\'s shown', selectedCell().style.scrollMarginBlockStart === '' && selectedCell().style.scrollMarginInlineStart === '', selectedCell().getAttribute('style'));
			const moved = cm.scrollDOM.scrollTop;
			await press(cm, 'ArrowDown');
			check('Stay 1 a cell that\'s already clear moves with no scroll', Math.abs(cm.scrollDOM.scrollTop - moved) < 1 && at(cm) === '17,2', { moved: cm.scrollDOM.scrollTop - moved, at: at(cm) });
			await keys(cm, stay, 'ArrowRight', 'ArrowRight');
			await placeBeside(stay, selectedCell(), 1);
			await press(cm, 'ArrowLeft');
			check('Stay 2 a selected cell moving ← is never under the frozen column', inView(selectedCell()) && at(cm) === '17,3', { at: at(cm), left: stay.el.scrollLeft });
			await keys(cm, stay, 'Home');
			await placeBelow(stay, selectedCell());
			await press(cm, 'ArrowUp');
			check('Stay 1 a frozen column\'s cell moving ↑ clears the frozen rows', inView(selectedCell()) && at(cm) === '16,0', at(cm));
			await keys(cm, stay, 'PageUp', 'ArrowDown', 'ArrowRight', 'ArrowRight', 'ArrowRight');
			cm.scrollDOM.scrollTop += 500;
			await frames();
			await sleep(100);
			await placeBeside(stay, selectedCell(), 1);
			const pinned = cm.scrollDOM.scrollTop;
			await press(cm, 'ArrowLeft');
			check('Stay 2 a pinned row\'s cell moving ← clears the frozen column, and the note stays', inView(selectedCell()) && at(cm) === '1,2' && Math.abs(cm.scrollDOM.scrollTop - pinned) < 1, { at: at(cm), moved: cm.scrollDOM.scrollTop - pinned });
			await keys(cm, stay, 'PageDown');
			const rowsHeight = rowsOf(stay)[0].offsetHeight + rowsOf(stay)[1].offsetHeight;
			cm.scrollDOM.scrollTop += stay.el.querySelector('table').getBoundingClientRect().bottom - pane().top - rowsHeight;
			await frames();
			await sleep(100);
			await press(cm, 'ArrowRight');
			check('Stay 1 a cell under the rows at the table\'s end comes clear of them', inView(selectedCell()), at(cm));
			await keys(cm, stay, 'PageUp', ...repeat('ArrowDown', 20), 'ArrowLeft');
			await placeBelow(stay, selectedCell(), selectedCell().offsetHeight);
			check('Stay a cell scrolled under the frozen rows counts as hidden', !inView(selectedCell()), at(cm));
			const heard = [];
			const hear = (event) => heard.push(event.target.closest('td, th'));
			cm.contentDOM.addEventListener('focusin', hear, true);
			await press(cm, 'Enter');
			cm.contentDOM.removeEventListener('focusin', hear, true);
			check('relies 16: opening a cell focuses its own editor, inside the cell', heard.length === 1 && heard[0] === opened(), heard.length);
			check('Stay 3 Enter on a hidden cell opens it clear of the frozen rows', openAt(cm) === '20,2' && inView(opened()), openAt(cm));
			await placeBelow(stay, opened(), opened().offsetHeight);
			await press(cellView(cm), 'Escape');
			check('Stay 3 Escape from a hidden cell selects it, clear of the frozen rows', at(cm) === '20,2' && inView(selectedCell()), at(cm));
			await press(cm, 'Escape');
			await press(cm, 'Escape');

			const openDown = await frozenTable('Plants', 900);
			const openCellAt = (row, column) => rowsOf(openDown)[row].cells[column];
			await placeBelow(openDown, openCellAt(25, 2));
			await realClick(openCellAt(25, 2));
			const openedAt = cm.scrollDOM.scrollTop;
			check('Stay 3 a click opens a cell just below the frozen rows, and the note stays', openAt(cm) === '25,2' && Math.abs(cm.scrollDOM.scrollTop - openedAt) < 1, openAt(cm));
			await real('ArrowUp');
			await sleep(200);
			check('Stay 3 an open cell moving ↑ is never under the frozen rows', openAt(cm) === '24,2' && inView(opened()), openAt(cm));
			await closeCell(cm, cm.state.doc.line(openDown.first - 1).from);
			const again = await frozenTable('Plants', 900);
			const lowest = Array.from(rowsOf(again)).filter((row) => row.getBoundingClientRect().bottom < pane().bottom - 4).pop();
			await realClick(lowest.cells[2]);
			const downward = [];
			for (let i = 0; i < 3; i++) {
				await real('ArrowDown');
				await sleep(200);
				downward.push(inView(opened()));
			}
			check('Stay 3 an open cell moving ↓ past the pane\'s bottom stays in view', openAt(cm) === `${lowest.rowIndex + 3},2` && downward.every(Boolean), { at: openAt(cm), from: lowest.rowIndex, downward });
			await closeCell(cm, cm.state.doc.line(again.first - 1).from);
			const sideways = await frozenTable('Plants', 900);
			const sideCell = rowsOf(sideways)[30].cells[3];
			await placeBelow(sideways, sideCell, -80);
			await placeBeside(sideways, sideCell, 1);
			await realClick(sideCell);
			await real('Tab', { shiftKey: true });
			await sleep(200);
			check('Stay 3 an open cell moving ← is never under the frozen column', openAt(cm) === '30,2' && inView(opened()), { at: openAt(cm), left: sideways.el.scrollLeft });
			await closeCell(cm, cm.state.doc.line(sideways.first - 1).from);
			sideways.el.scrollLeft = 0;
			const far = await frozenTable('Plants', 1200);
			const farLine = cm.state.doc.line(far.first + 6);
			cm.focus();
			cm.dispatch({ selection: { anchor: farLine.from + farLine.text.indexOf('|', 2) + 3 } });
			await sleep(300);
			check('Stay 3 a caret landing far above opens its cell clear of the frozen rows', openAt(cm) === '5,1' && inView(opened()), openAt(cm));
			await closeCell(cm, cm.state.doc.line(far.first - 1).from);
			const partly = await frozenTable('Plants', 900);
			const partlyCell = rowsOf(partly)[25].cells[2];
			await placeBelow(partly, partlyCell, partlyCell.offsetHeight / 3);
			await realClick(partlyCell);
			check('Stay 3 a click on a cell half under the frozen rows brings it clear', openAt(cm) === '25,2' && inView(opened()), openAt(cm));
			await closeCell(cm, cm.state.doc.line(partly.first - 1).from);

			const clicked = await frozenTable('Plants', 600);
			const pinnedCell = rowsOf(clicked)[0].cells[3];
			const { left: cellLeft, top: cellTop, width: cellWidth, height: cellHeight } = pinnedCell.getBoundingClientRect();
			const point = { x: cellLeft + cellWidth / 2, y: cellTop + cellHeight / 2 };
			const beforeClick = cm.scrollDOM.scrollTop;
			await realClick(pinnedCell);
			const clickedEditor = cellView(cm);
			check('Stay 4 a click on a pinned cell opens it where it was pressed, and the note stays', openAt(cm) === '0,3' && Math.abs(cm.scrollDOM.scrollTop - beforeClick) < 1 && clickedEditor.state.selection.main.head === clickedEditor.posAtCoords(point), { at: openAt(cm), moved: cm.scrollDOM.scrollTop - beforeClick, head: clickedEditor.state.selection.main.head, there: clickedEditor.posAtCoords(point) });
			await cdp.sendCommand('Input.insertText', { text: 'x' });
			await sleep(200);
			check('Stay 4 it takes typing, and the note stays', cm.state.doc.toString() !== original && Math.abs(cm.scrollDOM.scrollTop - beforeClick) < 1, { at: openAt(cm), moved: cm.scrollDOM.scrollTop - beforeClick });
			await closeCell(cm, cm.state.doc.line(clicked.first - 1).from);
			await restore(cm, original);
			await sleep(300);
			// Typing brings back a cell scrolled out of sight, as it does in any table.
			const underRows = (t, cell) => placeBelow(t, cell, cell.offsetHeight);
			const underColumn = async (t, cell) => {
				await placeBeside(t, cell, 1);
				t.el.scrollLeft += cell.offsetWidth;
				await frames();
				await sleep(100);
			};
			for (const [name, column, hide] of [['under the frozen rows', 2, underRows], ['of a frozen column, under the frozen rows', 0, underRows], ['under the frozen column', 3, underColumn]]) {
				const typedIn = await frozenTable('Plants', 900);
				const typedCell = rowsOf(typedIn)[20].cells[column];
				await placeBelow(typedIn, typedCell, -200);
				await realClick(typedCell);
				await hide(typedIn, opened());
				const hid = !inView(opened());
				await cdp.sendCommand('Input.insertText', { text: 'x' });
				await sleep(200);
				check(`Stay 3 typing in a cell ${name} brings it back`, hid && openAt(cm) === `20,${column}` && inView(opened()), { hid, at: openAt(cm) });
				await closeCell(cm, cm.state.doc.line(typedIn.first - 1).from);
				typedIn.el.scrollLeft = 0;
				await restore(cm, original);
				await sleep(300);
			}
			const columnClicked = await frozenTable('Plants', 600);
			columnClicked.el.scrollLeft = 200;
			await frames();
			await sleep(100);
			const stuck = rowsOf(columnClicked)[20].cells[0];
			await placeBelow(columnClicked, stuck, -60);
			const stuckAt = { top: cm.scrollDOM.scrollTop, left: columnClicked.el.scrollLeft };
			await realClick(stuck);
			check('Stay 4 a click on a frozen column\'s cell opens it, and nothing moves', openAt(cm) === '20,0' && Math.abs(cm.scrollDOM.scrollTop - stuckAt.top) < 1 && Math.abs(columnClicked.el.scrollLeft - stuckAt.left) < 1, { at: openAt(cm), top: cm.scrollDOM.scrollTop - stuckAt.top, left: columnClicked.el.scrollLeft - stuckAt.left });
			await closeCell(cm, cm.state.doc.line(columnClicked.first - 1).from);
			columnClicked.el.scrollLeft = 0;
			await restore(cm, original);
			await sleep(300);

			const twoColumns = await frozenTable('Tools', 300);
			await selectTable(cm, twoColumns);
			await press(cm, 'Enter');
			await keys(cm, twoColumns, ...repeat('ArrowDown', 12), ...repeat('ArrowRight', 5));
			await placeBeside(twoColumns, selectedCell(), 2);
			await press(cm, 'ArrowLeft');
			check('Stay 2 a cell clears two frozen columns', inView(selectedCell()) && at(cm) === '12,4', { at: at(cm), left: twoColumns.el.scrollLeft });
			await press(cm, 'Escape');
			await press(cm, 'Escape');
			twoColumns.el.scrollLeft = 0;

			const unmarked = await frozenTable('Sheds', 100);
			await selectTable(cm, unmarked);
			await press(cm, 'Enter');
			await keys(cm, unmarked, ...repeat('ArrowDown', 5), 'ArrowRight', 'ArrowRight');
			check('Stay a table with nothing frozen gets no margins', selectedCell().getAttribute('style') === null, selectedCell().getAttribute('style'));
			await press(cm, 'Escape');
			await press(cm, 'Escape');
			check('Stay: the note is as it was', cm.state.doc.toString() === original);

			const grown = await frozenTable('Plants', 300);
			const pinEnd = () => rowsOf(grown)[0].style.getPropertyValue('--selectable-tables-pin-end');
			const before = pinEnd();
			await selectTable(cm, grown);
			await press(cm, 'Enter');
			await keys(cm, grown, 'ArrowDown');
			await press(cm, 'Enter');
			cellView(cm).dispatch({ changes: { from: 0, insert: 'Some text that wraps. ' }, userEvent: 'input.type' });
			await sleep(300);
			check('Frozen a frozen cell that grows updates the rows', pinEnd() !== before && grown.el.classList.contains(`${FROZEN}-rows`), { before, after: pinEnd() });
			cellView(cm).dispatch({ changes: { from: 0, insert: 'A long line of text that wraps inside the cell. '.repeat(6) }, userEvent: 'input.type' });
			await sleep(300);
			check('Frozen rows taller than half the pane stop pinning', !grown.el.classList.contains(`${FROZEN}-rows`), grown.el.className);
			await closeCell(cm, cm.state.doc.line(grown.first - 1).from);
			await restore(cm, original);
			await sleep(300);
			const room = await frozenTable('Plants', 300);
			check('Frozen they pin again when there\'s room', room.el.classList.contains(`${FROZEN}-rows`), room.el.className);

			const tools = await frozenTable('Tools', 300);
			const toolRow = rowsOf(tools)[12];
			check('Frozen 2 another table has its own freeze', frozenRows(tools).join() === '0' && tools.el.classList.contains(`${FROZEN}-columns-2`), tools.el.className);
			check('Frozen 2 its rows take over at the pane\'s top', Math.abs(topInPane(rowsOf(tools)[0])) <= 1, topInPane(rowsOf(tools)[0]));
			tools.el.scrollLeft = 400;
			await frames();
			const [first, second, third] = Array.from(toolRow.cells).map((cell) => cell.getBoundingClientRect());
			check('Frozen 3 a second frozen column sits exactly against the first, and the third passes under it', Math.abs(first.right - second.left) < 0.1 && third.left < second.right, { first: first.right, second: second.left, third: third.left });
			tools.el.scrollLeft = 0;
			await frames();

			const shed = await frozenTable('Sheds');
			check('Frozen 2 a table with no mark isn\'t frozen, and keeps its collapsed borders', !shed.el.classList.contains(FROZEN) && frozenRows(shed).length === 0 && getComputedStyle(shed.el.querySelector('table')).borderCollapse === 'collapse', shed.el.className);
			await selectTable(cm, shed);
			await press(cm, 'Enter');
			await press(cm, 'Enter');
			const typedIn = cellView(cm);
			typedIn.dispatch({ changes: { from: 0, insert: '%%freeze 1 1%% ' }, selection: { anchor: 15 }, userEvent: 'input.type' });
			await sleep(200);
			check('Frozen 6 a mark typed in a cell freezes the table at once', frozenRows(shed).join() === '0' && shed.el.classList.contains(`${FROZEN}-columns-1`), { rows: frozenRows(shed), classes: shed.el.className });
			await press(typedIn, 'Escape');
			await press(cm, 'Escape');
			await sleep(200);
			const typed = await frozenTable('Sheds');
			check('Frozen 6 the typed mark doesn\'t show', rowsOf(typed)[0].cells[0].textContent.trim() === 'Name', rowsOf(typed)[0].cells[0].textContent);
			await selectTable(cm, typed);
			await press(cm, 'Enter');
			await press(cm, 'Enter');
			check('Frozen 6 Enter still opens its cells', openAt(cm) === '0,0', openAt(cm));
			await closeCell(cm, cm.state.doc.line(typed.first - 1).from);
			await restore(cm, original);
			await sleep(300);
			const unfrozen = await frozenTable('Sheds');
			check('Frozen 6 taking the mark out ends the freeze, and leaves nothing behind', !unfrozen.el.classList.contains(FROZEN) && frozenRows(unfrozen).length === 0 && !unfrozen.el.getAttribute('style'), { classes: unfrozen.el.className, style: unfrozen.el.getAttribute('style') });

			const edited = await frozenTable('Plants');
			edited.el.querySelector('.table-row-btn').click();
			await sleep(300);
			check('Frozen 7 a row added from the table\'s button keeps the freeze', frozenRows(edited).join() === '0,1' && rowsOf(edited)[0].style.getPropertyValue('--selectable-tables-travel') !== '', frozenRows(edited));
			edited.el.querySelector('.table-col-btn').click();
			await sleep(300);
			check('Frozen 7 a column added from the table\'s button keeps the mark', cm.state.doc.toString().includes('%%freeze 2 1%%') && edited.el.classList.contains(`${FROZEN}-columns-1`), edited.el.className);
			await restore(cm, original);
			await sleep(300);

			// --- A mark's space. The mark draws nothing, but the space typed beside it stays in its header cell, and
			// Obsidian's cells keep every space, so in a column as narrow as "Name" it took a line of its own (STA-56).
			{
				const freezeRows = async () => {
					app.commands.executeCommandById('selectable-tables:freeze-rows');
					await sleep(300);
				};
				let spaced = await frozenTable('Plants');
				let squeezed = await squeeze(spaced);
				let name = rowsOf(spaced)[0].cells[0];
				check('relies 22: a mark draws nothing, and the space typed after it stays in its cell\'s text', name.querySelector('.table-cell-wrapper').textContent === ' Name', JSON.stringify(name.textContent));
				check('Mark 1 the header cell holding a typed mark is marked, and no other', markCells(spaced) === '0', markCells(spaced));
				check('Mark 1 that cell is one line, in a column squeezed to "Name"', squeezed && linesIn(name) === 1 && rowsOf(spaced)[0].offsetHeight < rowsOf(spaced)[1].offsetHeight, { squeezed, lines: linesIn(name), header: rowsOf(spaced)[0].offsetHeight, row: rowsOf(spaced)[1].offsetHeight });
				spaced.el.querySelector('.table-row-btn').click();
				await sleep(300);
				check('Mark 1 a row added from the table\'s button, which builds the table anew, keeps the mark\'s cell marked', markCells(spaced) === '0' && linesIn(rowsOf(spaced)[0].cells[0]) === 1, markCells(spaced));
				await unsqueeze(spaced);
				await restore(cm, original);
				await sleep(300);

				// Toggling the class on a header row that's already right, as each change to a header line does.
				spaced = await frozenTable('Plants');
				const cells = Array.from(rowsOf(spaced)[0].cells);
				const started = performance.now();
				for (let i = 0; i < 1000; i++) cells.forEach((cell, column) => cell.classList.toggle(MARK_CELL, column === 0));
				const each = (performance.now() - started) / 1000;
				check(`Mark speed: setting a header row's ${cells.length} cells takes ${each.toFixed(4)} ms`, each < 0.05, each);

				let shed = await frozenTable('Sheds');
				squeezed = await squeeze(shed);
				const height = rowsOf(shed)[0].offsetHeight;
				check('Mark 2 a table with no mark has no cell marked', markCells(shed) === '', markCells(shed));
				await selectTable(cm, shed);
				await press(cm, 'Enter');
				await freezeRows();
				shed = await frozenTable('Sheds');
				name = rowsOf(shed)[0].cells[0];
				check('Mark 2 Freeze rows up to here marks the Name cell, and the header row stays as tall', squeezed && cm.state.doc.lineAt(shed.from).text.includes('%%freeze 1 0%% Name') && markCells(shed) === '0' && linesIn(name) === 1 && Math.abs(rowsOf(shed)[0].offsetHeight - height) <= 1, { squeezed, header: cm.state.doc.lineAt(shed.from).text.slice(0, 30), marked: markCells(shed), lines: linesIn(name), before: height, after: rowsOf(shed)[0].offsetHeight });
				await press(cm, 'Enter');
				const typedIn = openCell(cm) && cellView(cm);
				const shown = typedIn?.state.doc.toString();
				check('Mark 3 the open cell shows the mark and its space as typed', shown === '%%freeze 1 0%% Name', JSON.stringify(shown));
				if (typedIn) {
					typedIn.dispatch({ changes: { from: typedIn.state.doc.length, insert: 's' }, selection: { anchor: typedIn.state.doc.length + 1 }, userEvent: 'input.type' });
					await sleep(200);
					await press(typedIn, 'Escape');
				}
				await sleep(200);
				check('relies 22: opening, editing and closing a cell keeps its element', rowsOf(shed)[0].cells[0] === name && name.isConnected && name.textContent === ' Names', { same: rowsOf(shed)[0].cells[0] === name, text: JSON.stringify(name.textContent) });
				check('Mark 3 the cell stays marked and one line after it was opened and edited', name.classList.contains(MARK_CELL) && linesIn(name) === 1, { marked: markCells(shed), lines: linesIn(name) });
				await press(cm, 'Escape');
				await press(cm, 'Escape');

				// Formatted text, which a mark written right against it would change: a tag needs a space before it.
				for (const [label, text] of [['bold', '**Name**'], ['a tag', '#shed'], ['a link', '[[Name]]']]) {
					await restore(cm, original);
					const line = cm.state.doc.lineAt(cm.state.doc.toString().indexOf('| Name    | Bed', cm.state.doc.toString().indexOf('## Sheds')));
					cm.dispatch({ changes: { from: line.from, to: line.from + '| Name    '.length, insert: `| %%freeze 1 0%% ${text} ` } });
					await sleep(300);
					shed = await frozenTable('Sheds');
					squeezed = await squeeze(shed);
					name = rowsOf(shed)[0].cells[0];
					check(`Mark 4 a header cell starting with ${label} is marked, and one line`, squeezed && markCells(shed) === '0' && linesIn(name) === 1 && shed.el.classList.contains(FROZEN), { squeezed, marked: markCells(shed), lines: linesIn(name), html: name.querySelector('.table-cell-wrapper')?.innerHTML.slice(0, 80) });
					await unsqueeze(shed);
				}
				await restore(cm, original);
				await sleep(300);
				shed = await frozenTable('Sheds');
				check('Mark 5 taking the mark out takes the class off', markCells(shed) === '', markCells(shed));
				check('Mark: the note is as it was', cm.state.doc.toString() === original);
			}

			// --- Freezing from a command
			{
				const ids = ['freeze-rows', 'freeze-columns', 'freeze-rows-and-columns', 'unfreeze-table'];
				const commandOf = (id) => app.commands.commands[`selectable-tables:${id}`];
				const offered = (id) => commandOf(id)?.checkCallback?.(true) === true;
				const run = async (id) => {
					const ran = app.commands.executeCommandById(`selectable-tables:${id}`);
					await sleep(300);
					return ran;
				};
				const header = (t) => cm.state.doc.lineAt(t.from).text;
				// Through the command palette, as Brian runs it: the palette takes the focus, and gives it back.
				async function fromPalette(name) {
					app.commands.executeCommandById('command-palette:open');
					await sleep(300);
					const input = document.querySelector('.prompt-input');
					input.value = name;
					input.dispatchEvent(new Event('input'));
					await sleep(300);
					const chosen = document.querySelector('.prompt .suggestion-item.is-selected')?.textContent ?? '';
					await press(input, 'Enter');
					await sleep(300);
					return chosen;
				}
				// The third row and second column, as the test plan has it.
				async function selectThirdRow(t) {
					await selectTable(cm, t);
					await press(cm, 'Enter');
					await press(cm, 'ArrowDown');
					await press(cm, 'ArrowDown');
					await press(cm, 'ArrowRight');
				}
				check('Command the four commands are registered', ids.every(commandOf), ids.filter((id) => !commandOf(id)));

				let shed = await frozenTable('Sheds');
				await caretOnLine(cm, shed.first - 1);
				check('Command 5 none is offered with the caret on a text line', !ids.some(offered), ids.filter(offered));
				await selectTable(cm, shed);
				check('Command none is offered on a selected table', !ids.some(offered), ids.filter(offered));
				await press(cm, 'Enter');
				check('Command on the first cell, every freeze is offered, but not Unfreeze on a table with no mark', offered('freeze-rows') && offered('freeze-columns') && offered('freeze-rows-and-columns') && !offered('unfreeze-table'), ids.filter(offered));
				await press(cm, 'Escape');
				await press(cm, 'Escape');

				shed = await frozenTable('Sheds');
				await selectThirdRow(shed);
				check('Command on the third row and second column', at(cm) === '2,1', at(cm));
				const chosen = await fromPalette('Freeze rows up to here');
				shed = await frozenTable('Sheds');
				check('Command 1 the palette runs Freeze rows up to here', chosen.includes('Freeze rows up to here'), chosen);
				check('Command 1 Freeze rows up to here freezes rows 1 to 3', header(shed).includes('%%freeze 3 0%%') && frozenRows(shed).join() === '0,1,2', { header: header(shed), rows: frozenRows(shed) });
				check('Command 1 the cell is still selected, over the whole table, and the note has the keyboard', at(cm) === '2,1' && selectsWhole(cm, shed) && cm.hasFocus && !openCell(cm), { at: at(cm), sel: sel(cm), focus: cm.hasFocus });
				const frozenText = cm.state.doc.toString();
				await press(cm, 'ArrowDown');
				check('Command 1 the arrows still move the cell, and change nothing', at(cm) === '3,1' && cm.state.doc.toString() === frozenText, at(cm));
				await press(cm, 'ArrowUp');

				await press(cm, 'z', { metaKey: true });
				await sleep(300);
				shed = await frozenTable('Sheds');
				check('Command 2 Undo takes the freeze back, and the text is as it was', cm.state.doc.toString() === original && frozenRows(shed).length === 0 && !shed.el.classList.contains(FROZEN), header(shed));
				check('Command 2 the cell stays selected after Undo', at(cm) === '2,1' && selectsWhole(cm, shed), at(cm));
				// Redo through Obsidian's editor: a Shift+Cmd+Z sent to one element doesn't reach it, even on a text line.
				app.workspace.activeEditor.editor.redo();
				await sleep(300);
				const redone = cm.state.doc.toString() === frozenText;
				check('Command 2 Redo puts it back', redone, cm.state.doc.lineAt(shed.from).text);
				if (redone) await press(cm, 'z', { metaKey: true });
				await sleep(300);
				check('Command 2 and Undo again takes it back', cm.state.doc.toString() === original);

				await run('freeze-rows-and-columns');
				shed = await frozenTable('Sheds');
				check('Command 3 Freeze rows and columns up to here freezes rows 1 to 3 and columns 1 and 2', header(shed).includes('%%freeze 3 2%%') && frozenRows(shed).join() === '0,1,2' && shed.el.classList.contains(`${FROZEN}-columns-2`), { header: header(shed), rows: frozenRows(shed), classes: shed.el.className });
				check('Command 3 Unfreeze is offered once there\'s a mark', offered('unfreeze-table'), ids.filter(offered));
				await press(cm, 'Enter');
				check('Command 3 Enter still opens a cell', openAt(cm) === '2,1', openAt(cm));

				check('relies 20: with a cell open, an editor command gets the note\'s editor', app.workspace.activeEditor?.editor?.cm === cm, app.workspace.activeEditor?.getViewType?.());
				check('Command the commands are offered with a cell open', ids.every(offered), ids.filter(offered));
				// One cell right, so that freezing its column changes the mark.
				await press(cellEditor(cm), 'Escape');
				await press(cm, 'ArrowRight');
				await press(cm, 'Enter');
				check('Command the third row\'s third cell is open', openAt(cm) === '2,2', openAt(cm));
				await fromPalette('Freeze columns up to here');
				shed = await frozenTable('Sheds');
				check('Command from an open cell, the cell closes and stays selected, and the table freezes', !openCell(cm) && at(cm) === '2,2' && header(shed).includes('%%freeze 3 3%%') && shed.el.classList.contains(`${FROZEN}-columns-3`), { open: openAt(cm), at: at(cm), header: header(shed) });
				check('Command from an open cell, the note has the keyboard after', cm.hasFocus && selectsWhole(cm, shed), { focus: cm.hasFocus, sel: sel(cm) });

				await press(cm, 'ArrowUp');
				await press(cm, 'ArrowUp');
				await press(cm, 'ArrowLeft');
				await press(cm, 'ArrowLeft');
				const copiedHeader = clipboard(cm, 'copy');
				check('Command 6 Copy on the first header cell gives its text without the mark', at(cm) === '0,0' && copiedHeader.taken && copiedHeader.text === 'Name', { at: at(cm), copiedHeader });

				await run('unfreeze-table');
				shed = await frozenTable('Sheds');
				check('Command 4 Unfreeze table leaves no mark, and the table\'s text as it was', cm.state.doc.toString() === original && !shed.el.classList.contains(FROZEN) && frozenRows(shed).length === 0, header(shed));
				check('Command 4 Unfreeze is no longer offered, and the cell stays selected', !offered('unfreeze-table') && at(cm) === '0,0', { offered: ids.filter(offered), at: at(cm) });
				await press(cm, 'Escape');
				await press(cm, 'Escape');
				check('Command: the note is as it was', cm.state.doc.toString() === original);

				// --- The selected cell stays in view when Unfreeze or Undo unpins its row or column
				{
					let sheds = shed;
					// How much of the selected cell is hidden, at its top, bottom, left and right: by the pane, its
					// table's box, or the rows and columns pinned over it. `gap` is its distance from the top and left
					// it can show at, past its own scroll margin, which a scroll that goes just far enough leaves at 0.
					const shown = () => {
						const cell = cm.contentDOM.querySelector('.selectable-tables-cell');
						if (!cell) return { inView: false, at: at(cm) };
						const widget = cell.closest('.cm-table-widget');
						const r = cell.getBoundingClientRect(), p = pane(), w = widget.getBoundingClientRect();
						const pinned = widget.classList.contains(`${FROZEN}-rows`) ? Array.from(widget.querySelectorAll(`tr.${ROW}`)) : [];
						const top = pinned.length && !pinned.includes(cell.parentElement) ? Math.max(...pinned.map((row) => row.getBoundingClientRect().bottom)) : p.top;
						const sticky = (c) => getComputedStyle(c).position === 'sticky';
						const before = sticky(cell) ? [] : Array.from(cell.parentElement.cells).filter((c) => c.cellIndex < cell.cellIndex && sticky(c));
						const left = Math.max(p.left, before.length ? Math.max(...before.map((c) => c.getBoundingClientRect().right)) : w.left);
						const hidden = [top - r.top, r.bottom - p.bottom, left - r.left, r.right - Math.min(p.right, w.right)].map((px) => Math.max(0, Math.round(px)));
						const margin = getComputedStyle(cell);
						const gap = [r.top - top - parseFloat(margin.scrollMarginTop), r.left - left - parseFloat(margin.scrollMarginLeft)].map(Math.round);
						return { inView: hidden.every((px) => px < 2), hidden, gap, at: at(cm) };
					};
					const scroll = () => ({ top: Math.round(cm.scrollDOM.scrollTop), left: Math.round(sheds.el.scrollLeft) });
					const still = (before) => Math.abs(scroll().top - before.top) < 2 && Math.abs(scroll().left - before.left) < 2;
					const flush = (gap) => Math.abs(gap) < 2;
					// Puts a row's place in the table at the pane's top, where it would be with nothing pinned.
					async function toRow(row) {
						const table = sheds.el.querySelector('table');
						const above = Array.from(table.rows).slice(0, row).reduce((sum, r) => sum + r.offsetHeight, 0);
						cm.scrollDOM.scrollTop += table.getBoundingClientRect().top + above - pane().top;
						await frames();
						await sleep(150);
					}
					async function sideways(px) {
						sheds.el.scrollLeft = px;
						await frames();
						await sleep(150);
					}
					const undo = async () => {
						await press(cm, 'z', { metaKey: true });
						await sleep(300);
					};
					// Shed 3's Sown cell, with Sheds' header row just above the pane.
					async function selectSown() {
						await restore(cm, original);
						await selectThirdRow(await frozenTable('Sheds'));
						await press(cm, 'ArrowDown');
						await press(cm, 'ArrowRight');
						sheds = await frozenTable('Sheds', 40);
					}

					await selectSown();
					check('Keep on Shed 3\'s Sown cell, with the header row out of view', at(cm) === '3,2' && shown().inView, shown());
					let before = scroll();
					await run('freeze-rows');
					check('Keep 1 Freeze rows up to here pins the cell\'s row, and the note doesn\'t move', frozenRows(sheds).join() === '0,1,2,3' && shown().inView && still(before), { rows: frozenRows(sheds), shown: shown(), before, after: scroll() });
					await toRow(20);
					check('Keep 2 scrolled down to Shed 20, the pinned cell is in view', shown().inView, shown());
					await run('unfreeze-table');
					let unpinned = shown();
					check('Keep 2 Unfreeze table scrolls the note back just far enough to show the cell', !sheds.el.classList.contains(FROZEN) && unpinned.inView && flush(unpinned.gap[0]), unpinned);

					await run('freeze-rows');
					await toRow(20);
					await undo();
					unpinned = shown();
					check('Keep 3 Undo of a freeze, scrolled down, takes it back and shows the cell', !sheds.el.classList.contains(FROZEN) && cm.state.doc.toString() === original && unpinned.inView && flush(unpinned.gap[0]), unpinned);
					await toRow(20);
					app.workspace.activeEditor.editor.redo();
					await sleep(300);
					check('Keep 3 Redo pins the cell\'s row again, in view', frozenRows(sheds).join() === '0,1,2,3' && shown().inView, shown());
					// Down to Shed 10, below the frozen rows, and unfrozen: Undo pins the rows again over where it sits.
					for (let i = 0; i < 7; i++) await press(cm, 'ArrowDown');
					await run('unfreeze-table');
					await toRow(10);
					await undo();
					const covered = shown();
					check('Keep 3 Undo of Unfreeze shows the cell below the rows it pins again', covered.at === '10,2' && frozenRows(sheds).join() === '0,1,2,3' && covered.inView, { rows: frozenRows(sheds), covered });

					await press(cm, 'Escape');
					await selectSown();
					await sideways(260);
					check('Keep 4 scrolled sideways, Name is out of view and the cell in view', sheds.el.querySelector('table').rows[3].cells[0].getBoundingClientRect().right < sheds.el.getBoundingClientRect().left && shown().inView, shown());
					before = scroll();
					await run('freeze-columns');
					check('Keep 4 Freeze columns up to here pins Name, Bed and Sown, and nothing moves', sheds.el.classList.contains(`${FROZEN}-columns-3`) && shown().inView && still(before), { shown: shown(), before, after: scroll() });
					await sideways(700);
					await run('unfreeze-table');
					unpinned = shown();
					check('Keep 4 Unfreeze table scrolls the table back just far enough to show the cell', unpinned.inView && flush(unpinned.gap[1]) && scroll().left > 0, { unpinned, left: scroll().left });

					await sideways(260);
					before = scroll();
					await run('freeze-rows-and-columns');
					check('Keep 5 Freeze rows and columns up to here leaves the cell in view, and nothing moves', header(sheds).includes('%%freeze 4 3%%') && shown().inView && still(before), { header: header(sheds), shown: shown(), before, after: scroll() });
					await toRow(20);
					await sideways(700);
					check('Keep 5 scrolled down and sideways, the cell is in view at the inside corner', shown().inView, shown());
					await run('unfreeze-table');
					unpinned = shown();
					check('Keep 5 Unfreeze table scrolls the note and the table just far enough to show the cell', unpinned.inView && flush(unpinned.gap[0]) && flush(unpinned.gap[1]), unpinned);

					await press(cm, 'Escape');
					await selectSown();
					sheds = await frozenTable('Sheds', -60);
					before = scroll();
					await run('freeze-rows');
					check('Keep 6 with the header in view, Freeze rows up to here doesn\'t move the note', shown().inView && still(before), { shown: shown(), before, after: scroll() });
					await run('unfreeze-table');
					check('Keep 6 nor does Unfreeze table', shown().inView && still(before), { shown: shown(), before, after: scroll() });

					// A freeze taken out by Sync arrives as a reload, which mustn't move the note.
					await run('freeze-rows');
					await toRow(20);
					before = scroll();
					const line = cm.state.doc.lineAt(sheds.from);
					const mark = line.text.indexOf('%%freeze 4 0%% ');
					cm.dispatch({ changes: { from: line.from + mark, to: line.from + mark + '%%freeze 4 0%% '.length }, userEvent: 'set' });
					await frames();
					await sleep(300);
					check('Keep a freeze taken out by Sync leaves the note where it is', mark > 0 && !sheds.el.classList.contains(FROZEN) && at(cm) === '3,2' && still(before), { mark, at: at(cm), before, after: scroll() });

					await press(cm, 'Escape');
					await press(cm, 'Escape');
					await restore(cm, original);
					check('Keep: the note is as it was', cm.state.doc.toString() === original);
				}

				// A table Obsidian didn't write keeps its spacing.
				cm = await open('Cell moves');
				const cellNote = cm.state.doc.toString();
				const odd = await tableUnder(cm, 'Uneven rows');
				await selectTable(cm, odd);
				await press(cm, 'Enter');
				await run('freeze-rows');
				const lines = cellNote.split('\n');
				const changed = cm.state.doc.toString().split('\n').filter((line, index) => line !== lines[index]);
				check('Command on a table Obsidian didn\'t write, only its header row changes', changed.length === 1 && changed[0] === '| %%freeze 1 0%% Shelf | Pots | Soil |', changed);
				await press(cm, 'z', { metaKey: true });
				await sleep(300);
				check('Command and Undo takes that back too', cm.state.doc.toString() === cellNote);
				await press(cm, 'Escape');
				await press(cm, 'Escape');
				await restore(cm, cellNote);
				cm = await open('Frozen tables');
			}

			// --- Freezing from the right-click menu, with real right-clicks: Obsidian builds its menus from the
			// browser's own events. A script can't read a native menu, which a Mac shows unless the vault says
			// otherwise, so Obsidian draws its own here: the setting changes in memory, is never saved, and goes back.
			{
				const config = app.vault.config;
				const hadNative = Object.hasOwn(config, 'nativeMenus');
				const nativeBefore = config.nativeMenus;
				const shownMenu = () => Array.from(document.querySelectorAll('.menu')).pop() ?? null;
				// Escape sent to the menu itself, so the note's editor never hears it.
				async function closeMenu() {
					shownMenu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
					await sleep(200);
				}
				try {
					config.nativeMenus = false;
					app.updateUseNativeMenu();
					const SECTION = 'selectable-tables-freeze';
					const names = ['Freeze rows up to here', 'Freeze columns up to here', 'Freeze rows and columns up to here', 'Unfreeze table'];
					const header = (t) => cm.state.doc.lineAt(t.from).text;
					const tableNamed = (heading) => {
						const start = cm.state.doc.toString().indexOf(`## ${heading}`);
						const line = cm.state.doc.lineAt(start).number;
						return tables(cm).find((t) => t.from > start && t.first - line <= 3);
					};
					const items = () => Array.from(shownMenu()?.querySelectorAll('.menu-item') ?? []).map((item) => ({ title: item.querySelector('.menu-item-title')?.textContent ?? '', section: item.dataset.section ?? '' }));
					const freezeItems = () => items().filter((item) => item.section === SECTION).map((item) => item.title);
					const sections = () => [...new Set(items().map((item) => item.section))];
					async function rightClick(el, x) {
						const { left, top, width, height } = el.getBoundingClientRect();
						const point = { x: x ?? left + width / 2, y: top + height / 2, button: 'right', clickCount: 1 };
						await cdp.sendCommand('Input.dispatchMouseEvent', { ...point, type: 'mousePressed' });
						await cdp.sendCommand('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased' });
						await sleep(500);
					}
					async function choose(title) {
						const item = Array.from(shownMenu()?.querySelectorAll('.menu-item') ?? []).find((el) => el.querySelector('.menu-item-title')?.textContent === title);
						if (item) await realClick(item);
						await sleep(300);
						return !!item;
					}
					const undo = async () => {
						await press(cm, 'z', { metaKey: true });
						await sleep(300);
					};

					// 1. A cell that isn't open, with nothing selected: the caret on the line above the table.
					let sheds = await frozenTable('Sheds');
					await caretOnLine(cm, sheds.first - 1);
					sheds = await frozenTable('Sheds');
					let heard = null;
					const hear = (event) => {
						heard = { prevented: event.defaultPrevented, pointer: event.pointerType };
					};
					cm.contentDOM.addEventListener('contextmenu', hear);
					await rightClick(rowsOf(sheds)[2].cells[1]);
					cm.contentDOM.removeEventListener('contextmenu', hear);
					check('relies 21: a right-click on a cell that isn\'t open reaches the note\'s content with its default prevented, by Obsidian\'s Menu.forEvent', heard?.prevented === true && heard.pointer === 'mouse', heard);
					check('Menu 1 a right-click on a cell shows Obsidian\'s own items for the table, and opens no cell', sections().includes('table') && sections().includes('table-sort') && !openCell(cm), { sections: sections(), open: openAt(cm) });
					check('Menu 1 the freeze items are in that same menu, after Obsidian\'s, with no Unfreeze on a table with no mark', freezeItems().join() === names.slice(0, 3).join() && sections().at(-1) === SECTION, { freeze: freezeItems(), sections: sections() });
					check('Menu 1 chose Freeze rows up to here', await choose(names[0]), items());
					sheds = tableNamed('Sheds');
					check('Menu 1 Freeze rows up to here freezes rows 1 to 3, up to the right-clicked cell', header(sheds).includes('%%freeze 3 0%%') && frozenRows(sheds).join() === '0,1,2', { header: header(sheds), rows: frozenRows(sheds) });
					check('Menu 1 the right-clicked cell is selected, over the whole table, with the keyboard in the note', at(cm) === '2,1' && selectsWhole(cm, sheds) && cm.hasFocus && !openCell(cm) && !shownMenu(), { at: at(cm), sel: sel(cm), focus: cm.hasFocus, menu: !!shownMenu() });
					const frozenText = cm.state.doc.toString();
					await press(cm, 'ArrowDown');
					check('Menu 1 the arrows move the cell from there, and change nothing', at(cm) === '3,1' && cm.state.doc.toString() === frozenText, at(cm));
					await press(cm, 'ArrowUp');
					await undo();
					sheds = tableNamed('Sheds');
					check('Menu 1 Undo takes it back, and the cell stays selected', cm.state.doc.toString() === original && frozenRows(sheds).length === 0 && at(cm) === '2,1', { at: at(cm), header: header(sheds) });

					// 2. An open cell, opened by Enter one cell to the right: a right-click in its text.
					await press(cm, 'ArrowRight');
					await press(cm, 'Enter');
					check('Menu 2 the third row\'s third cell is open', openAt(cm) === '2,2', openAt(cm));
					let fromMenu = null;
					const ref = app.workspace.on('editor-menu', (menu, editor, info) => {
						fromMenu = { cellEditor: editor !== info.editor, noteInfo: info.editor?.cm === cm, own: editor.cm === cellView(cm) };
					});
					await rightClick(cellEditor(cm));
					app.workspace.offref(ref);
					check('relies 21: a right-click in an open cell fires editor-menu with the cell\'s own editor, and the note\'s view as its info', fromMenu?.cellEditor && fromMenu.noteInfo && fromMenu.own, fromMenu);
					check('Menu 2 a right-click in an open cell shows the freeze items too, with the editor\'s items and Obsidian\'s own for the table', freezeItems().join() === names.slice(0, 3).join() && sections().includes('table') && sections().some((section) => section !== SECTION && !section.startsWith('table')), { freeze: freezeItems(), sections: sections() });
					check('Menu 2 chose Freeze columns up to here', await choose(names[1]), items());
					sheds = tableNamed('Sheds');
					check('Menu 2 the cell closes and stays selected, and its column and those to its left freeze', !openCell(cm) && at(cm) === '2,2' && header(sheds).includes('%%freeze 0 3%%') && sheds.el.classList.contains(`${FROZEN}-columns-3`), { open: openAt(cm), at: at(cm), header: header(sheds) });
					check('Menu 2 the keyboard is in the note after', cm.hasFocus && selectsWhole(cm, sheds), { focus: cm.hasFocus, sel: sel(cm) });
					await undo();
					check('Menu 2 Undo takes only that back', cm.state.doc.toString() === original, header(tableNamed('Sheds')));

					// 3. Another cell, with one open.
					await press(cm, 'Enter');
					check('Menu 3 the cell is open again', openAt(cm) === '2,2', openAt(cm));
					sheds = tableNamed('Sheds');
					await rightClick(rowsOf(sheds)[3].cells[0]);
					check('Menu 3 a right-click on another cell, with one open, offers the freeze items', freezeItems().join() === names.slice(0, 3).join(), { freeze: freezeItems(), sections: sections() });
					check('Menu 3 chose Freeze rows and columns up to here', await choose(names[2]), items());
					sheds = tableNamed('Sheds');
					check('Menu 3 it freezes up to the right-clicked cell, which is selected, and the open cell closes', header(sheds).includes('%%freeze 4 1%%') && frozenRows(sheds).join() === '0,1,2,3' && at(cm) === '3,0' && !openCell(cm) && cm.hasFocus, { header: header(sheds), at: at(cm), open: openAt(cm) });
					await undo();
					check('Menu 3 Undo takes it back', cm.state.doc.toString() === original, header(tableNamed('Sheds')));

					// 4. A frozen table offers Unfreeze too.
					await press(cm, 'Escape');
					await press(cm, 'Escape');
					let plants = await frozenTable('Plants');
					await rightClick(rowsOf(plants)[3].cells[2]);
					check('Menu 4 on a frozen table, Unfreeze table is offered too', freezeItems().join() === names.join(), freezeItems());
					check('Menu 4 chose Unfreeze table', await choose(names[3]), items());
					plants = tableNamed('Plants');
					check('Menu 4 Unfreeze table takes the mark out, and the right-clicked cell is selected', !header(plants).includes('%%freeze') && !plants.el.classList.contains(FROZEN) && at(cm) === '3,2', { header: header(plants), at: at(cm) });
					await undo();
					check('Menu 4 Undo puts the freeze back', cm.state.doc.toString() === original && tableNamed('Plants').el.classList.contains(FROZEN), header(tableNamed('Plants')));
					await press(cm, 'Escape');
					await press(cm, 'Escape');

					// 5. A text line, with a cell selected in a table below it, where the commands are offered.
					sheds = await frozenTable('Sheds', -200);
					await selectTable(cm, sheds);
					await press(cm, 'Enter');
					// Selecting a table taller than the pane scrolls to its end, so the lines above it come back first.
					cm.scrollDOM.scrollTop += sheds.el.getBoundingClientRect().top - pane().top - 184;
					await frames();
					await sleep(150);
					const textLine = Array.from(cm.contentDOM.querySelectorAll(':scope > .cm-line')).find((el) => {
						const r = el.getBoundingClientRect();
						return el.textContent.startsWith('Line ') && r.top > pane().top + 10 && r.bottom < pane().bottom - 10;
					});
					check('Menu 5 a text line is on screen, with a cell selected', textLine && at(cm) === '0,0', { line: !!textLine, at: at(cm) });
					if (textLine) await rightClick(textLine, textLine.getBoundingClientRect().left + 20);
					check('Menu 5 a right-click on a text line shows Obsidian\'s menu, with no freeze items', items().length > 0 && freezeItems().length === 0, { sections: sections(), freeze: freezeItems() });
					await closeMenu();

					// 6. A range dragged across cells keeps Obsidian's menu for the range.
					sheds = await frozenTable('Sheds');
					const first = rowsOf(sheds)[1].cells[1];
					await click(first);
					first.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 4, button: 0, view: window }));
					await sleep(300);
					sheds = tableNamed('Sheds');
					check('Menu 6 a fourth click selects every cell, as a range', sheds.el.classList.contains('has-selection'), sheds.el.className);
					await rightClick(rowsOf(sheds)[2].cells[2]);
					check('Menu 6 a right-click in a range shows Obsidian\'s menu for the range, with no freeze items', items().length > 0 && freezeItems().length === 0, { sections: sections(), freeze: freezeItems() });
					await closeMenu();
					await closeCell(cm, cm.state.doc.line(sheds.first - 1).from);

					// 7. The handles for dragging a row or a column have menus of their own, for that row or column.
					sheds = await frozenTable('Sheds');
					const handle = rowsOf(sheds)[2].cells[0].querySelector('.table-row-drag-handle');
					if (handle) {
						const { left, top, width, height } = handle.getBoundingClientRect();
						handle.dispatchEvent(new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: 'mouse', button: 2, clientX: left + width / 2, clientY: top + height / 2, view: window }));
						await sleep(300);
					}
					check('Menu 7 a row\'s drag handle keeps Obsidian\'s menu for the row, with no freeze items', handle && items().length > 0 && freezeItems().length === 0, { handle: !!handle, sections: sections(), freeze: freezeItems() });
					await closeMenu();
					check('Menu: the note is as it was', cm.state.doc.toString() === original);
				} finally {
					await closeMenu();
					if (hadNative) config.nativeMenus = nativeBefore;
					else delete config.nativeMenus;
					app.updateUseNativeMenu();
					await restore(cm, original);
				}
			}

			const back = await frozenTable('Plants', 300);
			cm.scrollDOM.scrollTop = cm.scrollDOM.scrollHeight;
			await sleep(400);
			const gone = !back.el.isConnected;
			const returned = await frozenTable('Plants', 300);
			await frames();
			check('Frozen a table that leaves the editor\'s drawn range comes back pinned', gone && returned.el === back.el && Math.abs(topInPane(rowsOf(returned)[0])) <= 1, { gone, same: returned.el === back.el, top: topInPane(rowsOf(returned)[0]) });

			const leafView = app.workspace.getMostRecentLeaf().view;
			await leafView.setState({ ...leafView.getState(), mode: 'source', source: true }, { history: false });
			await sleep(400);
			check('Frozen Source mode leaves the table as text', cm.contentDOM.querySelectorAll(`.${FROZEN}`).length === 0);
			await leafView.setState({ ...leafView.getState(), mode: 'source', source: false }, { history: false });
			await sleep(400);
			const frozenAgain = await frozenTable('Plants');
			check('Frozen back in Live Preview, it\'s frozen again', frozenAgain.el.classList.contains(FROZEN) && frozenRows(frozenAgain).join() === '0,1', frozenAgain.el.className);
			await app.plugins.disablePlugin('selectable-tables');
			await sleep(400);
			const off = frozenAgain.el;
			check('Frozen turning the plugin off takes everything off', !off.classList.contains(FROZEN) && !off.querySelector(`.${ROW}`), off.className);
			await app.plugins.enablePlugin('selectable-tables');
			await sleep(800);
			const on = await frozenTable('Plants');
			check('Frozen turning it on again finds the table', on.el.classList.contains(FROZEN) && frozenRows(on).join() === '0,1', on.el.className);
			check('Frozen: the note is as it was', cm.state.doc.toString() === original);

			// --- A theme's own borders and colors. An invented theme in the manner of one that draws each cell's top
			// and start lines with separate borders, paints the table's body, and stripes the body's odd rows on the row.
			{
				const BODY = 'rgb(236, 238, 230)', STRIPE = 'rgba(255, 255, 255, 0.5)', COLUMN = 'rgba(0, 0, 255, 0.06)', OWN = 'selectable-tables-own-borders';
				const style = getComputedStyle;
				const layersOf = (cell) => style(cell).backgroundImage;
				const pageOf = (t) => style(t.el).getPropertyValue('--selectable-tables-page').trim();
				// What 0.2.0 painted frozen cells with, worked out on an element in the note.
				const primary = () => {
					const probe = document.body.appendChild(document.createElement('div'));
					probe.style.backgroundColor = 'var(--background-primary)';
					const color = style(probe).backgroundColor;
					probe.remove();
					return color;
				};
				const plainLook = await frozenTable('Plants');
				// Rows 10 and 11 are the body's 10th and 11th: even, then odd.
				const [even, odd] = [rowsOf(plainLook)[10].cells[0], rowsOf(plainLook)[11].cells[0]];
				check('Theme 1 in the default theme, frozen cells are the note\'s color with nothing over it, and the table draws its own borders', plainLook.el.classList.contains(OWN) && layersOf(even) === 'none' && layersOf(odd) === 'none' && style(even).backgroundColor === primary() && pageOf(plainLook) === primary(), { classes: plainLook.el.className, even: layersOf(even), odd: layersOf(odd), color: style(even).backgroundColor, page: pageOf(plainLook), primary: primary() });
				check('Theme 1 the first column\'s shadow over the strip beside it is the note\'s color too', style(even).boxShadow.startsWith(`${primary()} -16px`), style(even).boxShadow);
				const theme = document.createElement('style');
				theme.textContent = `
					body .markdown-rendered table { border-collapse: separate; border-spacing: 0; }
					body .markdown-rendered :is(th, td) { border: 0 solid var(--table-border-color); border-top-width: 1px; border-inline-start-width: 1px; }
					body .markdown-rendered table > tbody { background-color: ${BODY}; }
					body .markdown-rendered tbody > tr:nth-child(odd) { background-color: ${STRIPE}; }
					body .markdown-rendered tbody td:nth-child(even) { background-color: ${COLUMN}; }`;
				document.head.append(theme);
				app.workspace.trigger('css-change');
				await frames();
				const themed = await frozenTable('Plants');
				const [evenThemed, oddThemed] = [rowsOf(themed)[10].cells[0], rowsOf(themed)[11].cells[0]];
				check('Theme 2 a theme with separate borders keeps its own lines on frozen cells', !themed.el.classList.contains(OWN) && style(evenThemed).borderTopWidth === '1px' && style(evenThemed).borderLeftWidth === '1px' && style(rowsOf(themed)[0].cells[1]).borderLeftWidth === '1px', { classes: themed.el.className, top: style(evenThemed).borderTopWidth, left: style(evenThemed).borderLeftWidth });
				check('Theme 3 a frozen cell has the body\'s color behind it, and an odd row\'s stripe over that', layersOf(evenThemed).includes(BODY) && !layersOf(evenThemed).includes(STRIPE) && layersOf(oddThemed).indexOf(STRIPE) > -1 && layersOf(oddThemed).indexOf(STRIPE) < layersOf(oddThemed).indexOf(BODY), { even: layersOf(evenThemed), odd: layersOf(oddThemed) });
				check('Theme 3 the header, outside the body, doesn\'t take its color, and a frozen body row does', !layersOf(rowsOf(themed)[0].cells[2]).includes(BODY) && layersOf(rowsOf(themed)[1].cells[2]).includes(STRIPE), { header: layersOf(rowsOf(themed)[0].cells[2]), row: layersOf(rowsOf(themed)[1].cells[2]) });
				const [plainCell, stripedCell] = [layersOf(rowsOf(themed)[1].cells[2]), layersOf(rowsOf(themed)[1].cells[1])];
				check('Theme 3 an even column\'s own color lies over its row\'s, and an odd column has none', !plainCell.includes(COLUMN) && stripedCell.indexOf(COLUMN) > -1 && stripedCell.indexOf(COLUMN) < stripedCell.indexOf(STRIPE), { odd: plainCell, even: stripedCell });
				theme.remove();
				app.workspace.trigger('css-change');
				await frames();
				const back = await frozenTable('Plants');
				check('Theme 4 when the theme changes back, so do frozen tables', back.el.classList.contains(OWN) && layersOf(rowsOf(back)[11].cells[0]) === 'none' && style(rowsOf(back)[10].cells[0]).borderTopWidth === '0px', { classes: back.el.className, odd: layersOf(rowsOf(back)[11].cells[0]) });

				// Light and dark: Obsidian toggles the body's classes, then sends css-change.
				const scheme = app.vault.getConfig('theme');
				let changed = 0;
				const listening = app.workspace.on('css-change', () => changed++);
				const before = style(rowsOf(back)[0].cells[0]).backgroundColor;
				app.changeTheme(document.body.classList.contains('theme-dark') ? 'moonstone' : 'obsidian');
				await sleep(400);
				const flipped = await frozenTable('Plants');
				const after = style(rowsOf(flipped)[0].cells[0]).backgroundColor;
				check('relies 19: switching between light and dark sends css-change', changed > 0, changed);
				check('Theme 5 frozen cells follow light and dark', after !== before && after === primary(), { before, after, primary: primary() });
				app.workspace.offref(listening);
				app.changeTheme(scheme);
				await sleep(400);
				check('Theme: the note is as it was', cm.state.doc.toString() === original);
			}

			// --- A theme that centers tables with flex, as Baseline does with Table width on Auto (Center): its rule, on
			// the class that setting puts on the body, added after the plugin's styles. A control with one class more than
			// the plugin's rule puts plain centering back, as it was before `safe`, to show the check can see the fault.
			{
				const CENTER = 'table-width-fit-center';
				const centering = document.createElement('style');
				centering.textContent = `body.${CENTER} .markdown-source-view.mod-cm6 .cm-table-widget { display: flex; justify-content: center; }`;
				const control = document.createElement('style');
				control.textContent = `body.${CENTER} .markdown-source-view.mod-cm6 .cm-editor.selectable-tables .cm-table-widget.cm-table-widget { justify-content: center; }`;
				// Where a table sits in its box: from the box's start to the table's, and from the table's end to the box's.
				const placeIn = (t) => {
					const w = t.el, cs = getComputedStyle(w), wr = w.getBoundingClientRect(), tr = w.querySelector('table').getBoundingClientRect();
					const start = wr.left + w.clientLeft + parseFloat(cs.paddingLeft), end = wr.left + w.clientLeft + w.clientWidth - parseFloat(cs.paddingRight);
					return { before: tr.left - start, after: end - tr.right, left: tr.left, overflows: w.scrollWidth > w.clientWidth, display: cs.display, justify: cs.justifyContent };
				};
				// Scrolled to its end and back to its start, how far a row's first unfrozen cell sits under its frozen one.
				const underFrozen = async (t, row) => {
					t.el.scrollLeft = 100000;
					await frames();
					t.el.scrollLeft = 0;
					await frames();
					const cells = rowsOf(t)[row].cells;
					return cells[0].getBoundingClientRect().right - cells[1].getBoundingClientRect().left;
				};
				document.head.append(centering);
				document.body.classList.add(CENTER);
				app.workspace.trigger('css-change');
				await frames();
				try {
					const wide = await frozenTable('Plants');
					const at = placeIn(wide);
					const header = await underFrozen(wide, 0), body = await underFrozen(wide, 2);
					const bed = rowsOf(wide)[2].cells[1], bedBox = bed.getBoundingClientRect();
					const shown = document.elementFromPoint(bedBox.left + 3, bedBox.top + 3)?.closest('td, th') === bed;
					check('Center 1 with a theme centering tables with flex, a frozen table wider than its box starts at the box\'s edge', at.display === 'flex' && at.justify === 'safe center' && at.overflows && Math.abs(at.before) < 0.5, at);
					check('Center 1 scrolled right and back, Bed shows in full beside the frozen Name column', header <= 0.5 && body <= 0.5 && shown, { header, body, shown });
					document.head.append(control);
					await frames();
					const plainWide = placeIn(wide), hidden = await underFrozen(wide, 2);
					control.remove();
					await frames();
					check('Center 1 control: with plain centering, its start is out of reach and Bed sits under Name', plainWide.justify === 'center' && plainWide.before < -1 && hidden > 1, { ...plainWide, hidden });
					check('Center: the note is as it was', cm.state.doc.toString() === original);

					cm = await open('Cell moves');
					const small = await tableUnder(cm, 'Seed trays');
					const fits = placeIn(small);
					document.head.append(control);
					await frames();
					const plainSmall = placeIn(small);
					control.remove();
					await frames();
					check('Center 2 a table that fits stays centered, just where plain centering puts it', !fits.overflows && fits.justify === 'safe center' && fits.before > 20 && Math.abs(fits.before - fits.after) <= 1 && Math.abs(fits.left - plainSmall.left) < 0.01, { fits, plainSmall });
				} finally {
					control.remove();
					centering.remove();
					document.body.classList.remove(CENTER);
					app.workspace.trigger('css-change');
					await frames();
				}
				cm = await open('Frozen tables');
			}

			// --- A theme that rounds every cell, as Baseline does. A frozen cell is solid only inside its rounding, so rows
			// passing under a pinned row would show at its corners, unless the row lays what shows there at rest under
			// its cells. The rows are pinned by a real scroll and read back with capturePage, since page state reads
			// right even where the compositor draws rows wrong. Loud body rows, added once the table is read, make
			// anything showing through easy to count. A control takes the rows' shadow off, to show the check sees it.
			{
				const RADIUS = 8;
				const rounding = document.createElement('style');
				rounding.textContent = `
					body .markdown-rendered table { border-collapse: separate; border-spacing: 0; }
					body .markdown-rendered :is(th, td) { border: 1px solid var(--table-border-color); border-radius: ${RADIUS}px; }`;
				const loud = document.createElement('style');
				loud.textContent = `.markdown-rendered tbody tr:not(.${ROW}) > td { background: rgb(255, 0, 255) !important; }`;
				const control = document.createElement('style');
				control.textContent = `.markdown-source-view .cm-table-widget .${ROW} { box-shadow: none !important; }`;
				const contents = window.electron.remote.getCurrentWebContents();
				// Loud pixels as drawn, in a square the rounding's size at each corner of each header cell in the widget's view.
				const showing = async (t) => {
					const image = await contents.capturePage();
					const { width, height } = image.getSize();
					const scale = width / window.innerWidth, bitmap = image.toBitmap();
					const view = t.el.getBoundingClientRect();
					let count = 0;
					for (const cell of rowsOf(t)[0].cells) {
						const r = cell.getBoundingClientRect();
						if (r.left < view.left || r.right > view.right) continue;
						for (const [left, top] of [[r.left, r.top], [r.right - RADIUS, r.top], [r.left, r.bottom - RADIUS], [r.right - RADIUS, r.bottom - RADIUS]]) {
							for (let y = Math.round(top * scale); y < Math.round((top + RADIUS) * scale) && y < height; y++) {
								for (let x = Math.round(left * scale); x < Math.round((left + RADIUS) * scale) && x < width; x++) {
									// BGRA
									const i = (y * width + x) * 4;
									if (bitmap[i + 2] > 200 && bitmap[i + 1] < 80 && bitmap[i] > 200) count++;
								}
							}
						}
					}
					return count;
				};
				document.head.append(rounding);
				app.workspace.trigger('css-change');
				await frames();
				try {
					const tools = await frozenTable('Tools', -100);
					document.head.append(loud);
					await frames();
					const box = pane();
					await cdp.sendCommand('Input.synthesizeScrollGesture', { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), xDistance: 0, yDistance: -400, speed: 1500, gestureSourceType: 'mouse', preventFling: true });
					await sleep(300);
					await frames(4);
					const header = rowsOf(tools)[0];
					const pinned = { top: topInPane(header), past: -topInPane(tools.el), radius: getComputedStyle(header.cells[2]).borderTopRightRadius };
					const leaks = await showing(tools);
					check('Corners 1 with a theme rounding every cell, rows scrolled under the pinned header don\'t show at its corners', Math.abs(pinned.top) <= 1 && pinned.past > 200 && pinned.radius === `${RADIUS}px` && leaks === 0, { ...pinned, leaks });
					document.head.append(control);
					await frames(4);
					const shown = await showing(tools);
					check('Corners 1 control: without the rows\' shadow, they do', shown > 0, shown);
				} finally {
					control.remove();
					loud.remove();
					rounding.remove();
					app.workspace.trigger('css-change');
					await frames();
				}
				check('Corners: the note is as it was', cm.state.doc.toString() === original);
			}

			// --- On a phone. Obsidian's own classes on the real editor; emulate-mobile gives a status bar of 59 px.
			const PHONE = ['is-mobile', 'is-phone', 'is-floating-nav', 'auto-full-screen', 'emulate-mobile'];
			const STATUS_BAR = 59;
			const reload = async () => {
				await app.plugins.disablePlugin('selectable-tables');
				await sleep(400);
				await app.plugins.enablePlugin('selectable-tables');
				await sleep(800);
			};
			// A phone shows only tabs marked mod-visible, which a desktop's aren't.
			const tabs = app.workspace.getMostRecentLeaf().containerEl.closest('.workspace-tabs');
			try {
				tabs.classList.add('mod-visible');
				document.body.classList.add(...PHONE);
				await sleep(500);
				// A key pressed with the pane hidden would land in the note's text.
				if (!pane().height) throw new Error('the pane is hidden, so the phone\'s layout can\'t be checked');
				const phone = await frozenTable('Plants', 500);
				const header = app.workspace.getMostRecentLeaf().view.containerEl.closest('.workspace-leaf-content').querySelector('.view-header');
				const rowTop = () => topInPane(rowsOf(phone)[0]);
				const headerBottom = () => header.getBoundingClientRect().bottom - pane().top;
				check('relies 17: on a phone a note runs under the floating header, from the top of the pane', getComputedStyle(header).position === 'fixed' && header.getBoundingClientRect().top >= pane().top && parseFloat(getComputedStyle(cm.scrollDOM).paddingTop) >= STATUS_BAR, { position: getComputedStyle(header).position, padding: getComputedStyle(cm.scrollDOM).paddingTop });
				check('Phone 1 with the header showing, rows pin just below it', Math.abs(rowTop() - (headerBottom() + 12)) <= 1, { row: rowTop(), header: headerBottom() });
				const held = rowTop();
				cm.scrollDOM.scrollTop += 300;
				await frames();
				check('Phone 1 they hold there as the note scrolls', Math.abs(rowTop() - held) <= 1, { held, row: rowTop() });
				document.body.classList.add('is-hidden-nav');
				await sleep(500);
				check('Phone 1 with the header hidden, rows pin below the status bar', Math.abs(rowTop() - STATUS_BAR) <= 1, rowTop());
				cm.scrollDOM.scrollTop += 300;
				await frames();
				check('Phone 1 they hold there as the note scrolls', Math.abs(rowTop() - STATUS_BAR) <= 1, rowTop());
				// The keyboard shrinks the pane, and the rows start their animation again then, still pinned.
				const running = rowsOf(phone)[0].getAnimations()[0];
				const fullHeight = pane().height;
				document.body.style.setProperty('--keyboard-height', '300px');
				await sleep(300);
				const shrunk = pane().height;
				const restarted = rowsOf(phone)[0].getAnimations()[0];
				cm.scrollDOM.scrollTop += 200;
				await frames();
				check('relies 18: on a phone the keyboard shrinks the pane by --keyboard-height', fullHeight - shrunk >= 250, { fullHeight, shrunk });
				check('Phone 1 a keyboard moving restarts the rows, and they stay pinned', restarted !== running && restarted?.animationName === 'selectable-tables-pin' && !document.querySelector('.selectable-tables-restarting') && Math.abs(rowTop() - STATUS_BAR) <= 1, { restarted: restarted !== running, name: restarted?.animationName, row: rowTop() });
				document.body.style.removeProperty('--keyboard-height');
				await sleep(300);
				const band = getComputedStyle(rowsOf(phone)[0].cells[1], '::before');
				check('Phone 2 the band above them is filled, and takes no presses', band.height === `${STATUS_BAR}px` && band.pointerEvents === 'none' && band.backgroundColor !== 'rgba(0, 0, 0, 0)', { height: band.height, events: band.pointerEvents, color: band.backgroundColor });
				cm.scrollDOM.scrollTop = 0;
				await frames();
				const arriving = await frozenTable('Plants', -120);
				const padded = rowsOf(arriving)[0].cells[1].getBoundingClientRect().top - arriving.el.getBoundingClientRect().top;
				check('Phone 2 with the table not yet pinned, the table\'s box clips the band, so it can\'t cover the text above', padded < STATUS_BAR && getComputedStyle(arriving.el).overflowY === 'hidden' && getComputedStyle(arriving.el).contain.includes('paint'), { padded, overflow: getComputedStyle(arriving.el).overflowY, contain: getComputedStyle(arriving.el).contain });

				const held2 = await frozenTable('Plants', 700);
				await selectTable(cm, held2);
				await press(cm, 'Enter');
				await keys(cm, held2, ...repeat('ArrowDown', 20), 'ArrowRight', 'ArrowRight');
				await placeBelow(held2, selectedCell());
				const climbing = [];
				for (let i = 0; i < 4; i++) {
					await press(cm, 'ArrowUp');
					climbing.push(inView(selectedCell()));
				}
				check('Phone 3 a selected cell moving ↑ stays clear of rows pinned below the status bar', at(cm) === '16,2' && climbing.every(Boolean), { at: at(cm), climbing });
				await keys(cm, held2, ...repeat('ArrowUp', 16));
				await sleep(200);
				check('Phone 3 ↑ on the top row takes the table back to where rows pin', at(cm) === '0,2' && Math.abs(topInPane(held2.el) - STATUS_BAR) <= 1, { at: at(cm), top: topInPane(held2.el) });
				await press(cm, 'Escape');
				await press(cm, 'Escape');
			} finally {
				document.body.classList.remove(...PHONE, 'is-hidden-nav');
				tabs.classList.remove('mod-visible');
				await sleep(300);
				await restore(cm, original);
			}
			const notPhone = await frozenTable('Plants', 300);
			check('Phone off a phone, rows pin at the pane\'s top', Math.abs(topInPane(rowsOf(notPhone)[0])) <= 1, topInPane(rowsOf(notPhone)[0]));
			const desktopRunning = rowsOf(notPhone)[0].getAnimations()[0];
			const container = document.querySelector('.app-container');
			container.style.maxHeight = 'calc(100vh - 300px)';
			await sleep(300);
			const desktopAfter = rowsOf(notPhone)[0].getAnimations()[0];
			container.style.removeProperty('max-height');
			await sleep(300);
			check('Phone off a phone, a shorter pane doesn\'t restart the rows', desktopAfter === desktopRunning, { same: desktopAfter === desktopRunning });

			// --- A device that can't pin rows
			const supports = CSS.supports;
			try {
				CSS.supports = (...args) => (String(args[0]).includes('animation-timeline') ? false : supports.apply(CSS, args));
				await reload();
				const scrolled = await frozenTable('Plants', 300);
				check('No pinning: nothing is marked, so columns don\'t pin without rows', !scrolled.el.classList.contains(FROZEN) && frozenRows(scrolled).length === 0 && getComputedStyle(rowsOf(scrolled)[1].cells[0]).position === 'relative' && !scrolled.el.querySelector('.selectable-tables-tint-cover'), scrolled.el.className);
				check('No pinning: the table scrolls as usual, with its usual borders', topInPane(rowsOf(scrolled)[0]) < -100 && getComputedStyle(scrolled.el.querySelector('table')).borderCollapse === 'collapse', { row: topInPane(rowsOf(scrolled)[0]) });
				check('No pinning: the mark still doesn\'t show', rowsOf(scrolled)[0].cells[0].textContent.trim() === 'Name', rowsOf(scrolled)[0].cells[0].textContent);
				const squeezed = await squeeze(scrolled);
				check('No pinning: the mark\'s cell is still marked, and one line in a squeezed column', squeezed && markCells(scrolled) === '0' && linesIn(rowsOf(scrolled)[0].cells[0]) === 1, { squeezed, marked: markCells(scrolled), lines: linesIn(rowsOf(scrolled)[0].cells[0]) });
				await unsqueeze(scrolled);
				await selectTable(cm, scrolled);
				await press(cm, 'Enter');
				await keys(cm, scrolled, 'ArrowDown', 'ArrowRight');
				check('No pinning: the table\'s keys still work', at(cm) === '1,1', at(cm));
				await press(cm, 'Escape');
				await press(cm, 'Escape');
			} finally {
				CSS.supports = supports;
				await reload();
				await restore(cm, original);
			}
			const pinsAgain = await frozenTable('Plants');
			check('No pinning: on a device that can, it freezes', pinsAgain.el.classList.contains(FROZEN) && frozenRows(pinsAgain).join() === '0,1', pinsAgain.el.className);
			check('Phone: the note is as it was', cm.state.doc.toString() === original);
		}
		}

		// --- Own table (preview builds only): the plugin draws Live Preview tables itself, behind its switch. Run
		// alone with window.__checkOwnOnly = true, and its cells' section alone with window.__checkCellsOnly = true too;
		// with window.__checkFrozenCellsOnly as well, only the section on its frozen tables' cells, and with
		// window.__checkEditsOnly instead, only the section on editing its rows and columns.
		// The note texts are put back as they were, and so is the switch.
		const preview = app.plugins.plugins['selectable-tables']?.preview;
		if (preview) {
			const frames = async (n = 2) => {
				for (let i = 0; i < n; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
			};
			const crashed = (view) => view.plugins.filter((plugin) => !plugin.spec).length;
			const spansOf = (list) => (list ?? []).map(({ from, to }) => `${from}-${to}`).join(' ');
			const models = (view) => preview.models(view);
			// The plugin's blocks: a table's one block, or the blocks in the box around a longer table's.
			const ownBoxes = (view) => view.contentDOM.querySelectorAll(':scope > .cm-table-widget.selectable-tables-own, :scope > .selectable-tables-blocks > .selectable-tables-own');
			const obsidianBoxes = (view) => view.contentDOM.querySelectorAll(':scope > .cm-table-widget:not(.selectable-tables-own, .selectable-tables-blocks)');
			// A table's first block, which holds its header, and the blocks in the page.
			const firstBox = (model) => model.boxes[0];
			const shownBoxes = (model) => model.boxes.filter((box) => box.isConnected);
			// Obsidian's own table objects among the editor's decorations, its Live Preview's included.
			const obsidianObjects = (view) => {
				let found = 0;
				for (const source of view.state.facet(view.constructor.decorations)) {
					const set = typeof source === 'function' ? source(view) : source;
					set?.between?.(0, view.state.doc.length, (from, to, deco) => {
						const widget = deco.spec?.widget;
						if (widget && typeof widget.receiveSelection === 'function' && typeof widget.placeCursorAround === 'function') found++;
					});
				}
				return found;
			};
			// Every drawn row shows its own line: the text it was drawn from is that line's now.
			const rowsRight = (view) => {
				const wrong = [];
				for (const model of models(view)) {
					if (!model.shown) continue;
					const header = view.state.doc.lineAt(model.from).number;
					for (const { row, tr, text } of model.drawnRows()) {
						if (!tr.isConnected) continue;
						const line = header + 2 + row;
						if (row >= model.count || line > view.state.doc.lines || view.state.doc.line(line).text !== text) wrong.push(`${model.from}:${row}`);
					}
				}
				return wrong;
			};
			// The tables kept as the note changed are the tables found from scratch.
			const keptRight = (view) => spansOf(models(view)) === spansOf(preview.scan(view.state));
			// Drawn spans of Obsidian's own tables, scrolling the whole note through, as the switch-off reference.
			async function drawnSpans(view) {
				const spans = new Set();
				view.scrollDOM.scrollTop = 0;
				await sleep(300);
				for (let i = 0; i < 400; i++) {
					for (const el of obsidianBoxes(view)) {
						const block = view.lineBlockAt(view.posAtDOM(el));
						spans.add(`${block.from}-${block.to}`);
					}
					const before = view.scrollDOM.scrollTop;
					view.scrollDOM.scrollTop += view.scrollDOM.clientHeight / 2;
					await sleep(120);
					if (view.scrollDOM.scrollTop === before) break;
				}
				return [...spans].sort((a, b) => parseInt(a) - parseInt(b)).join(' ');
			}
			const notes = app.vault.getMarkdownFiles().map((file) => file.basename).filter((name) => !/Test Plan$/.test(name)).sort();
			const small = notes.filter((name) => app.vault.getAbstractFileByPath(`${name}.md`).stat.size < 60000);
			try {
				// Every own-table section before the cells', which window.__checkCellsOnly skips.
				earlier: {
				if (window.__checkCellsOnly) break earlier;
				// Switch off: Obsidian's tables, drawn, against where its parser puts them.
				preview.use(false);
				await sleep(400);
				const reference = {};
				for (const name of small) {
					const view = await open(name);
					reference[name] = await drawnSpans(view);
				}
				const parsedRuns = {};
				const someNote = await open('Watering schedule');
				for (const name of notes) parsedRuns[name] = preview.runs(await app.vault.cachedRead(app.vault.getAbstractFileByPath(`${name}.md`)), someNote);
				check('Own 0: Obsidian draws its tables where its parser puts them', small.every((name) => reference[name] === spansOf(parsedRuns[name].obsidian)), Object.fromEntries(small.map((name) => [name, { drawn: reference[name], parsed: spansOf(parsedRuns[name].obsidian) }])));
				check('Own 0: the language copy marks the same lines as tables as Obsidian\'s, in every note', notes.every((name) => spansOf(parsedRuns[name].obsidian) === spansOf(parsedRuns[name].copy)), Object.fromEntries(notes.map((name) => [name, [spansOf(parsedRuns[name].obsidian), spansOf(parsedRuns[name].copy)]])));

				// Switch on: the same tables, drawn by the plugin, and none of Obsidian's.
				preview.use(true);
				await sleep(500);
				const same = {};
				const kept = {};
				let objects = 0;
				let boxes = 0;
				for (const name of notes) {
					const view = await open(name);
					preview.forceParse(view);
					await sleep(name === 'Table 2000 by 12' ? 1500 : 300);
					same[name] = { drawn: spansOf(models(view)), obsidian: spansOf(parsedRuns[name].obsidian) };
					kept[name] = keptRight(view);
					objects += obsidianObjects(view);
					boxes += obsidianBoxes(view).length;
					check(`Own 1 ${name}: nothing crashed`, crashed(view) === 0, crashed(view));
				}
				check('Own 1: in every note, the plugin draws the tables Obsidian does, from the same start to the same end', notes.every((name) => same[name].drawn === same[name].obsidian), same);
				check('Own 1: Obsidian builds no table of its own with the switch on', objects === 0 && boxes === 0, { objects, boxes });
				check('Own 1: the tables kept as the note was read are the tables found from scratch', Object.values(kept).every(Boolean), kept);

				// The large table: rows land right and columns hold, at its top, its middle and its end.
				let view = await open('Table 2000 by 12');
				let [big] = models(view);
				// The columns' widths, from a row drawn near the pane: the header's block is in the page only at the table's top.
				const widthsAt = () => {
					const drawn = big.drawnRows().find(({ tr }) => tr.isConnected);
					return drawn ? [...drawn.tr.cells].map((cell) => Math.round(cell.getBoundingClientRect().width * 100) / 100).join(',') : '';
				};
				const places = {};
				for (const [place, row] of [['top', 0], ['middle', 1000], ['end', 1997]]) {
					const line = view.state.doc.lineAt(big.from).number + 2 + row;
					view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.line(line).from, { y: 'center' }) });
					await sleep(600);
					await frames(3);
					[big] = models(view);
					const drawn = big.drawnRows().filter(({ tr }) => tr.isConnected);
					const labels = drawn.every(({ row, tr }) => tr.cells[0].innerText.trim() === `Row ${row + 1}`);
					const target = drawn.find((entry) => entry.row === row);
					const pane = view.scrollDOM.getBoundingClientRect();
					const onScreen = target && target.tr.getBoundingClientRect().bottom > pane.top && target.tr.getBoundingClientRect().top < pane.bottom;
					// A screen reader hears each drawn row's place in the whole table, and skips the rows that only hold room.
					const numbered = drawn.every(({ row, tr }) => tr.getAttribute('aria-rowindex') === String(row + 2));
					const spacers = shownBoxes(big).flatMap((box) => [...box.querySelectorAll('tbody tr.selectable-tables-spacer')]);
					const hidden = spacers.every((tr) => tr.getAttribute('aria-hidden') === 'true');
					const count = shownBoxes(big).every((box) => box.querySelector('table').getAttribute('aria-rowcount') === String(big.count + 1)) && firstBox(big).querySelector('thead tr')?.getAttribute('aria-rowindex') === '1';
					places[place] = { rows: drawn.length, labels, wrong: rowsRight(view), onScreen: !!onScreen, widths: widthsAt(), numbered, hidden, count };
				}
				check('Own 2: the rows drawn at the large table\'s top, middle and end show their own lines', Object.values(places).every((p) => p.rows > 0 && p.labels && !p.wrong.length && p.onScreen), places);
				check('Own 2: no column changes width from the table\'s top to its end', places.top.widths === places.middle.widths && places.top.widths === places.end.widths, places);
				check('Own 2: each drawn row gives its row number and the table its row count, and the filler rows are hidden from screen readers', Object.values(places).every((p) => p.numbered && p.hidden && p.count), places);
				// Joined borders belong to the whole table, so each row added would repaint all of it: the cells draw their own.
				const joined = (() => {
					const probe = createDiv({ cls: 'cm-embed-block cm-table-widget markdown-rendered' });
					probe.createDiv('table-wrapper').createEl('table', { cls: 'table-editor' });
					view.contentDOM.parentElement.appendChild(probe);
					const value = getComputedStyle(probe.querySelector('table')).borderCollapse;
					probe.remove();
					return value === 'collapse';
				})();
				const ownTable = shownBoxes(big)[0].querySelector('table');
				check('Own 2: where the theme joins borders, the cells draw their own, as a frozen table\'s do', !joined || (big.boxes.every((box) => box.classList.contains('selectable-tables-own-borders')) && getComputedStyle(ownTable).borderCollapse === 'separate'), { joined, classes: shownBoxes(big)[0].className, collapse: getComputedStyle(ownTable).borderCollapse });

				// The note holds while rows above the pane take their real heights, scrolling up through rows not drawn.
				for (const skew of [0, 0.4]) {
					preview.skew(skew);
					await open('Blank');
					view = await open('Table 2000 by 12');
					[big] = models(view);
					const end = view.state.doc.lineAt(big.to).number;
					view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.line(end - 5).from, { y: 'end' }) });
					await sleep(800);
					let worst = 0;
					const moves = [];
					const seams = new Set();
					for (let step = 0; step < 40; step++) {
						[big] = models(view);
						const pane = view.scrollDOM.getBoundingClientRect();
						const middle = big
							.drawnRows()
							.filter(({ tr }) => tr.isConnected)
							.sort((a, b) => a.row - b.row)
							.find(({ tr }) => tr.getBoundingClientRect().top > pane.top + pane.height / 2);
						if (!middle) break;
						const before = middle.tr.getBoundingClientRect().top;
						view.scrollDOM.scrollTop -= 300;
						await frames(4);
						await sleep(60);
						if (!middle.tr.isConnected) continue;
						const moved = middle.tr.getBoundingClientRect().top - before;
						moves.push(Math.round(moved * 10) / 10);
						worst = Math.max(worst, Math.abs(moved - 300));
						seams.add(Math.floor(middle.row / 100));
					}
					// Part B's limit is 1 px, across the seams between blocks of 100 rows.
					check(`Own 3 scrolling up through rows not yet drawn and across seams, estimates off by ${skew * 100}%: a row on screen moves at most 1 px more than the scroll`, moves.length > 20 && seams.size > 2 && worst <= 1, { worst, seams: [...seams], moves });
				}
				preview.skew(0);
				await open('Blank');

				// A press on a cell selects the whole table, tinted, with no caret; typing over it does nothing.
				view = await open('Table 50 by 8');
				const original = view.state.doc.toString();
				let [table] = models(view);
				view.dispatch({ effects: view.constructor.scrollIntoView(table.from, { y: 'start' }) });
				await sleep(400);
				[table] = models(view);
				// Beside the cells: a press on a cell opens it (STA-81).
				const cell = firstBox(table);
				await click(cell);
				const chosen = view.state.selection.main;
				check('Own 4: a press beside the cells selects the whole table, tinted, framed, with no caret', chosen.from === table.from && chosen.to === table.to && firstBox(table).classList.contains('is-selected') && view.dom.classList.contains('selectable-tables-selected') && getComputedStyle(view.dom.querySelector('.cm-cursorLayer')).display === 'none', { chosen: [chosen.from, chosen.to], table: [table.from, table.to] });
				view.dispatch({ ...view.state.replaceSelection('x'), userEvent: 'input.type' });
				await settle();
				check('Own 4: typing over the selected table does nothing', view.state.doc.toString() === original);
				view.dispatch({ selection: { anchor: 0 } });
				await settle();
				check('Own 4: the tint goes with the selection', !firstBox(table).classList.contains('is-selected') && !view.dom.classList.contains('selectable-tables-selected'));

				// A key typed on the selected table starts a paragraph below it, with the text, and leaves the table.
				await click(cell);
				await realType('y');
				await sleep(200);
				const typedBelow = view.state.doc.toString();
				const afterTable = typedBelow.slice(table.to);
				check('Own 4: a key typed on the selected table starts a paragraph below it, and the table stays', typedBelow.slice(0, table.to) === original.slice(0, table.to) && /^\n\ny\n/.test(afterTable), JSON.stringify(afterTable.slice(0, 12)));
				await restore(view, original);

				// A link in a cell opens its note, and the table stays as it is.
				view = await open('Markdown in cells');
				[table] = models(view);
				const link = firstBox(table).querySelector('a.internal-link');
				link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, view: window }));
				await sleep(500);
				check('Own 5: a link in a cell opens its note', app.workspace.getActiveFile()?.basename === 'Watering schedule', app.workspace.getActiveFile()?.basename);

				// Edits from anywhere: seeded random edits, undo and redo, each checked against the text.
				view = await open('Table 50 by 8');
				const editor = app.workspace.activeEditor.editor;
				let seed = 86;
				const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
				const inserts = ['x', 'Wide text for a cell ', '\n', ' | ', '\n| New | row | here | a | b | c | d | e |', '|', ''];
				const steps = [];
				let bad = null;
				for (let step = 0; step < 60 && !bad; step++) {
					const doc = view.state.doc;
					const kind = random();
					if (kind < 0.15 && steps.length) {
						editor.undo();
						steps.push('undo');
					} else if (kind < 0.2) {
						editor.redo();
						steps.push('redo');
					} else {
						// Mostly in or around the table.
						const [m] = models(view);
						const lo = m ? Math.max(0, m.from - 40) : 0;
						const hi = m ? Math.min(doc.length, m.to + 40) : doc.length;
						const from = Math.floor(lo + random() * (hi - lo));
						const to = Math.min(doc.length, from + Math.floor(random() * 30));
						const insert = inserts[Math.floor(random() * inserts.length)];
						view.dispatch({ changes: { from, to, insert }, userEvent: random() < 0.5 ? 'input.type' : 'delete' });
						steps.push([from, to, insert]);
					}
					await frames(3);
					await sleep(30);
					if (crashed(view) || !keptRight(view) || rowsRight(view).length) bad = { step, crashed: crashed(view), kept: [spansOf(models(view)), spansOf(preview.scan(view.state))], rows: rowsRight(view), steps: steps.slice(-5) };
				}
				check('Own 6: after each of 60 random edits, undos and redos, the tables are found right and every drawn row shows its line', !bad, bad);
				await restore(view, original);

				// Whole rows added and taken out in the middle of the rows drawn, in the large table, then undone.
				view = await open('Table 2000 by 12');
				const bigText = view.state.doc.toString();
				[big] = models(view);
				const midLine = view.state.doc.lineAt(big.from).number + 2 + 1000;
				view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.line(midLine).from, { y: 'center' }) });
				await sleep(600);
				const cells = (label) => `| ${[label, ...Array(11).fill('x')].join(' | ')} |`;
				const rowEdits = [];
				let rowsBad = null;
				const afterEdit = async (what) => {
					await frames(3);
					await sleep(80);
					rowEdits.push(what);
					if (!rowsBad && (crashed(view) || !keptRight(view) || rowsRight(view).length)) rowsBad = { what, crashed: crashed(view), kept: keptRight(view), rows: rowsRight(view) };
				};
				view.dispatch({ changes: { from: view.state.doc.line(midLine).from, insert: `${cells('New A')}\n${cells('New B')}\n` }, userEvent: 'input.paste' });
				await afterEdit('two rows added');
				view.dispatch({ changes: { from: view.state.doc.line(midLine + 5).from, to: view.state.doc.line(midLine + 8).from }, userEvent: 'delete' });
				await afterEdit('three rows taken out');
				view.dispatch({ changes: { from: view.state.doc.line(midLine - 3).to, insert: `\n${cells('New C')}` }, userEvent: 'input.type' });
				await afterEdit('a row added at a line\'s end');
				const bigEditor = app.workspace.activeEditor.editor;
				for (let i = 0; i < 3; i++) {
					bigEditor.undo();
					await afterEdit('undo');
				}
				check('Own 6: whole rows added and taken out in the middle of the rows drawn, then undone, draw right and crash nothing', !rowsBad && view.state.doc.toString() === bigText, rowsBad ?? { restored: view.state.doc.toString() === bigText });
				await restore(view, bigText);

				// Select All then Delete, and Undo: the tables go and come back, and nothing crashes.
				view = await open('Markdown in cells');
				const cellsText = view.state.doc.toString();
				view.dispatch({ changes: { from: 0, to: view.state.doc.length }, userEvent: 'delete' });
				await frames(3);
				const emptied = { tables: models(view).length, crashed: crashed(view), text: view.state.doc.length };
				app.workspace.activeEditor.editor.undo();
				await sleep(400);
				check('Own 6: deleting the whole note takes its tables, and Undo brings them back, with nothing crashed', emptied.tables === 0 && emptied.text === 0 && !emptied.crashed && view.state.doc.toString() === cellsText && models(view).length === 3 && keptRight(view) && !crashed(view), { emptied, after: models(view).length });
				await restore(view, cellsText);

				// A second pane edits in Source mode: this pane's table follows as it types.
				view = await open('Table 50 by 8');
				[table] = models(view);
				const second = app.workspace.getLeaf('split', 'vertical');
				await second.openFile(app.vault.getAbstractFileByPath('Table 50 by 8.md'), { state: { mode: 'source', source: true } });
				await sleep(500);
				const other = second.view.editor.cm;
				const rowTen = view.state.doc.lineAt(table.from).number + 2 + 9;
				view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.line(rowTen).from, { y: 'center' }) });
				await sleep(500);
				const widthBefore = firstBox(models(view)[0]).querySelector('thead th:nth-child(1)').getBoundingClientRect().width;
				const at = other.state.doc.line(rowTen);
				const pipe = at.text.indexOf('|', 1);
				// A long word, since this table's columns are already as narrow as their longest words.
				other.dispatch({ changes: { from: at.from + pipe - 1, insert: ' and Averyveryverylongwordthatwidensitscolumn' }, userEvent: 'input.type' });
				await sleep(400);
				await frames(3);
				[table] = models(view);
				const drawnTen = table.drawnRows().find(({ row }) => row === 9);
				check('Own 7: an edit in a second pane shows in this pane\'s table as it\'s typed, and its column widens', drawnTen?.tr.isConnected && drawnTen.tr.cells[0].innerText.includes('widensitscolumn') && firstBox(table).querySelector('thead th:nth-child(1)').getBoundingClientRect().width > widthBefore && !rowsRight(view).length, { text: drawnTen?.tr.cells[0].innerText });
				const count = table.count;
				other.dispatch({ changes: { from: other.state.doc.line(view.state.doc.lineAt(table.to).number).to, insert: '\n| Row 50 | added | in | the | other | pane | x | y |' }, userEvent: 'input.type' });
				await sleep(400);
				check('Own 7: a row added in the second pane shows in this one', models(view)[0].count === count + 1 && keptRight(view), { count: models(view)[0].count });
				second.detach();
				await sleep(300);
				await restore(view, original);

				// A narrower pane refits the columns, and a wider one brings them back: two more panes beside this one.
				view = await open('Markdown in cells');
				const widths = () => models(view).map((model) => firstBox(model)?.querySelector('table')?.style.width).join(' ');
				const wide = widths();
				const panes = [app.workspace.getLeaf('split', 'vertical'), app.workspace.getLeaf('split', 'vertical')];
				await sleep(800);
				const narrow = widths();
				for (const pane of panes) pane.detach();
				await sleep(800);
				check('Own 8: a narrower pane refits the columns, and a wider one brings them back', narrow !== wide && widths() === wide, { wide, narrow, back: widths() });

				// A freeze mark draws nothing, and its header cell takes the class that keeps it one line.
				view = await open('Frozen tables');
				[table] = models(view);
				view.dispatch({ effects: view.constructor.scrollIntoView(table.from, { y: 'start' }) });
				await sleep(400);
				[table] = models(view);
				const head = firstBox(table).querySelector('thead tr');
				const body = firstBox(table).querySelector('tbody tr:not(.selectable-tables-spacer)');
				check('Own 9: a frozen table draws unfrozen, its marked header cell keeps the mark\'s class, and the header row is no taller than a body row', !firstBox(table).classList.contains('selectable-tables-frozen') && head.querySelector('.selectable-tables-mark-cell') && !head.innerText.includes('%%') && head.getBoundingClientRect().height <= body.getBoundingClientRect().height + 1, { head: head.getBoundingClientRect().height, body: body.getBoundingClientRect().height });

				// Part B: a table of more than 100 rows is drawn as a block per 100 rows, in one box around them.
				view = await open('Table 2000 by 12');
				[big] = models(view);
				const lineOfRow = (row) => view.state.doc.lineAt(big.from).number + 2 + row;
				const toRow = async (row, y = 'center') => {
					view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.line(lineOfRow(row)).from, { y }) });
					await sleep(600);
					await frames(3);
					[big] = models(view);
				};
				const drawnRow = (row) => big.drawnRows().find((entry) => entry.row === row && entry.tr.isConnected)?.tr;
				await toRow(100);
				const blockBox = shownBoxes(big)[0]?.parentElement;
				const layout = {
					blocks: big.blockCount,
					inOneBox: shownBoxes(big).every((box) => box.parentElement === blockBox),
					boxClasses: !!blockBox && ['cm-embed-block', 'cm-table-widget', 'markdown-rendered', 'selectable-tables-blocks'].every((name) => blockBox.classList.contains(name)),
					shown: shownBoxes(big).length,
					boxes: view.contentDOM.querySelectorAll(':scope > .selectable-tables-blocks').length,
				};
				check('Own 12: the large table is drawn as a block per 100 rows, in one box with the classes of Obsidian\'s table box, and only the blocks near the pane are in the page', layout.blocks === 20 && layout.inOneBox && layout.boxClasses && layout.shown >= 1 && layout.shown < 6 && layout.boxes === 1, layout);

				// Seams: rows on either side of a seam meet as rows within a block do, their cells line up, and every row
				// keeps its odd or even place, and the table's first and last rows theirs, in each theme there is.
				const seamAt = (seam) => {
					const [a, b, c, d] = [seam - 2, seam - 1, seam, seam + 1].map(drawnRow);
					if (!a || !b || !c || !d) return { missing: true };
					const box = (tr) => tr.getBoundingClientRect();
					const within = box(b).top - box(a).bottom;
					const across = box(c).top - box(b).bottom;
					const after = box(d).top - box(c).bottom;
					const cells = [...b.cells].every((cell, i) => Math.abs(cell.getBoundingClientRect().left - c.cells[i].getBoundingClientRect().left) <= 1 && Math.abs(cell.getBoundingClientRect().right - c.cells[i].getBoundingClientRect().right) <= 1);
					const style = (tr, side) => getComputedStyle(tr.cells[1])[`border${side}Width`];
					const borders = style(b, 'Bottom') === style(a, 'Bottom') && style(c, 'Top') === style(d, 'Top');
					const shade = (tr) => getComputedStyle(tr.cells[1]).backgroundColor;
					const stripes = shade(a) === shade(c) && shade(b) === shade(d);
					return { ok: Math.abs(across - within) <= 1 && Math.abs(after - within) <= 1 && cells && borders && stripes, within, across, after, cells, borders, stripes };
				};
				const inPlace = () => big.drawnRows().filter(({ tr }) => tr.isConnected).every(({ row, tr }) => tr.matches(':nth-child(odd)') === (row % 2 === 0) && tr.matches(':first-child') === (row === 0) && tr.matches(':last-child') === (row === big.count - 1));
				const themeWas = app.customCss.theme;
				// Baseline's Table width setting at Auto (Center) makes a table's box a flex row; its blocks still stack.
				const themes = [['', ''], ['Minimal', ''], ['Baseline', ''], ['Baseline', 'table-width-fit-center']].filter(([name]) => !name || app.customCss.themes[name]);
				const stacked = () => {
					const boxes = shownBoxes(big).map((box) => box.getBoundingClientRect());
					return boxes.every((box, i) => i === 0 || (box.top >= boxes[i - 1].bottom - 1 && Math.abs(box.left - boxes[i - 1].left) < 1));
				};
				const seams = {};
				try {
					for (const [name, setting] of themes) {
						app.customCss.setTheme(name);
						document.body.toggleClass('table-width-fit-center', !!setting);
						await sleep(1200);
						view = await open('Table 2000 by 12');
						const found = {};
						for (const seam of [100, 200, 1900]) {
							await toRow(seam);
							found[seam] = { ...seamAt(seam), places: inPlace(), stacked: stacked() };
						}
						await toRow(0, 'start');
						found.ends = inPlace();
						await toRow(big.count - 1, 'end');
						found.ends = found.ends && inPlace();
						seams[[name || 'default', setting].filter(Boolean).join(' ')] = found;
					}
				} finally {
					document.body.removeClass('table-width-fit-center');
					app.customCss.setTheme(themeWas);
					await sleep(800);
				}
				check(`Own 13: seams between blocks look as rows within one block do, in ${Object.keys(seams).join(', ')}`, Object.values(seams).every((found) => found.ends && [100, 200, 1900].every((seam) => found[seam].ok && found[seam].places && found[seam].stacked)), seams);

				// Sideways, on a computer (STA-79): no box scrolls the table. A scrollbar of the plugin's own, in the note's
				// scroller, moves every block's table by a transform, and a sideways swipe over the table is passed on to it.
				view = await open('Table 2000 by 12');
				await toRow(100);
				const pane = () => view.scrollDOM.getBoundingClientRect();
				const barOf = () => big.sideways().bar;
				// Where row 100's first cell sits against its box: how far the table is moved.
				const rawMoved = (row = 100) => {
					const tr = drawnRow(row);
					const box = shownBoxes(big)[0].parentElement;
					return tr ? box.getBoundingClientRect().left - tr.cells[0].getBoundingClientRect().left : NaN;
				};
				let rest = 0;
				const moved = (row = 100) => rawMoved(row) - rest;
				// Over a drawn row in the middle of the pane, or the given place.
				const midRow = () => {
					const middle = pane().top + view.scrollDOM.clientHeight / 2;
					return big.drawnRows().map((entry) => entry.tr).filter((tr) => tr.isConnected).sort((a, b) => Math.abs(a.getBoundingClientRect().top - middle) - Math.abs(b.getBoundingClientRect().top - middle))[0];
				};
				const swipe = async (dx, dy = 0, at = null) => {
					const r = at ?? midRow().getBoundingClientRect();
					await cdp.sendCommand('Input.synthesizeScrollGesture', { x: Math.round(r.left + Math.min(300, r.width / 2)), y: Math.round(r.top + r.height / 2), xDistance: -dx, yDistance: -dy, speed: 1200, gestureSourceType: 'mouse', preventFling: true });
					await sleep(250);
					await frames(3);
				};
				const wheelAt = async (el, deltaX, deltaY, modifiers = 0) => {
					const r = el.getBoundingClientRect();
					await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseWheel', x: Math.round(r.left + Math.min(300, r.width / 2)), y: Math.round(r.top + r.height / 2), deltaX, deltaY, modifiers });
					await sleep(200);
					await frames(3);
				};
				const bar0 = barOf();
				if (bar0) bar0.scrollLeft = 0;
				await frames(3);
				rest = rawMoved();
				const sideBox0 = shownBoxes(big)[0].parentElement;
				check('Own 14: a wide table gets a scrollbar of the plugin\'s own in the note\'s scroller, as wide as its box, and its box clips it instead of scrolling it', !!bar0 && bar0.parentElement === view.scrollDOM && getComputedStyle(sideBox0).overflowX === 'clip' && Math.abs(bar0.getBoundingClientRect().width - sideBox0.clientWidth) <= 1 && Math.abs(bar0.getBoundingClientRect().left - sideBox0.getBoundingClientRect().left - sideBox0.clientLeft) <= 1 && big.sideways().slide > 0, { bar: !!bar0, overflow: getComputedStyle(sideBox0).overflowX, slide: big.sideways().slide });
				check('Own 18: the scrollbar takes no keyboard focus and screen readers skip it', bar0?.tabIndex === -1 && bar0?.getAttribute('aria-hidden') === 'true');
				// The bar at the pane's bottom while the table crosses it, clear of the status bar.
				const status = document.querySelector('.status-bar')?.getBoundingClientRect();
				const paneBottom = pane().top + view.scrollDOM.clientTop + view.scrollDOM.clientHeight;
				const inset = status && status.height && status.top < paneBottom && status.bottom >= paneBottom - 1 ? paneBottom - status.top : 0;
				const atBottom = bar0.getBoundingClientRect().bottom;
				check('Own 18: while the table crosses the pane\'s bottom, the bar sits there, clear of the status bar', Math.abs(atBottom - (paneBottom - inset)) <= 1, { bar: atBottom, paneBottom, inset });

				// A swipe passed on: the table moves as far as the bar, every block together, and the note doesn't move.
				const topBefore = view.scrollDOM.scrollTop;
				await swipe(300, 12);
				const after = { scroll: bar0.scrollLeft, moved: moved(), seam: Math.abs(drawnRow(99).cells[0].getBoundingClientRect().left - drawnRow(100).cells[0].getBoundingClientRect().left), top: view.scrollDOM.scrollTop - topBefore };
				check('Own 19: a mostly sideways swipe over the table moves it as far as its bar, every block together, and the note not at all', after.scroll > 150 && Math.abs(after.moved - after.scroll) <= 1 && after.seam <= 0.5 && Math.abs(after.top) <= 1, after);
				// A mostly vertical scroll moves the note, and leaves the table where it is sideways.
				await swipe(10, 300);
				const vertical = { scroll: bar0.scrollLeft, top: view.scrollDOM.scrollTop - topBefore };
				check('Own 19: a mostly vertical scroll over the table moves the note and not the table', Math.abs(vertical.scroll - after.scroll) <= 0.5 && vertical.top > 100, vertical);
				await toRow(100);
				// Shift with a mouse wheel moves the table sideways and not the note; Ctrl with the wheel is left to Obsidian.
				const shiftFrom = { scroll: bar0.scrollLeft, top: view.scrollDOM.scrollTop };
				await wheelAt(drawnRow(100), 0, 120, 8);
				const shifted = { by: bar0.scrollLeft - shiftFrom.scroll, top: view.scrollDOM.scrollTop - shiftFrom.top };
				check('Own 19: Shift with a mouse wheel moves the table sideways, and the note not at all', shifted.by > 50 && Math.abs(shifted.top) <= 1, shifted);
				await sleep(150);
				const zoom = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX: 80, ctrlKey: true });
				const zoomFrom = bar0.scrollLeft;
				drawnRow(100).cells[1].dispatchEvent(zoom);
				await frames(2);
				check('Own 19: Ctrl with the wheel, as a pinch arrives, is left to Obsidian: the table doesn\'t move and the plugin doesn\'t stop it', !zoom.defaultPrevented && bar0.scrollLeft === zoomFrom, { prevented: zoom.defaultPrevented, by: bar0.scrollLeft - zoomFrom });

				// The place is kept: scrolling far down and back, an edit elsewhere, and CodeMirror building the box anew.
				const placeAt = bar0.scrollLeft;
				const movedAt = moved();
				await toRow(1500);
				await toRow(100);
				const keptFar = { scroll: barOf()?.scrollLeft, moved: moved(), same: barOf() === bar0 };
				const editText = view.state.doc.toString();
				view.dispatch({ changes: { from: 0, insert: 'An edit above. ' } });
				await sleep(300);
				await frames(3);
				const keptEdit = { scroll: barOf()?.scrollLeft, moved: moved() };
				await restore(view, editText);
				await toRow(100);
				check('Own 20: the table keeps its place sideways after scrolling far down and back, and after an edit above it', keptFar.same && Math.abs(keptFar.scroll - placeAt) <= 0.5 && Math.abs(keptFar.moved - movedAt) <= 1 && Math.abs(keptEdit.scroll - placeAt) <= 0.5 && Math.abs(keptEdit.moved - movedAt) <= 1, { placeAt, movedAt, keptFar, keptEdit });

				// A vertical scroll with the pointer over the bar scrolls the note.
				// Putting the note's whole text back made its tables anew, with a bar each.
				await sleep(300);
				const barNow = barOf();
				const overBar = barNow.getBoundingClientRect();
				const onBar = document.elementFromPoint(Math.round(overBar.left + Math.min(300, overBar.width / 2)), Math.round(overBar.top + overBar.height / 2)) === barNow;
				const beforeBar = view.scrollDOM.scrollTop;
				await swipe(0, 200, { left: overBar.left, top: overBar.top + overBar.height / 2 - 0.5, width: overBar.width, height: 1 });
				check('Own 20: scrolling up and down with the pointer over the bar scrolls the note', onBar && view.scrollDOM.scrollTop - beforeBar > 100, { onBar, by: view.scrollDOM.scrollTop - beforeBar });

				// The table's end: the bar right under the last row. Before the table: no bar in the pane.
				view.dispatch({ effects: view.constructor.scrollIntoView(big.to, { y: 'center' }) });
				await sleep(700);
				await frames(4);
				[big] = models(view);
				const lastTable = big.boxes.find((box) => box.isConnected && box.classList.contains('selectable-tables-last'))?.querySelector('table');
				const endGap = lastTable?.isConnected ? barOf().getBoundingClientRect().top - lastTable.getBoundingClientRect().bottom : NaN;
				check('Own 21: once the last row is in the pane, the bar sits right under it', Math.abs(endGap) <= 1, { endGap });
				view.scrollDOM.scrollTop = 0;
				await sleep(500);
				await frames(4);
				const headTop = big.boxes[0]?.querySelector('thead')?.getBoundingClientRect().top ?? 0;
				const beforeTable = { barTop: barOf().getBoundingClientRect().top, paneBottom: pane().bottom, headTop };
				check('Own 21: before the table\'s first rows reach the pane\'s bottom, no bar shows in the pane', headTop < pane().bottom || beforeTable.barTop >= pane().bottom, beforeTable);
				barOf().scrollLeft = 0;

				// A table no wider than its box gets no bar and doesn't move.
				view = await open('Two report tables');
				await sleep(300);
				check('Own 22: a table no wider than its box gets no scrollbar and doesn\'t move', !view.scrollDOM.querySelector('.selectable-tables-bar') && !view.contentDOM.querySelector('.selectable-tables-slides'), { bars: view.scrollDOM.querySelectorAll('.selectable-tables-bar').length });

				// A selected table, moved to its middle: tinted, and its box clips the table and the tint.
				view = await open('Table 2000 by 12');
				await toRow(100);
				{
					// Beside the cells, in the box's padding: a press on a cell opens it (STA-81).
					const box = shownBoxes(big)[0].parentElement.getBoundingClientRect();
					const row = drawnRow(100).getBoundingClientRect();
					const point = { x: box.left + 4, y: row.top + row.height / 2, button: 'left', clickCount: 1 };
					await cdp.sendCommand('Input.dispatchMouseEvent', { ...point, type: 'mousePressed' });
					await cdp.sendCommand('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased' });
					await sleep(400);
				}
				await swipe(250, 0);
				const tintBox = shownBoxes(big)[0].parentElement;
				const tinted = shownBoxes(big).filter((b) => b.classList.contains('is-selected')).length;
				const tintOk = tinted === shownBoxes(big).length && getComputedStyle(tintBox).overflowX === 'clip' && getComputedStyle(shownBoxes(big)[0].querySelector('table'), '::after').content !== 'none';
				check('Own 22: a selected table, moved sideways, is tinted in every block in the page, inside its box', tintOk, { tinted, shown: shownBoxes(big).length });
				await caretOnLine(view, 1);
				barOf().scrollLeft = 0;

				// A phone or tablet, and the box timing runs compare against: the box scrolls every block together, and keeps
				// the table's place after the note scrolls far and back.
				for (const [label, on, off] of [['a phone\'s layout', () => document.body.classList.add('is-mobile'), () => document.body.classList.remove('is-mobile')], ['the box', () => preview.boxes(true), () => preview.boxes(false)]]) {
					on();
					try {
						view = await open('Table 2000 by 12');
						view.dispatch({});
						for (const model of models(view)) model.placeBar();
						await toRow(100);
						let sideBox = shownBoxes(big)[0].parentElement;
						const reach = sideBox.scrollWidth - sideBox.clientWidth;
						sideBox.scrollLeft = Math.min(200, reach);
						await sleep(200);
						const left = sideBox.scrollLeft;
						const together = Math.abs(drawnRow(99).cells[0].getBoundingClientRect().left - drawnRow(100).cells[0].getBoundingClientRect().left) <= 0.5;
						await toRow(1500);
						await toRow(100);
						sideBox = shownBoxes(big)[0].parentElement;
						check(`Own 14, ${label}: no scrollbar, the box scrolls every block sideways together, and keeps the table's place after scrolling far down and back`, !view.scrollDOM.querySelector('.selectable-tables-bar') && reach > 0 && left > 0 && together && Math.abs(sideBox.scrollLeft - left) < 0.5, { reach, left, together, after: sideBox.scrollLeft });
						sideBox.scrollLeft = 0;
					} finally {
						off();
						view.dispatch({});
						for (const model of models(view)) model.placeBar();
						await sleep(200);
					}
				}

				// 30 seeded random steps: swipes, scrolls, edits and a narrower pane. After each, nothing crashed, every drawn
				// row shows its line, and the table sits where its bar says.
				{
					view = await open('Table 2000 by 12');
					const randomText = view.state.doc.toString();
					let seed = 79;
					const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
					const pick = (list) => list[Math.floor(random() * list.length)];
					const sizer = view.dom.closest('.workspace-leaf-content');
					let bad = null;
					try {
						for (let step = 0; step < 30 && !bad; step++) {
							await toRow(Math.floor(random() * 1990));
							const action = pick(['swipe', 'swipe', 'scroll', 'edit', 'narrow']);
							if (action === 'swipe') await swipe(pick([-400, -120, 120, 400]), pick([0, 8]));
							else if (action === 'scroll') await swipe(0, pick([-900, 900]));
							else if (action === 'edit') {
								const line = view.state.doc.line(view.state.doc.lineAt(big.from).number + 2 + Math.floor(random() * big.count));
								view.dispatch({ changes: { from: line.from + 2, insert: pick(['x', 'a longer cell text ', 'y']) } });
								await sleep(300);
							} else {
								sizer.style.width = sizer.style.width ? '' : '70%';
								await sleep(500);
							}
							await frames(3);
							[big] = models(view);
							const bar = barOf();
							const row = big.drawnRows().find((entry) => entry.tr.isConnected)?.row;
							const offBy = bar && row !== undefined ? Math.abs(moved(row) - bar.scrollLeft) : 0;
							if (crashed(view) || rowsRight(view).length || !keptRight(view) || offBy > 1) bad = { step, action, crashed: crashed(view), wrong: rowsRight(view).slice(0, 5), kept: keptRight(view), offBy };
						}
					} finally {
						sizer.style.width = '';
						await restore(view, randomText);
					}
					check('Own 23: after each of 30 seeded random swipes, scrolls, edits and pane resizes, nothing crashed, the drawing matches the text, and the table sits where its bar says', !bad, bad);
				}

				// A press on the box beside the large table selects it whole, and a key typed then starts a paragraph below it.
				view = await open('Table 2000 by 12');
				await toRow(150);
				const besideText = view.state.doc.toString();
				const besideBox = shownBoxes(big)[0].parentElement;
				const row150 = drawnRow(150).getBoundingClientRect();
				const atPadding = { clientX: besideBox.getBoundingClientRect().left + 4, clientY: row150.top + row150.height / 2 };
				besideBox.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, view: window, ...atPadding }));
				besideBox.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, button: 0, view: window, ...atPadding }));
				await settle();
				const beside = view.state.selection.main;
				const besideSelected = beside.from === big.from && beside.to === big.to && view.state.doc.toString() === besideText;
				await realType('y');
				await sleep(300);
				const typedAfter = view.state.doc.toString().slice(big.to);
				check('Own 16: a press beside the large table, on its box, selects it whole, and a key typed then starts a paragraph below it', besideSelected && view.state.doc.toString().slice(0, big.to) === besideText.slice(0, big.to) && /^\n\ny\n/.test(typedAfter), { selection: [beside.from, beside.to], table: [big.from, big.to], after: JSON.stringify(typedAfter.slice(0, 12)) });
				await restore(view, besideText);

				// The parser's jump: at the note's end, an edit above the table (as Sync makes one) has the parser start
				// again near the screen, inside the table, and read its rows there as text. It reads the header again a
				// moment later. The table stays drawn all the while, at both ends, never as lines of text.
				const asText = () => [...view.contentDOM.querySelectorAll(':scope > .cm-line')].filter((line) => line.textContent.startsWith('| Row')).length;
				const drawnRight = () => {
					const [model] = models(view);
					return !!model && model.from === big.from && view.state.doc.lineAt(model.to).text.startsWith('| Row') && !rowsRight(view).length && shownBoxes(model).length > 0 && asText() === 0;
				};
				view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
				await sleep(800);
				await frames(3);
				const atEnd = drawnRight();
				const bigOriginal = view.state.doc.toString();
				view.dispatch({ changes: { from: view.state.doc.line(1).to, insert: ' edited' } });
				[big] = models(view);
				let skipped = 0;
				let wrong = 0;
				for (let frame = 0; frame < 90; frame++) {
					await frames(1);
					if (!preview.scan(view.state).some((found) => found.from === big.from)) skipped++;
					if (!drawnRight()) wrong++;
				}
				view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
				await sleep(800);
				await frames(3);
				const atStart = drawnRight() && !!firstBox(models(view)[0])?.isConnected;
				check('Own 15: Cmd+End, an edit above the table, then Cmd+Home: the parser skips the table\'s header, and the table stays drawn at both ends, never as text', atEnd && skipped > 0 && wrong === 0 && atStart, { atEnd, framesSkipped: skipped, framesWrong: wrong, atStart });
				await restore(view, bigOriginal);

				// Reading view keeps Obsidian's tables.
				const leaf = app.workspace.getLeaf(false);
				await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: 'preview' } });
				await sleep(500);
				check('Own 10: Reading view keeps Obsidian\'s tables', leaf.view.previewMode.containerEl.querySelectorAll('table').length > 0 && !leaf.view.containerEl.querySelector('.selectable-tables-own:not(.cm-content *)'));
				await leaf.setViewState({ ...leaf.getViewState(), state: { ...leaf.getViewState().state, mode: 'source', source: false } });
				await sleep(300);

				// Switch off: Obsidian's tables come back, and the plugin's keys with them.
				preview.use(false);
				await sleep(500);
				view = await open('Two report tables');
				check('Own 11: with the switch off, Obsidian draws the tables again and the plugin\'s keys are back', obsidianBoxes(view).length > 0 && ownBoxes(view).length === 0 && view.dom.classList.contains('selectable-tables'));

				// A theme changed with the switch off is taken up once it's turned on again: the plugin forgot its sizes
				// only in notes it was drawing, so a table came back laid out with the theme before (STA-88's hand check).
				if (app.customCss.themes.Baseline) {
					const lookWas = app.customCss.theme;
					const widthOf = (v) => v.contentDOM.querySelector(':scope > .cm-table-widget table')?.getBoundingClientRect().width ?? 0;
					try {
						app.customCss.setTheme('Baseline');
						await sleep(1200);
						preview.use(true);
						view = await open('Markdown in cells');
						await sleep(600);
						preview.use(false);
						await sleep(500);
						app.customCss.setTheme('');
						await sleep(1200);
						view = await open('Markdown in cells');
						await sleep(600);
						const obsidian = widthOf(view);
						preview.use(true);
						view = await open('Markdown in cells');
						await sleep(1000);
						const own = widthOf(view);
						check('Own 17: a theme changed with the switch off is taken up once it\'s on: the table is as wide as Obsidian\'s', obsidian > 0 && Math.abs(own - obsidian) <= 1, { obsidian, own });
					} finally {
						preview.use(false);
						app.customCss.setTheme(lookWas);
						await sleep(800);
					}
				}

				{
					// --- Keys on the plugin's table (STA-80): the navigation layer runs on it, across its blocks. ↑ and ↓ stop
					// on a table with a tap, Enter selects a cell but opens none yet, Find shows its match in the cell, and a
					// caret put inside a table by anything but a key selects the table and that cell.
					preview.use(true);
					await sleep(400);
					// After every step: nothing crashed, every drawn row shows its line, and a selected cell is outlined once.
					const steady = (view) => {
						const marks = view.contentDOM.querySelectorAll('.selectable-tables-cell').length;
						return { crashed: crashed(view), rows: rowsRight(view).length, marks };
					};
					const steadyOk = (s, cell) => s.crashed === 0 && s.rows === 0 && (cell ? s.marks === 1 : s.marks === 0);
					const whole = (view, model) => {
						const { from, to } = view.state.selection.main;
						return view.state.selection.ranges.length === 1 && from === model.from && to === model.to;
					};
					const cellOf = (view) => {
						const el = view.contentDOM.querySelector('.selectable-tables-cell');
						if (!el) return null;
						const tr = el.parentElement;
						const label = tr.parentElement.localName === 'thead' ? 0 : Number(tr.getAttribute('aria-rowindex')) - 1;
						return `${label},${el.cellIndex}`;
					};
					const inPane = (view, el) => {
						const r = el.getBoundingClientRect();
						const p = view.scrollDOM.getBoundingClientRect();
						return r.top >= p.top - 1 && r.bottom <= p.bottom + 1;
					};
					const lineOf = (view, text) => {
						for (let n = 1; n <= view.state.doc.lines; n++) if (view.state.doc.line(n).text.startsWith(text)) return n;
						return -1;
					};
					const tint = (model) => firstBox(model).classList.contains('is-selected') && view.dom.classList.contains('selectable-tables-selected');

					// ↑ and ↓ stop on a table with a tap, and pass it held.
					view = await open('Cell moves');
					const cellsText = view.state.doc.toString();
					let seed = models(view)[0];
					const aboveSeed = view.state.doc.lineAt(seed.from).number - 1;
					const belowSeed = view.state.doc.lineAt(seed.to).number + 1;
					await caretOnLine(view, aboveSeed);
					await press(view, 'ArrowDown');
					const stopped = whole(view, seed) && view.state.selection.main.head === seed.to && tint(seed);
					await press(view, 'ArrowDown');
					const onBelow = sel(view).line === belowSeed && sel(view).anchor === sel(view).head;
					await press(view, 'ArrowUp');
					const fromBelow = whole(view, seed) && view.state.selection.main.head === seed.from;
					await press(view, 'ArrowUp');
					check('Own 30: a tap of ↓ above a table selects it, ↓ again goes to the line below, ↑ selects it from below, ↑ again goes back above', stopped && onBelow && fromBelow && sel(view).line === aboveSeed, { stopped, onBelow, fromBelow, line: sel(view).line, steady: steady(view) });
					await press(view, 'ArrowDown', { repeat: true });
					check('Own 30: a held ↓ passes the table in one press', sel(view).line === belowSeed && sel(view).anchor === sel(view).head, sel(view));
					await caretOnLine(view, aboveSeed);
					await press(view, 'ArrowRight');
					const rightSelects = whole(view, seed);
					await press(view, 'ArrowRight');
					const rightLeaves = sel(view).line === belowSeed;
					await press(view, 'ArrowLeft');
					const leftSelects = whole(view, seed);
					await press(view, 'ArrowLeft');
					check('Own 31: → and ← at the table\'s edge select it, and leave it again', rightSelects && rightLeaves && leftSelects && sel(view).line === aboveSeed, { rightSelects, rightLeaves, leftSelects, line: sel(view).line });

					// Backspace below selects the table, a second removes it, and Undo brings it back.
					await caretOnLine(view, belowSeed);
					await press(view, 'Backspace');
					const backSelects = whole(view, seed) && view.state.doc.toString() === cellsText;
					await press(view, 'Backspace');
					const removed = !view.state.doc.toString().includes('| A1   |');
					await press(view, 'z', { metaKey: true, code: 'KeyZ' });
					await settle();
					check('Own 32: Backspace on the line below a table selects it and deletes nothing, a second removes it, and Undo brings it back', backSelects && removed && view.state.doc.toString() === cellsText, { backSelects, removed, back: view.state.doc.toString() === cellsText });
					await restore(view, cellsText);

					// Delete above does nothing; typing above keeps a blank line between the text and the table, in one undo step.
					seed = models(view)[0];
					await caretOnLine(view, aboveSeed);
					await press(view, 'Delete');
					const deleteQuiet = view.state.doc.toString() === cellsText && !whole(view, seed);
					await caretOnLine(view, aboveSeed);
					await realType('w');
					const typedAbove = view.state.doc.toString();
					const kept = typedAbove.includes('## Seed trays\nw\n\n| Tray') && models(view).length === models(view).length && ownBoxes(view).length > 0;
					await press(view, 'z', { metaKey: true, code: 'KeyZ' });
					await settle();
					check('Own 33: Delete at the end of the blank line above a table does nothing', deleteQuiet);
					check('Own 33: typing on the blank line above a table keeps a blank line under the text, and one Undo takes both back', kept && view.state.doc.toString() === cellsText, { kept, typed: JSON.stringify(typedAbove.slice(typedAbove.indexOf('## Seed trays'), typedAbove.indexOf('## Seed trays') + 26)), undone: view.state.doc.toString() === cellsText });
					await restore(view, cellsText);
					// Backspace at the start of that blank line moves the caret up, and deletes nothing.
					await caretOnLine(view, aboveSeed);
					await press(view, 'Backspace');
					check('Own 33: Backspace on the blank line above a table, under text, moves the caret up and deletes nothing', view.state.doc.toString() === cellsText && sel(view).line === aboveSeed - 1, sel(view));

					// The caret keeps its place across a table it stopped on.
					view = await open('Two report tables');
					const startLine = lineOf(view, 'Plants checked');
					const shortLine = lineOf(view, 'A short line between the tables');
					const placeAfter = async (presses) => {
						const line = view.state.doc.line(startLine);
						view.focus();
						view.dispatch({ selection: { anchor: line.from + 'Plants checked'.length }, scrollIntoView: true });
						await settle();
						for (let i = 0; i < presses; i++) await press(view, 'ArrowDown');
						const { head } = view.state.selection.main;
						return { line: view.state.doc.lineAt(head).number, x: view.coordsAtPos(head)?.left, start: view.coordsAtPos(view.state.doc.lineAt(head).from)?.left };
					};
					const startX = (() => {
						const line = view.state.doc.line(startLine);
						return view.coordsAtPos(line.from + 'Plants checked'.length)?.left;
					})();
					const across = await placeAfter(4);
					preview.use(false);
					await sleep(500);
					view = await open('Two report tables');
					const stock = await placeAfter(3);
					preview.use(true);
					await sleep(500);
					view = await open('Two report tables');
					// With the switch off, passing a table loses the place across and lands at the line's start: kept for reference.
					check('Own 34: ↓ four times past a table it stops on lands at the place across it started at, within 1 px', across.line === shortLine && Math.abs(across.x - startX) <= 1, { across, stock, startX });

					// A held ↓ and ↑ pass every table in Long note, and never select one.
					view = await open('Long note');
					await caretOnLine(view, 1);
					let selectedOnce = false;
					let presses = 0;
					const heldStart = performance.now();
					while (sel(view).line < view.state.doc.lines && presses < 2000) {
						await press(view, 'ArrowDown', { repeat: true });
						presses++;
						if (sel(view).anchor !== sel(view).head) selectedOnce = true;
					}
					const downMs = performance.now() - heldStart;
					let upSelected = false;
					let upPresses = 0;
					while (sel(view).line > 1 && upPresses < 2000) {
						await press(view, 'ArrowUp', { repeat: true });
						upPresses++;
						if (sel(view).anchor !== sel(view).head) upSelected = true;
					}
					check('Own 35: a held ↓ and ↑ go through Long note past every table without selecting one', !selectedOnce && !upSelected && sel(view).line === 1 && steadyOk(steady(view)), { presses, upPresses, selectedOnce, upSelected, downMs: Math.round(downMs) });

					// Selecting a 2,000-row table from above doesn't move the note, and ↓ passes all its rows.
					view = await open('Table 2000 by 12');
					const bigText = view.state.doc.toString();
					let big = models(view).find((model) => model.count > 1000);
					const aboveBig = view.state.doc.lineAt(big.from).number - 1;
					await caretOnLine(view, aboveBig);
					view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.line(aboveBig).from, { y: 'start', yMargin: 40 }) });
					await sleep(300);
					let top = view.scrollDOM.scrollTop;
					await press(view, 'ArrowRight');
					await frames(3);
					check('Own 36: → on the line above the 2,000-row table selects it, and the note doesn\'t move', whole(view, big) && Math.abs(view.scrollDOM.scrollTop - top) <= 1, { moved: view.scrollDOM.scrollTop - top });
					await press(view, 'Escape');
					top = view.scrollDOM.scrollTop;
					await press(view, 'ArrowDown');
					await frames(3);
					const downSelects = whole(view, big) && Math.abs(view.scrollDOM.scrollTop - top) <= 1;
					let t0 = performance.now();
					await press(view, 'ArrowDown');
					const passMs = performance.now() - t0 - 120;
					const pastAll = sel(view).line === view.state.doc.lineAt(big.to).number + 1;
					await press(view, 'ArrowUp');
					check('Own 36: ↓ selects it too without moving the note, ↓ again puts the caret below all 2,000 rows, and ↑ selects it from below', downSelects && pastAll && whole(view, big) && view.state.selection.main.head === big.from, { downSelects, pastAll, passMs: Math.round(passMs) });

					// Cells: Enter selects one, the arrows, Tab and Shift+Tab move it, and nothing opens or changes.
					view = await open('Cell moves');
					seed = models(view)[0];
					await caretOnLine(view, aboveSeed);
					await press(view, 'ArrowDown');
					await press(view, 'Enter');
					const first = cellOf(view);
					const tintOff = getComputedStyle(firstBox(seed).querySelector('table'), '::after').display === 'none';
					const walk = [];
					for (const key of ['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowUp']) {
						await press(view, key);
						walk.push(cellOf(view));
					}
					await press(view, 'Tab');
					walk.push(cellOf(view));
					await press(view, 'Tab', { shiftKey: true });
					await press(view, 'Tab', { shiftKey: true });
					walk.push(cellOf(view));
					check('Own 37: Enter on the selected table selects its first cell and takes the tint off; the arrows stop at the edges, Tab and Shift+Tab wrap between rows', first === '0,0' && tintOff && walk.join(' ') === '0,1 0,2 0,2 1,2 2,2 3,2 4,2 4,2 4,1 3,1 3,2 3,0' && view.state.doc.toString() === cellsText && steadyOk(steady(view), true), { first, tintOff, walk: walk.join(' '), steady: steady(view) });
					await press(view, 'Enter');
					// Enter on the selected cell opens it (STA-81); Escape in it selects it again.
					const opened = preview.openCell(view);
					const enterOpens = !!opened && opened.cell.row === 3 && opened.cell.column === 0 && view.state.doc.toString() === cellsText;
					if (opened) await press(opened.view, 'Escape');
					const backToCell = !preview.openCell(view) && cellOf(view) === '3,0';
					await press(view, 'Escape');
					const backToTable = !cellOf(view) && whole(view, seed) && tint(seed);
					await press(view, 'Enter');
					const sameCell = cellOf(view) === '3,0';
					await press(view, 'Escape');
					await press(view, 'Escape');
					check('Own 38: Enter on a selected cell opens it, Escape selects it again, Escape goes back to the table, Enter to the same cell, and Escape twice to the line above', enterOpens && backToCell && backToTable && sameCell && sel(view).line === aboveSeed, { enterOpens, backToCell, backToTable, sameCell, line: sel(view).line });

					// Copy gives the cell's Markdown; Cut and Paste do nothing; Toggle checkbox and Toggle comment change nothing; typing goes below.
					await caretOnLine(view, aboveSeed);
					await press(view, 'ArrowDown');
					await press(view, 'Enter');
					await press(view, 'ArrowDown');
					await press(view, 'ArrowRight');
					await press(view, 'ArrowRight');
					const copied = clipboard(view, 'copy');
					const cut = clipboard(view, 'cut');
					const pasted = clipboard(view, 'paste', 'pasted');
					for (const id of ['editor:toggle-checklist-status', 'editor:toggle-comments']) app.commands.executeCommandById(id);
					await settle();
					check('Own 39: on a selected cell, Copy gives its Markdown, and Cut, Paste, Toggle checkbox and Toggle comment change nothing', copied.text === '**Keep damp**' && cut.taken && pasted.taken && view.state.doc.toString() === cellsText && cellOf(view) === '1,2', { copied, cut: cut.taken, pasted: pasted.taken, cell: cellOf(view) });
					await realType('q');
					const below = view.state.doc.toString();
					const belowOk = below.slice(0, seed.to) === cellsText.slice(0, seed.to) && /^\n\nq\n/.test(below.slice(seed.to));
					await press(view, 'z', { metaKey: true, code: 'KeyZ' });
					await settle();
					check('Own 39: a letter typed on a selected cell starts a paragraph below the table, and Undo takes it back with the table selected', belowOk && view.state.doc.toString() === cellsText && whole(view, models(view)[0]), { belowOk, after: JSON.stringify(below.slice(seed.to, seed.to + 8)) });
					await restore(view, cellsText);

					// A held ↓ through the 2,000-row table: the cell moves a row at a time across the seams, and stays in view.
					view = await open('Table 2000 by 12');
					big = models(view).find((model) => model.count > 1000);
					await caretOnLine(view, aboveBig);
					await press(view, 'ArrowDown');
					await press(view, 'Enter');
					let heldBad = null;
					for (let i = 1; i <= 230 && !heldBad; i++) {
						await press(view, 'ArrowDown', { repeat: true });
						await frames(1);
						const el = view.contentDOM.querySelector('.selectable-tables-cell');
						if (cellOf(view) !== `${i},0` || !el || !inPane(view, el) || !steadyOk(steady(view), true)) heldBad = { i, cell: cellOf(view), inPane: el && inPane(view, el), steady: steady(view) };
					}
					check('Own 40: holding ↓ on a selected cell moves it a row at a time past rows 100 and 200, with the cell in view and outlined after every press', !heldBad, heldBad);

					// Cmd+↓ to row 2,000, drawn and in view in the frame it's painted; Cmd+↑ back to the header; Page Down and Page Up the same.
					const jump = async (key, mods, want) => {
						const start = performance.now();
						await view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true, ...mods }));
						await frames(1);
						const el = view.contentDOM.querySelector('.selectable-tables-cell');
						const first = { cell: cellOf(view), inPane: !!el && inPane(view, el), ms: Math.round(performance.now() - start) };
						await sleep(200);
						return { ...first, ok: first.cell === want && first.inPane && steadyOk(steady(view), true) };
					};
					// The header is row 0, so the 2,000th row is the last body row.
					const lastRow = `${big.count},0`;
					const jumps = {
						end: await jump('ArrowDown', { metaKey: true }, lastRow),
						start: await jump('ArrowUp', { metaKey: true }, '0,0'),
						pageDown: await jump('PageDown', {}, lastRow),
						pageUp: await jump('PageUp', {}, '0,0'),
					};
					check('Own 41: Cmd+↓ and Page Down jump a selected cell to row 2,000, and Cmd+↑ and Page Up back to the header, each in view and outlined in the first frame after the key', Object.values(jumps).every((j) => j.ok && j.ms < 100), jumps);

					// End and Home go to the row's ends, scrolling the table sideways to show the cell; → across shows each cell.
					await press(view, 'ArrowDown');
					const sideBox = (model) => (model.boxes[0].parentElement.classList.contains('selectable-tables-blocks') ? model.boxes[0].parentElement : model.boxes[0]);
					const sideways = () => {
						const el = view.contentDOM.querySelector('.selectable-tables-cell');
						const box = sideBox(big).getBoundingClientRect();
						const r = el?.getBoundingClientRect();
						return !!r && r.left >= box.left - 1 && r.right <= box.right + 1;
					};
					await press(view, 'End');
					await frames(3);
					const endShown = cellOf(view) === '1,11' && sideways();
					await press(view, 'Home');
					await frames(3);
					const homeShown = cellOf(view) === '1,0' && sideways() && big.sideways().scroll <= 1;
					let acrossOk = true;
					for (let c = 1; c < 12; c++) {
						await press(view, 'ArrowRight');
						await frames(2);
						if (cellOf(view) !== `1,${c}` || !sideways()) acrossOk = false;
					}
					check('Own 42: End, Home and → on a selected cell scroll the wide table sideways to show it', endShown && homeShown && acrossOk, { endShown, homeShown, acrossOk, scroll: big.sideways() });
					await press(view, 'Home');

					// The cell stays outlined as its row leaves the pane and comes back, and ↓ from far away brings the note back to it.
					view.scrollDOM.scrollTop += 30000;
					await sleep(400);
					view.scrollDOM.scrollTop -= 30000;
					await sleep(400);
					const backOutlined = cellOf(view) === '1,0';
					view.scrollDOM.scrollTop += 20000;
					await sleep(400);
					await press(view, 'ArrowDown');
					await frames(3);
					const el2 = view.contentDOM.querySelector('.selectable-tables-cell');
					check('Own 43: the selected cell stays outlined as its row scrolls out and back, and ↓ from far away shows the cell below', backOutlined && cellOf(view) === '2,0' && !!el2 && inPane(view, el2), { backOutlined, cell: cellOf(view) });
					await press(view, 'Escape');
					await press(view, 'Escape');

					// Find: the table stays drawn and shows the match in its cell, and the match's cell comes into view sideways.
					const findIn = async () => {
						app.workspace.getLeaf(false).view.showSearch(false);
						await settle();
						return Object.values(app.workspace.getLeaf(false).view.editMode).find((value) => value?.searchInputEl);
					};
					const search = async (find, text) => {
						find.searchInputEl.value = text;
						find.searchInputEl.dispatchEvent(new Event('input'));
						await sleep(400);
					};
					view = await open('Cell moves');
					let find = await findIn();
					await search(find, 'Frost');
					const wide = models(view).find((model) => model.from > view.state.doc.toString().indexOf('## Wide table'));
					const findHighlight = () => Array.from(view.contentDOM.querySelectorAll('.selectable-tables-own span.obsidian-search-match-highlight')).filter((span) => span.isConnected);
					const highlighted = findHighlight();
					const firstMatch = highlighted.length === 1 && highlighted[0].textContent === 'Frost' && highlighted[0].closest('td').cellIndex === 7;
					find.findNext();
					await sleep(500);
					const next = findHighlight();
					const nextBox = sideBox(wide).getBoundingClientRect();
					const nextRect = next[0]?.getBoundingClientRect();
					const nextShown = next.length === 1 && next[0].closest('td').cellIndex === 15 && nextRect.left >= nextBox.left - 1 && nextRect.right <= nextBox.right + 1;
					check('Own 44: Find keeps the table drawn and highlights the matched word in its cell, and the next match at the table\'s far right comes into view sideways', ownBoxes(view).length >= 3 && firstMatch && nextShown, { firstMatch, nextShown, count: next.length, scroll: wide.sideways() });
					const matchStart = view.state.doc.toString().indexOf('Frost', view.state.doc.toString().indexOf('Frost') + 1);
					find.searchInputEl.focus();
					find.hide();
					await sleep(300);
					const afterFind = { cell: cellOf(view), whole: whole(view, wide) };
					await press(view, 'ArrowLeft');
					const leftOne = cellOf(view);
					await press(view, 'Escape');
					await press(view, 'Escape');
					check('Own 45: closing Find on a match selects its table and the cell holding it, and the keys go on from there', afterFind.cell === '1,15' && afterFind.whole && leftOne === '1,14' && view.state.selection.main.empty && (view.state.selection.main.head < wide.from || view.state.selection.main.head > wide.to), { afterFind, leftOne, matchStart });

					// Find in the 2,000-row table: row 1,500's match is drawn, highlighted and on screen at once.
					view = await open('Table 2000 by 12');
					big = models(view).find((model) => model.count > 1000);
					find = await findIn();
					t0 = performance.now();
					find.searchInputEl.value = 'Row 1500 ';
					find.searchInputEl.dispatchEvent(new Event('input'));
					let farMatch = null;
					for (let i = 0; i < 30 && !farMatch; i++) {
						await frames(1);
						const span = findHighlight()[0];
						if (span && inPane(view, span)) farMatch = { ms: Math.round(performance.now() - t0), text: span.textContent };
					}
					find.searchInputEl.focus();
					find.hide();
					await sleep(300);
					check('Own 46: Find on row 1,500 of the 2,000-row table shows the match highlighted in its cell, on screen, within 100 ms, and closing Find selects that cell', !!farMatch && farMatch.ms < 100 && cellOf(view) === '1500,0', { farMatch, cell: cellOf(view) });
					await press(view, 'Escape');
					await press(view, 'Escape');

					// A Search pane result in a table flashes in its cell and selects that cell.
					view = await open('Cell moves');
					const wideNow = models(view).find((model) => model.from > view.state.doc.toString().indexOf('## Wide table'));
					const frostAt = view.state.doc.toString().indexOf('Frost', wideNow.from);
					app.workspace.getLeaf(false).view.setEphemeralState({ match: { content: view.state.doc.toString(), matches: [[frostAt, frostAt + 5]] } });
					await sleep(500);
					const flashed = view.contentDOM.querySelectorAll('.selectable-tables-own span.is-flashing').length;
					check('Own 47: a Search pane result in a table flashes in its cell, and selects its table and that cell', cellOf(view) === '1,7' && whole(view, wideNow) && flashed === 1, { cell: cellOf(view), flashed });
					await press(view, 'Escape');
					await press(view, 'Escape');

					// Replace goes through, and the row shows the new text; Undo puts it back.
					app.workspace.getLeaf(false).view.showSearch(true);
					await settle();
					find = Object.values(app.workspace.getLeaf(false).view.editMode).find((value) => value?.searchInputEl);
					await search(find, 'Frost');
					find.replaceInputEl.value = 'Snow';
					find.replaceCurrentMatch();
					await sleep(400);
					const replaced = view.state.doc.toString().includes('| Snow most of the day |');
					const shownSnow = Array.from(view.contentDOM.querySelectorAll('.selectable-tables-own td')).some((td) => td.textContent.trim() === 'Snow most of the day');
					find.hide();
					await sleep(200);
					await press(view, 'Escape');
					await press(view, 'Escape');
					await press(view, 'z', { metaKey: true, code: 'KeyZ' });
					await settle();
					check('Own 48: Replace changes the matched cell, the row shows the new text, and Undo puts it back', replaced && shownSnow && view.state.doc.toString() === cellsText, { replaced, shownSnow, undone: view.state.doc.toString() === cellsText });
					await restore(view, cellsText);

					// 60 seeded random steps: keys, cell moves, Find, edits elsewhere, Undo and Redo, on the 2,000-row table.
					view = await open('Table 2000 by 12');
					let seedValue = 80;
					const random = () => {
						seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
						return seedValue / 2147483648;
					};
					const keysToPress = [['ArrowDown'], ['ArrowUp'], ['ArrowLeft'], ['ArrowRight'], ['Enter'], ['Escape'], ['Tab'], ['Tab', { shiftKey: true }], ['End'], ['Home'], ['PageDown'], ['PageUp'], ['ArrowDown', { metaKey: true }], ['ArrowUp', { metaKey: true }], ['ArrowDown', { repeat: true }]];
					const fuzz = [];
					let fuzzBad = null;
					for (let step = 0; step < 60 && !fuzzBad; step++) {
						const roll = random();
						const big2 = models(view).find((model) => model.count > 1000);
						let what;
						if (roll < 0.55) {
							const [key, mods] = keysToPress[Math.floor(random() * keysToPress.length)];
							what = `${key}${mods ? JSON.stringify(mods) : ''}`;
							await press(view, key, mods);
						} else if (roll < 0.65) {
							what = 'select table';
							await caretOnLine(view, view.state.doc.lineAt(big2.from).number - 1);
							await press(view, 'ArrowDown');
						} else if (roll < 0.75) {
							const line = view.state.doc.line(1 + Math.floor(random() * 2));
							what = `edit line ${line.number}`;
							view.dispatch({ changes: { from: line.to, insert: ' x' }, userEvent: 'input.type' });
						} else if (roll < 0.85) {
							what = random() < 0.5 ? 'undo' : 'redo';
							app.commands.executeCommandById(what === 'undo' ? 'editor:undo' : 'editor:redo');
						} else {
							what = 'find';
							const f = await findIn();
							f.searchInputEl.value = `Row ${1 + Math.floor(random() * 2000)} `;
							f.searchInputEl.dispatchEvent(new Event('input'));
							await sleep(200);
							f.searchInputEl.focus();
							f.hide();
						}
						await settle();
						await frames(2);
						const s = steady(view);
						fuzz.push(what);
						const selectedCell = view.contentDOM.querySelector('.selectable-tables-holds-cell');
						if (s.crashed || s.rows || s.marks > 1 || (selectedCell && s.marks !== 1)) fuzzBad = { step, what, steady: s, last: fuzz.slice(-6) };
					}
					check('Own 49: after each of 60 seeded random keys, cell moves, Find, edits elsewhere, Undo and Redo, nothing crashed, the drawing matches the text, and a selected cell is outlined once', !fuzzBad, fuzzBad);
					await press(view, 'Escape');
					await press(view, 'Escape');
					await restore(view, bigText);
					preview.use(false);
					await sleep(300);
				}
				}

				if (!window.__checkFrozenCellsOnly && !window.__checkEditsOnly) {
					// --- Editing a cell of the plugin's table (STA-81): a press or Enter opens it in Obsidian's own editor,
					// borrowed, and every change goes to the note as Obsidian's own cell writes it. Real keys and presses, through
					// the window's debugger, since the cell's editor is Obsidian's. Run alone with window.__checkCellsOnly = true.
					preview.use(true);
					await sleep(400);
					const codes = { Escape: 27, Enter: 13, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
					const key = async (name, { alt, ctrl, meta, shift, repeat } = {}) => {
						const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
						const code = codes[name] ?? name.toUpperCase().charCodeAt(0);
						const event = { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, windowsVirtualKeyCode: code, modifiers, autoRepeat: !!repeat, unmodifiedText: macChar(name) };
						await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'rawKeyDown' });
						await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
						await settle();
					};
					const clickAt = async ({ x, y }) => {
						await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
						await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
						await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
						await sleep(300);
					};
					// The drawn cell holding a text, and where its text ends on screen.
					const cellNamed = (view, text) => Array.from(view.contentDOM.querySelectorAll('.selectable-tables-own td, .selectable-tables-own th')).find((td) => td.isConnected && td.textContent.trim() === text) ?? null;
					const endOf = (td) => {
						const walker = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
						let last = null;
						for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node.data.trim()) last = node;
						const range = document.createRange();
						range.setStart(last, last.data.trimEnd().length);
						range.collapse(true);
						const r = range.getBoundingClientRect();
						return { x: r.right - 1, y: r.top + r.height / 2 };
					};
					const openText = async (view, text) => {
						let td = cellNamed(view, text);
						if (!td) {
							// CodeMirror draws only what's near the pane: the cell's line is scrolled to first.
							const at = view.state.doc.toString().indexOf(`| ${text}`);
							if (at >= 0) view.dispatch({ effects: view.constructor.scrollIntoView(at, { y: 'center' }) });
							await sleep(400);
							td = cellNamed(view, text);
						}
						if (!td) return false;
						td.scrollIntoView({ block: 'center' });
						await sleep(200);
						await clickAt(endOf(cellNamed(view, text)));
						return !!preview.openCell(view);
					};
					const oc = (view) => preview.openCell(view);
					const where = (view) => {
						const c = oc(view);
						if (!c) return null;
						const { anchor, head } = c.view.state.selection.main;
						return `${c.cell.row},${c.cell.column} ${anchor === head ? head : `${anchor}-${head}`}`;
					};
					const lineOf = (view, text) => {
						for (let n = 1; n <= view.state.doc.lines; n++) if (view.state.doc.line(n).text.includes(text)) return view.state.doc.line(n).text;
						return null;
					};
					const outlined = (view) => {
						const el = view.contentDOM.querySelector('.selectable-tables-cell');
						if (!el) return null;
						const tr = el.parentElement;
						return `${tr.parentElement.localName === 'thead' ? 0 : Number(tr.getAttribute('aria-rowindex')) - 1},${el.cellIndex}`;
					};
					const whole = (view, model) => view.state.selection.ranges.length === 1 && view.state.selection.main.from === model.from && view.state.selection.main.to === model.to;
					// After every step: nothing crashed, every drawn row shows its line, and an open cell holds its note text.
					const cellSteady = (view) => {
						const c = oc(view);
						const texts = c?.texts();
						// What the cell writes is what the note holds: a line break in code is written <br> and reads back as <br>.
						return { crashed: crashed(view), rows: rowsRight(view).length, cell: !c || (texts.source !== null && texts.source.trim() === texts.written.trim() && c.view.dom.isConnected) };
					};
					const cellSteadyOk = (s) => s.crashed === 0 && s.rows === 0 && s.cell;
					let view;
					// The notes this section edits, as on disk now, written back at its end: an edit the editor takes back can
					// still have been saved.
					const touched = ['Markdown in cells', 'Cell moves', 'Table 2000 by 12'];
					const onDiskBefore = {};
					for (const name of touched) onDiskBefore[name] = await app.vault.read(app.vault.getAbstractFileByPath(`${name}.md`));

					// A press right after a word opens its cell, in Obsidian's own editor, with the caret there.
					view = await open('Markdown in cells');
					const mdText = view.state.doc.toString();
					const colWidths = (model) => Array.from(firstBox(model).querySelectorAll('col')).map((col) => col.style.width).join();
					const widthsBefore = colWidths(models(view)[0]);
					await openText(view, 'Basil');
					const basil = oc(view);
					check('Own 50: a press right after a word opens its cell in Obsidian\'s own editor, with the caret right after the word and the column at its width', basil && basil.editor.borrowed && basil.view.state.doc.toString() === '**Basil**' && where(view) === '2,0 7' && basil.view.hasFocus && colWidths(models(view)[0]) === widthsBefore && cellSteadyOk(cellSteady(view)), { where: where(view), borrowed: basil?.editor.borrowed, widths: [widthsBefore, colWidths(models(view)[0])], steady: cellSteady(view) });

					// Typed Markdown shows as in Obsidian's cell: the stars hide once the caret leaves them. Link suggestions take
					// the keys first.
					await openText(view, 'Office');
					await realType(' **x** y');
					const shown = oc(view)?.view.contentDOM.textContent;
					await realType(' [[');
					await sleep(400);
					const suggesting = !!app.workspace.editorSuggest?.isShowingSuggestion?.();
					await key('Escape');
					const stillOpen = !!oc(view) && !app.workspace.editorSuggest?.isShowingSuggestion?.();
					check('Own 51: typed Markdown hides its stars once the caret leaves them, [[ shows link suggestions, and Escape closes them first, the cell still open', shown === 'Office x y' && lineOf(view, 'Office **x** y') !== null && suggesting && stillOpen && cellSteadyOk(cellSteady(view)), { shown, suggesting, stillOpen, line: lineOf(view, 'Office') });
					await restore(view, mdText);

					// Commands act in the cell: Bold bolds there, and Toggle checkbox leaves the row alone.
					await openText(view, 'Balcony');
					const balcony = oc(view);
					balcony?.view.dispatch({ selection: { anchor: 0, head: balcony.view.state.doc.length } });
					await settle();
					const editor = app.workspace.activeLeaf.view.editor;
					const answered = editor.inTableCell === true && app.workspace.activeLeaf.view.editMode.activeCM === balcony?.view;
					app.commands.executeCommandById('editor:toggle-bold');
					await settle();
					const bolded = oc(view)?.view.state.doc.toString() === '**Balcony**' && lineOf(view, '**Balcony**') !== null;
					const beforeCheckbox = view.state.doc.toString();
					app.commands.executeCommandById('editor:toggle-checklist-status');
					await settle();
					const checkboxQuiet = view.state.doc.toString() === beforeCheckbox;
					await key('Escape');
					await key('Escape');
					const released = editor.inTableCell === false && app.workspace.activeLeaf.view.editMode.activeCM === view;
					check('Own 52: with a cell open the note\'s editor answers for it, Bold bolds in the cell, Toggle checkbox leaves the row alone, and the answers come off as it closes', answered && bolded && checkboxQuiet && released, { answered, bolded, checkboxQuiet, released });
					await restore(view, mdText);

					// The keys in an open cell, as Obsidian's own cell has them.
					view = await open('Cell moves');
					const cellsText = view.state.doc.toString();
					const seed = models(view)[0];
					const steps = [];
					await openText(view, 'Tomato');
					steps.push(where(view));
					for (const [name, mods] of [['ArrowRight'], ['ArrowLeft'], ['ArrowDown'], ['ArrowUp'], ['Tab'], ['Tab', { shift: true }], ['Enter'], ['Escape'], ['Enter'], ['Enter'], ['ArrowRight', { meta: true }], ['ArrowLeft', { meta: true }]]) {
						await key(name, mods);
						steps.push(where(view) ?? `selected ${outlined(view)}`);
					}
					check('Own 53: ← → ↑ ↓ at a text\'s edges, Tab, Shift+Tab and Enter move between cells as Obsidian\'s cell does, and Cmd+← and Cmd+→ at the edges too', steps.join(' | ') === '3,1 6 | 3,2 0 | 3,1 6 | 4,1 0 | 3,1 0 | 3,2 0-5 | 3,1 0-6 | 4,1 0-10 | selected 4,1 | 4,1 10 | 4,1 10 | 4,2 0 | 4,1 10', steps.join(' | '));
					await key('Escape');
					await key('Escape');
					// Out of the table at its four edges, to the start of the line beyond.
					const aboveSeed = view.state.doc.lineAt(seed.from).number - 1;
					const belowSeed = view.state.doc.lineAt(seed.to).number + 1;
					const leaves = [];
					for (const [text, name, toStart] of [['Tray', 'ArrowUp', true], ['Tray', 'ArrowLeft', true], ['Water twice', 'ArrowDown', false], ['Water twice', 'ArrowRight', false]]) {
						await openText(view, text);
						const c = oc(view);
						if (toStart) c?.view.dispatch({ selection: { anchor: 0 } });
						await settle();
						await key(name);
						const line = view.state.doc.lineAt(view.state.selection.main.head);
						leaves.push(`${name}:${!oc(view) && view.hasFocus && view.state.selection.main.empty && view.state.selection.main.head === line.from ? line.number : 'no'}`);
					}
					check('Own 53: at the table\'s edges the keys leave it, to the start of the line above or below, with the note\'s keyboard', leaves.join(' ') === `ArrowUp:${aboveSeed} ArrowLeft:${aboveSeed} ArrowDown:${belowSeed} ArrowRight:${belowSeed}`, leaves.join(' '));
					// The cell Tab leaves, in the same row, is drawn with its new text.
					await openText(view, 'Tomato');
					await realType('z');
					await key('Tab');
					await frames(3);
					const leftDrawn = !!cellNamed(view, 'Tomatoz') && where(view) === '3,2 0-5';
					await key('z', { meta: true });
					await key('Escape');
					await key('Escape');
					check('Own 53: the cell Tab leaves in the same row is drawn with what was typed in it', leftDrawn, { leftDrawn, at: where(view) });
					await restore(view, cellsText);

					// Shift+Enter makes a line break, written <br>; a pipe is written \|; a dead key finishes. A table Obsidian
					// wrote stays written that way, its rows as long as each other.
					await openText(view, 'a | b');
					await realType(' c | d');
					await key('Enter', { shift: true });
					await realType('e');
					await realCompose({ key: 'Dead', code: 'KeyE', altKey: true }, ['´'], 'é');
					const typedLine = lineOf(view, '| B1');
					const seedNow = models(view)[0];
					const seedLines = [];
					for (let n = view.state.doc.lineAt(seedNow.from).number; n <= view.state.doc.lineAt(seedNow.to).number; n++) seedLines.push(view.state.doc.line(n).text.length);
					check('Own 54: a pipe, a line break and a dead key typed in a cell are written as Obsidian\'s cell writes them, the column padded again in every row', typedLine?.includes('| a \\| b c \\| d<br>eé |') && new Set(seedLines).size === 1 && !oc(view)?.view.composing && cellSteadyOk(cellSteady(view)), { typedLine, seedLines: [...new Set(seedLines)], steady: cellSteady(view) });
					await key('z', { meta: true });
					await key('Escape');
					await key('Escape');
					await restore(view, cellsText);

					// Tab held runs along the rows and stops at the table's last cell; Tab and Enter there do nothing.
					await tableUnder(view, 'Tall table');
					const tall = models(view).find((model) => view.state.doc.sliceString(model.from, model.from + 7) === '| Row |');
					const tallLines = view.state.doc.lines;
					await openText(view, '1');
					for (let i = 0; i < tall.count * 3 + 6; i++) await key('Tab', { repeat: i > 0 });
					const lastCell = `${tall.count},2`;
					const heldStops = where(view)?.startsWith(lastCell);
					await key('Tab');
					await key('Enter');
					check('Own 55: a held Tab runs along the rows and stops at the table\'s last cell, and Tab and Enter there do nothing, adding no row', heldStops && where(view)?.startsWith(lastCell) && view.state.doc.lines === tallLines && view.state.doc.toString() === cellsText, { at: where(view), lastCell, lines: [tallLines, view.state.doc.lines] });
					await key('Escape');
					await key('Escape');

					// Escape in two steps, Enter back in; clicking out.
					await openText(view, 'Tomato');
					await key('Escape');
					const first = !oc(view) && outlined(view) === '3,1' && whole(view, models(view)[0]);
					await key('Escape');
					const second = !oc(view) && !outlined(view) && whole(view, models(view)[0]);
					await key('Enter');
					await key('Enter');
					const reopened = where(view) === '3,1 6';
					check('Own 56: Escape closes the cell and selects it, Escape again selects the table, and Enter, Enter opens the cell again with the caret at its end', first && second && reopened, { first, second, at: where(view) });
					const lineBelow = Array.from(view.contentDOM.querySelectorAll('.cm-line')).find((line) => line.textContent.startsWith('A line of text below'));
					const below = lineBelow.getBoundingClientRect();
					await clickAt({ x: below.left + 40, y: below.top + below.height / 2 });
					const out = !oc(view) && view.hasFocus && view.state.doc.lineAt(view.state.selection.main.head).text.startsWith('A line of text below');
					await openText(view, 'Seed');
					const top = view.scrollDOM.scrollTop;
					const header = firstBox(models(view)[0]).querySelector('thead tr').getBoundingClientRect();
					const strip = firstBox(models(view)[0]).getBoundingClientRect();
					await clickAt({ x: strip.left + 4, y: header.top + header.height / 2 });
					const besideOk = !oc(view) && whole(view, models(view)[0]) && firstBox(models(view)[0]).classList.contains('is-selected') && Math.abs(view.scrollDOM.scrollTop - top) <= 1;
					check('Own 56: a click on the line below closes the cell with the caret there, and a click beside the cells selects the whole table, tinted, the note still', out && besideOk, { out, besideOk, moved: view.scrollDOM.scrollTop - top });
					await key('Escape');

					// Undo and redo: from the cell, the cell stays open; from the note, the cell is selected; Enter opens it.
					await openText(view, 'Tomato');
					await realType(' red');
					await sleep(700);
					await key('z', { meta: true });
					const undoneInCell = where(view) === '3,1 6' && lineOf(view, '| B1').includes('| Tomato ');
					await key('z', { meta: true, shift: true });
					const redoneInCell = !!oc(view) && oc(view).view.state.doc.toString() === 'Tomato red';
					await key('Escape');
					await key('Escape');
					await caretOnLine(view, belowSeed);
					await key('z', { meta: true });
					await sleep(100);
					const undoneFromNote = !oc(view) && outlined(view) === '3,1' && lineOf(view, '| B1').includes('| Tomato ');
					await key('Enter');
					const openedAfter = where(view) === '3,1 6';
					await key('z', { meta: true, shift: true });
					const redoneAfter = oc(view)?.view.state.doc.toString() === 'Tomato red';
					check('Own 57: Undo and Redo in a cell keep it open, Undo from the note selects the cell instead of opening it, and Enter then opens it', undoneInCell && redoneInCell && undoneFromNote && openedAfter && redoneAfter, { undoneInCell, redoneInCell, undoneFromNote, openedAfter, redoneAfter });
					await key('Escape');
					await key('Escape');
					await restore(view, cellsText);

					// Edits from elsewhere reach the open cell, its caret kept: another plugin's write, a second pane in Source
					// mode, a write to the file on disk, and a rewrite of the whole table.
					await openText(view, 'Tomato');
					const tomatoLine = () => view.state.doc.line(view.state.doc.lineAt(seed.from).number + 4);
					editor.replaceRange('X', { line: tomatoLine().number - 1, ch: 4 });
					await settle();
					const pluginWrite = where(view) === '3,1 6' && cellNamed(view, 'B1X') !== null && oc(view).view.hasFocus;
					const file = app.workspace.activeLeaf.view.file;
					const ownLeaf = app.workspace.activeLeaf;
					const otherLeaf = app.workspace.getLeaf('split', 'vertical');
					await otherLeaf.openFile(file, { state: { mode: 'source', source: true } });
					await sleep(400);
					const otherCm = otherLeaf.view.editor.cm;
					const otherAt = otherCm.state.doc.toString().indexOf('Tomato') + 'Tomato'.length;
					otherCm.dispatch({ changes: { from: otherAt, insert: 'es' }, userEvent: 'input.type' });
					await sleep(300);
					const fromPane = oc(view)?.view.state.doc.toString() === 'Tomatoes' && where(view) === '3,1 6';
					otherLeaf.detach();
					app.workspace.setActiveLeaf(ownLeaf, { focus: false });
					await sleep(300);
					await ownLeaf.view.save();
					const onDisk = view.state.doc.toString().replace('Tomatoes', 'Tomatoes and beans');
					await app.vault.modify(file, onDisk);
					await sleep(800);
					const fromDisk = oc(view)?.view.state.doc.toString() === 'Tomatoes and beans';
					// The second pane took the keyboard: the cell takes it back, as a click in it would.
					oc(view)?.view.focus();
					await settle();
					const rewritten = view.state.doc.sliceString(seed.from, models(view)[0].to).replace('Tomatoes and beans', 'Tomatillo');
					view.dispatch({ changes: { from: models(view)[0].from, to: models(view)[0].to, insert: rewritten } });
					await sleep(300);
					const throughRewrite = where(view)?.startsWith('3,1') && oc(view)?.view.state.doc.toString() === 'Tomatillo' && oc(view).view.hasFocus;
					const table = models(view)[0];
					view.dispatch({ changes: { from: table.from, to: table.to, insert: view.state.doc.sliceString(table.from, view.state.doc.line(view.state.doc.lineAt(table.from).number + 2).to) } });
					await sleep(300);
					const goneCloses = !oc(view) && view.hasFocus;
					check('Own 58: another plugin\'s write, a second pane in Source mode and a write to the file on disk reach the open cell, its caret kept, and a rewrite of the whole table keeps it open, while one that takes its row closes it with the note keeping the keys', pluginWrite && fromPane && fromDisk && throughRewrite && goneCloses, { pluginWrite, fromPane, fromDisk, throughRewrite, goneCloses });
					await restore(view, cellsText);
					await app.vault.modify(file, cellsText);
					await sleep(500);

					// A space typed at a cell's end is only padding to the note. A change from elsewhere then, the parser's on a long
					// note (a transaction with no text), or another plugin's write to another line, keeps the caret after it.
					await openText(view, 'Tomato');
					await realType(' ');
					view.dispatch({});
					await settle();
					const spaceKept = where(view) === '3,1 7';
					await realType('x ');
					editor.replaceRange('z', { line: view.state.doc.lineAt(seed.from).number - 5, ch: 0 });
					await settle();
					await realType('y');
					const spacesText = oc(view)?.view.state.doc.toString();
					const spacesLine = lineOf(view, '| Tomato');
					check('Own 58: a space typed at a cell\'s end stays before the next letter through a change from elsewhere, with no text or on another line', spaceKept && spacesText === 'Tomato x y' && spacesLine?.includes('| Tomato x y ') && cellSteadyOk(cellSteady(view)), { spaceKept, spacesText, spacesLine, steady: cellSteady(view) });
					await key('Escape');
					await key('Escape');
					await restore(view, cellsText);
					await app.vault.modify(file, cellsText);
					await sleep(500);

					// An input method in a cell: a composition finishes, and an edit from elsewhere during it waits for its end.
					await openText(view, 'Tomato');
					await realCompose({ key: 'n', code: 'KeyN' }, ['n', 'に'], 'に');
					const composed = oc(view)?.view.state.doc.toString() === 'Tomatoに';
					const remote = view.state.update({}).constructor.remote;
					const event = { key: 'k', code: 'KeyK', windowsVirtualKeyCode: 229 };
					let waited = false;
					try {
						await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'rawKeyDown' });
						await cdp.sendCommand('Input.imeSetComposition', { text: 'k', selectionStart: 1, selectionEnd: 1 });
						const b1 = view.state.doc.toString().indexOf('| B1') + 4;
						view.dispatch({ changes: { from: b1, insert: 'Q' }, annotations: remote.of(true) });
						await settle();
						waited = oc(view)?.view.composing === true;
					} finally {
						await cdp.sendCommand('Input.insertText', { text: 'か' });
						await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
					}
					await sleep(300);
					const after = oc(view)?.texts();
					const composeOk = composed && waited && after?.cell === 'Tomatoにか' && after.note === after.cell && !oc(view).view.composing && lineOf(view, '| B1Q') !== null;
					await key('Escape');
					await key('Escape');
					await restore(view, cellsText);
					view = await open('Table 50 by 8');
					// The note may open at its top, where its table is past the drawn range.
					if (models(view)[0]) view.dispatch({ effects: view.constructor.scrollIntoView(models(view)[0].from, { y: 'start' }) });
					await sleep(400);
					const drawsAfter = ownBoxes(view).length > 0;
					check('Own 59: a composition in a cell finishes, an edit from elsewhere during it comes in after it ends, and tables still draw afterwards', composeOk && drawsAfter, { composed, waited, after, drawsAfter });

					// With a cell open, scroll 20,000 px away and type: the letter goes in the cell, and the note comes back to it.
					view = await open('Table 2000 by 12');
					const bigText = view.state.doc.toString();
					await openText(view, 'Row 5');
					view.scrollDOM.scrollTop += 20000;
					await sleep(500);
					const keptAway = !!oc(view)?.view.dom.isConnected && oc(view).view.hasFocus;
					await realType('q');
					await sleep(300);
					const cellRect = oc(view)?.view.dom.getBoundingClientRect();
					const pane = view.scrollDOM.getBoundingClientRect();
					const back = !!cellRect && cellRect.bottom > pane.top && cellRect.top < pane.bottom;
					// Past row 100, the cell's block moves into the box CodeMirror makes anew as the first block drawn changes: the
					// cell keeps the keyboard.
					await key('Escape');
					await key('Escape');
					await openText(view, 'Row 150');
					for (const dy of [-6000, 3000, 3000]) {
						view.scrollDOM.scrollTop += dy;
						await sleep(300);
					}
					await realType('k');
					await sleep(300);
					const farKept = oc(view)?.view.state.doc.toString() === 'Row 150k';
					check('Own 60: a cell open past row 100 keeps the keyboard as the note scrolls up past the table\'s start and back', farKept, { text: oc(view)?.view.state.doc.toString(), active: document.activeElement?.className });
					await key('z', { meta: true });
					await restore(view, bigText);
					await openText(view, 'Row 5');
					view.scrollDOM.scrollTop += 20000;
					await sleep(500);
					await realType('q');
					await sleep(300);
					check('Own 60: an open cell stays in the page while the note scrolls 20,000 px away, a letter typed goes in it, and the note comes back to it', keptAway && back && oc(view)?.view.state.doc.toString() === 'Row 5q' && lineOf(view, '| Row 5q') !== null && cellSteadyOk(cellSteady(view)), { keptAway, back, text: oc(view)?.view.state.doc.toString(), steady: cellSteady(view) });
					await key('Escape');
					await key('Escape');
					await restore(view, bigText);

					// Switching notes, or turning the switch off, closes the cell, and nothing typed is lost.
					view = await open('Cell moves');
					await openText(view, 'Tomato');
					await realType('w');
					view = await open('Watering schedule');
					view = await open('Cell moves');
					const switched = !oc(view) && lineOf(view, '| Tomatow') !== null;
					await openText(view, 'Tomatow');
					preview.use(false);
					await sleep(500);
					const offCloses = obsidianBoxes(view).length > 0 && !view.contentDOM.querySelector('.selectable-tables-own');
					preview.use(true);
					await sleep(500);
					view = await open('Cell moves');
					check('Own 61: switching notes closes the cell and keeps what was typed, and turning the switch off closes it, the tables Obsidian\'s again', switched && offCloses, { switched, offCloses });
					await restore(view, cellsText);

					// The plain editor: forced, cells open in it, write, undo and close, and Toggle checkbox leaves the row alone.
					preview.forcePlain(true);
					await openText(view, 'Tomato');
					const plain = oc(view);
					await realType(' **b**');
					const plainShown = plain?.view.contentDOM.textContent;
					const plainAnswer = editor.inTableCell === true;
					const plainBefore = view.state.doc.toString();
					app.commands.executeCommandById('editor:toggle-checklist-status');
					await settle();
					const plainQuiet = view.state.doc.toString() === plainBefore;
					await key('Escape');
					const drawnBold = !!cellNamed(view, 'Tomato b')?.querySelector('strong');
					await key('Enter');
					await key('z', { meta: true });
					const plainUndo = lineOf(view, '| B1').includes('| Tomato ');
					await key('Escape');
					await key('Escape');
					preview.forcePlain(false);
					check('Own 62: forced, cells open in the plain editor, its Markdown shown as text, written to the note, drawn once it closes, with Toggle checkbox leaving the row alone and Undo working', plain && !plain.editor.borrowed && plainShown === 'Tomato **b**' && plainAnswer && plainQuiet && drawnBold && plainUndo, { borrowed: plain?.editor.borrowed, plainShown, plainAnswer, plainQuiet, drawnBold, plainUndo });
					await restore(view, cellsText);
					// Each private piece the borrowed editor needs, taken away in turn, is named.
					const ownerNow = app.workspace.activeLeaf.view;
					const suggest = app.workspace.editorSuggest;
					suggest.isShowingSuggestion = undefined;
					const noSuggest = preview.missingPiece(view);
					delete suggest.isShowingSuggestion;
					const pieces = {
						all: preview.missingPiece(view),
						base: preview.missingPieceOf({ editMode: {}, editor: ownerNow.editor }),
						tableCell: preview.missingPieceOf({ editMode: Object.assign(Object.create(ownerNow.editMode), { editor: {} }), editor: ownerNow.editor }),
						suggest: noSuggest,
					};
					check('Own 62: the borrowed editor finds every private piece it needs, and names each one taken away', pieces.all === null && pieces.base === 'the base Markdown editor class' && pieces.tableCell === "the editor's inTableCell" && pieces.suggest === 'editorSuggest.isShowingSuggestion', pieces);

					// The right-click menu in an open cell is Obsidian's editor menu, drawn by Obsidian for the check.
					const config = app.vault.config;
					const hadNative = Object.hasOwn(config, 'nativeMenus');
					const nativeBefore = config.nativeMenus;
					let menuItems = [];
					try {
						config.nativeMenus = false;
						app.updateUseNativeMenu();
						await openText(view, 'Tomato');
						const r = oc(view).view.contentDOM.getBoundingClientRect();
						const point = { x: r.left + 8, y: r.top + r.height / 2, button: 'right', clickCount: 1 };
						await cdp.sendCommand('Input.dispatchMouseEvent', { ...point, type: 'mousePressed' });
						await cdp.sendCommand('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased' });
						await sleep(500);
						const menu = Array.from(document.querySelectorAll('.menu')).pop();
						menuItems = Array.from(menu?.querySelectorAll('.menu-item-title') ?? []).map((item) => item.textContent);
						menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
						await sleep(200);
					} finally {
						if (hadNative) config.nativeMenus = nativeBefore;
						else delete config.nativeMenus;
						app.updateUseNativeMenu();
					}
					check('Own 63: a right-click in an open cell shows Obsidian\'s editor menu, and the cell stays open', menuItems.includes('Paste') && !!oc(view), { menuItems, open: !!oc(view) });
					await key('Escape');
					await key('Escape');
					await restore(view, cellsText);

					// Three seeded runs of 200 random steps each: typing, line breaks, pipes, emptying a cell, Undo, Redo, Tab,
					// Enter, Escape, Bold, clicks, scrolling away and edits from elsewhere.
					let cellsBad = null;
					const fuzzLog = [];
					for (const [run, note] of [[1, 'Markdown in cells'], [2, 'Cell moves'], [3, 'Table 2000 by 12']]) {
						view = await open(note);
						const text = view.state.doc.toString();
						let seedValue = 8100 + run;
						const random = () => {
							seedValue = (seedValue * 1103515245 + 12345) % 2147483648;
							return seedValue / 2147483648;
						};
						const pick = (list) => list[Math.floor(random() * list.length)];
						for (let step = 0; step < 200 && !cellsBad; step++) {
							const roll = random();
							let what;
							if (!oc(view) || roll < 0.08) {
								const cells = Array.from(view.contentDOM.querySelectorAll('.selectable-tables-own td, .selectable-tables-own th')).filter((td) => {
									const r = td.getBoundingClientRect();
									const p = view.scrollDOM.getBoundingClientRect();
									return td.isConnected && td.textContent.trim() && !td.querySelector('a') && r.top > p.top + 4 && r.bottom < p.bottom - 4 && r.left > p.left && r.right < p.right && !td.closest('tr.selectable-tables-spacer');
								});
								const td = pick(cells);
								what = `click ${td?.textContent.trim().slice(0, 12)}`;
								if (td) await clickAt(endOf(td));
							} else if (roll < 0.35) {
								const word = pick(['a', 'mint', ' sage', ' | ', '**b**', ' x', '`c`']);
								what = `type ${JSON.stringify(word)}`;
								await realType(word);
							} else if (roll < 0.42) {
								what = 'shift enter';
								await key('Enter', { shift: true });
							} else if (roll < 0.5) {
								what = 'backspace';
								for (let i = 0; i < 1 + Math.floor(random() * 8); i++) await key('Backspace');
							} else if (roll < 0.58) {
								what = 'undo';
								await key('z', { meta: true });
							} else if (roll < 0.63) {
								what = 'redo';
								await key('z', { meta: true, shift: true });
							} else if (roll < 0.71) {
								what = pick(['Tab', 'Tab shift', 'Enter']);
								await key(what.split(' ')[0], { shift: what.endsWith('shift') });
							} else if (roll < 0.76) {
								what = pick(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
								await key(what);
							} else if (roll < 0.81) {
								what = 'escape';
								await key('Escape');
							} else if (roll < 0.86) {
								what = 'bold';
								app.commands.executeCommandById('editor:toggle-bold');
								await settle();
							} else if (roll < 0.92) {
								what = 'scroll away and back';
								const was = view.scrollDOM.scrollTop;
								view.scrollDOM.scrollTop += 3000;
								await sleep(150);
								view.scrollDOM.scrollTop = was;
								await sleep(150);
							} else {
								what = 'edit elsewhere';
								const line = view.state.doc.line(1);
								view.dispatch({ changes: { from: line.to, insert: ' e' }, annotations: remote.of(true) });
								await settle();
							}
							await frames(2);
							const s = cellSteady(view);
							fuzzLog.push(what);
							if (!cellSteadyOk(s)) cellsBad = { run, step, what, steady: s, texts: oc(view)?.texts(), last: fuzzLog.slice(-8) };
						}
						await key('Escape');
						await key('Escape');
						await restore(view, text);
					}
					check('Own 64: after each of 3 × 200 seeded random steps in open cells, nothing crashed, the drawing matches the text, and the open cell holds its note text', !cellsBad, cellsBad);
					view = await open('Watering schedule');
					await sleep(300);
					for (const name of touched) {
						const file = app.vault.getAbstractFileByPath(`${name}.md`);
						if ((await app.vault.read(file)) !== onDiskBefore[name]) await app.vault.modify(file, onDiskBefore[name]);
					}
					preview.use(false);
					await sleep(300);
				}

				if ((!window.__checkCellsOnly || window.__checkFrozenCellsOnly) && !window.__checkEditsOnly) {
					// --- Cells of the plugin's frozen tables (STA-92): selecting, opening and freezing cells where frozen rows and
					// columns pin, on a computer. Real keys and presses through the window's debugger. Run alone with
					// window.__checkOwnOnly, __checkCellsOnly and __checkFrozenCellsOnly all true.
					preview.use(true);
					await sleep(400);
					const codes = { Escape: 27, Enter: 13, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
					const key = async (name, { alt, ctrl, meta, shift, repeat } = {}) => {
						const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
						const code = codes[name] ?? name.toUpperCase().charCodeAt(0);
						const text = name.length === 1 && !(modifiers & 6) ? name : '';
						const event = { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, windowsVirtualKeyCode: code, modifiers, autoRepeat: !!repeat, unmodifiedText: macChar(name), text };
						await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: text ? 'keyDown' : 'rawKeyDown' });
						await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
						await settle();
					};
					const pointAt = async ({ x, y }, button = 'left') => {
						await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
						await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
						await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
						await sleep(350);
					};
					const middle = (el, dx = null) => {
						const r = el.getBoundingClientRect();
						return { x: dx === null ? r.left + r.width / 2 : dx < 0 ? r.right + dx : r.left + dx, y: r.top + r.height / 2 };
					};
					const paneOf = (view) => {
						const r = view.scrollDOM.getBoundingClientRect();
						return { top: r.top + view.scrollDOM.clientTop, bottom: r.top + view.scrollDOM.clientTop + view.scrollDOM.clientHeight };
					};
					const oc = (view) => preview.openCell(view);
					const realOf = (model, el) => el && !el.closest('.selectable-tables-strip, .selectable-tables-rail');
					const realMarked = (view) => Array.from(view.contentDOM.querySelectorAll('.selectable-tables-own .selectable-tables-cell')).filter((el) => realOf(null, el));
					// What shows at an element's middle is that element: nothing pinned covers it.
					const shows = (el) => {
						if (!el?.isConnected) return false;
						const { x, y } = middle(el);
						const hit = document.elementFromPoint(x, y);
						return !!hit && el.contains(hit);
					};
					// Whether an element's box is drawn with text in it, from the window's own picture of it, not the page's state:
					// a copy painted over it is invisible to hit tests (STA-92's hand check, 11/22). Pixels that differ from the
					// box's commonest color count as ink.
					const inked = async (el) => {
						const r = el.getBoundingClientRect();
						const shot = await window.electron.remote.getCurrentWebContents().capturePage({ x: Math.round(r.left) + 2, y: Math.round(r.top) + 2, width: Math.max(1, Math.round(r.width) - 4), height: Math.max(1, Math.round(r.height) - 4) });
						const bytes = shot.toBitmap();
						const counts = new Map();
						for (let i = 0; i < bytes.length; i += 4) {
							const color = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
							counts.set(color, (counts.get(color) ?? 0) + 1);
						}
						const [background] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [0];
						let ink = 0;
						for (let i = 0; i < bytes.length; i += 4) {
							const diff = Math.abs(bytes[i] - ((background >> 16) & 255)) + Math.abs(bytes[i + 1] - ((background >> 8) & 255)) + Math.abs(bytes[i + 2] - (background & 255));
							if (diff > 150) ink++;
						}
						return ink;
					};
					// The pinned rows' bottom, and the frozen columns' edge, on the screen.
					const cover = (view, model) => {
						const room = model.pins.room;
						const strip = model.boxes.find((box) => box.isConnected)?.querySelector('.selectable-tables-strip');
						return { bottom: paneOf(view).top + room.height, edge: room.columns && strip ? strip.getBoundingClientRect().right : null, room };
					};
					// The selected cell, real, is clear of what's pinned: below the rows and right of the columns, unless it's one of them.
					const clear = (view, model) => {
						const cell = model.cell;
						const el = cell && model.cellElement(cell);
						if (!el?.isConnected) return 'not drawn';
						const r = el.getBoundingClientRect();
						const { bottom, edge, room } = cover(view, model);
						const p = paneOf(view);
						if (r.bottom <= p.top || r.top >= p.bottom) return 'out of the pane';
						if (cell.row >= room.rows && r.top < bottom - 1) return `under the rows ${Math.round(r.top)} < ${Math.round(bottom)}`;
						if (edge !== null && cell.column >= room.columns && r.left < edge - 1) return `under the columns ${Math.round(r.left)} < ${Math.round(edge)}`;
						return 'clear';
					};
					// Every copy is drawn from the text now: the frozen rows' copies from their lines, each strip row from its real
					// row's text, as tall as it, but for the open cell's row, whose cell holds what's typed.
					const copiesRight = (view) => {
						const bad = [];
						for (const model of models(view)) {
							const pins = model.pins;
							if (!model.shown || !pins.source) continue;
							const want = pins.host.lines(Math.max(0, pins.freeze.rows - 1));
							if (want.join('\n') !== pins.source.lines.join('\n')) bad.push(`${model.from}: frozen rows' copy`);
							for (const block of model.blocks) {
								const strip = block?.dom.isConnected ? pins.parts.get(block)?.strip : null;
								// A strip that steps aside for an open cell in a frozen row and a frozen column draws nothing.
								if (!strip || strip.box.classList.contains('selectable-tables-strip-off')) continue;
								for (const tr of Array.from(block.tbody.rows)) {
									if (tr.classList.contains('selectable-tables-spacer')) continue;
									const mirror = strip.mirrors.get(tr);
									if (!mirror) {
										bad.push(`${model.from}:${block.index}: a row with no strip copy`);
										continue;
									}
									if (tr !== model.openRow && mirror.text !== pins.host.textOf(tr)) bad.push(`${model.from}:${tr.getAttribute('aria-rowindex')}: strip text`);
									if (Math.abs(tr.getBoundingClientRect().height - mirror.tr.getBoundingClientRect().height) > 1) bad.push(`${model.from}:${tr.getAttribute('aria-rowindex')}: strip height`);
								}
							}
						}
						return bad;
					};
					const steady = (view) => ({ crashed: crashed(view), rows: rowsRight(view).length, copies: copiesRight(view), marked: realMarked(view).length });
					const steadyOk = (s) => s.crashed === 0 && s.rows === 0 && s.copies.length === 0 && s.marked <= 1;
					const named = (view, heading) => {
						const at = view.state.doc.toString().indexOf(`## ${heading}`);
						return models(view).find((model) => model.from > at);
					};
					const selectAbove = async (view, model) => {
						const line = view.state.doc.line(view.state.doc.lineAt(model.from).number - 1);
						view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
						view.focus();
						await sleep(250);
						await key('ArrowRight');
					};
					const toRow = async (view, model, row) => {
						view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.line(view.state.doc.lineAt(model.from).number + 2 + row).from, { y: 'start' }) });
						await sleep(400);
						await frames(3);
					};
					const leave = async () => {
						await key('Escape');
						await key('Escape');
					};
					const touched = ['Frozen tables', 'Frozen table 2000 by 12'];
					const onDiskBefore = {};
					for (const name of touched) onDiskBefore[name] = await app.vault.read(app.vault.getAbstractFileByPath(`${name}.md`));
					let view = await open('Frozen tables');
					await sleep(400);
					const frozenText = view.state.doc.toString();
					let plants = named(view, 'Plants');

					// The keys keep the selected cell clear of what's pinned, down the note and sideways, and going up or left
					// into what's frozen takes the table back to its top or its start.
					view.scrollDOM.scrollTop = 0;
					await sleep(200);
					await selectAbove(view, plants);
					await key('Enter');
					const moves = [];
					for (let i = 0; i < 30; i++) {
						await key('ArrowDown', { repeat: i > 0 });
						moves.push(['↓', clear(view, plants)]);
					}
					for (let i = 0; i < 8; i++) {
						await key('ArrowRight', { repeat: i > 0 });
						moves.push(['→', clear(view, plants)]);
					}
					for (let i = 0; i < 40; i++) {
						await key('ArrowUp', { repeat: i > 0 });
						if (plants.cell.row >= 2) moves.push(['↑', clear(view, plants)]);
					}
					const tableTop = firstBox(plants).querySelector('table').getBoundingClientRect().top;
					check('Own 65: holding ↓, → and ↑ in Plants keeps the selected cell clear of the pinned rows and the frozen column', moves.every(([, at]) => at === 'clear'), moves.filter(([, at]) => at !== 'clear'));
					check('Own 65: ↑ into a frozen row takes the table back to its top', plants.cell.row === 0 && tableTop >= paneOf(view).top - 1, { cell: plants.cell, tableTop, pane: paneOf(view).top });
					for (let i = 0; i < 8; i++) await key('ArrowLeft', { repeat: i > 0 });
					check('Own 65: ← into a frozen column takes the table back to its start', plants.cell.column === 0 && plants.sideways().scroll === 0, { cell: plants.cell, scroll: plants.sideways().scroll });
					check('Own 65: the selected cell\'s copy in the frozen column shows its outline, once', view.contentDOM.querySelectorAll('.selectable-tables-strip .selectable-tables-cell').length === 1 && realMarked(view).length === 1);
					await leave();
					// Every key that moves a cell, in Plants, Tools and the 2,000-row table, scrolled down and sideways: the cell is
					// never under what's pinned. A cell of a long table that isn't drawn yet is drawn before the frame is painted.
					const everyKey = [['ArrowDown'], ['ArrowDown'], ['ArrowRight'], ['ArrowRight'], ['Tab'], ['End'], ['PageDown'], ['ArrowDown'], ['Home'], ['ArrowRight'], ['PageDown'], ['Tab', { shift: true }], ['PageUp'], ['ArrowDown', { meta: true }], ['ArrowLeft'], ['ArrowUp'], ['ArrowUp', { meta: true }], ['ArrowDown', { ctrl: true }], ['End'], ['ArrowUp', { ctrl: true }]];
					const keyed = [];
					for (const [note, heading] of [['Frozen tables', 'Plants'], ['Frozen tables', 'Tools'], ['Frozen table 2000 by 12', null]]) {
						view = await open(note);
						await sleep(note === 'Frozen tables' ? 400 : 800);
						const table = () => (heading ? named(view, heading) : models(view)[0]);
						await selectAbove(view, table());
						await key('Enter');
						for (const [k, mods] of everyKey) {
							await key(k, mods);
							await frames(2);
							const at = clear(view, table());
							keyed.push([note === 'Frozen tables' ? heading : '2000', `${mods ? Object.keys(mods)[0] + '+' : ''}${k}`, table().cell && `${table().cell.row},${table().cell.column}`, at]);
						}
						await leave();
						await leave();
					}
					check('Own 65: every key that moves a cell, in Plants, Tools and the 2,000-row table, leaves the selected cell clear of the pinned rows and columns, and drawn', keyed.every((step) => step[3] === 'clear'), keyed.filter((step) => step[3] !== 'clear'));
					view = await open('Frozen tables');
					await sleep(400);
					plants = named(view, 'Plants');

					// A press on a row half under the pinned rows opens it below them, and its caret stays in view as it grows.
					await toRow(view, plants, 6);
					view.scrollDOM.scrollTop += 20;
					await sleep(200);
					await frames(3);
					const pinBottom = cover(view, plants).bottom;
					const halfRow = Array.from(firstBox(plants).querySelectorAll('tbody tr')).find((tr) => {
						const r = tr.getBoundingClientRect();
						return !tr.className.includes('selectable-tables') && r.top < pinBottom - 4 && r.bottom > pinBottom + 4;
					});
					if (halfRow) {
						const r = halfRow.cells[3].getBoundingClientRect();
						await pointAt({ x: r.left + 20, y: (pinBottom + r.bottom) / 2 });
						await frames(3);
					}
					const halfOpen = oc(view);
					const halfTop = halfOpen && plants.cellElement(halfOpen.cell).getBoundingClientRect().top;
					for (let i = 0; i < 3; i++) await key('Enter', { shift: true });
					await frames(2);
					const caret = halfOpen?.view.coordsAtPos(halfOpen.view.state.selection.main.head);
					check('Own 66: a press on a row half under the pinned rows opens its cell fully below them', !!halfOpen && halfTop >= pinBottom - 1, { half: !!halfRow, open: halfOpen?.cell, halfTop, pinBottom });
					check('Own 66: three line breaks later the cell has grown and its caret is in view, clear of the pinned rows', !!caret && caret.top >= pinBottom - 1 && caret.bottom <= paneOf(view).bottom + 1 && halfOpen.view.state.doc.lines === 4, { caret, pinBottom });
					for (let i = 0; i < 3; i++) await key('z', { meta: true });
					await leave();
					check('Own 66: Cmd+Z three times takes the line breaks back', view.state.doc.toString() === frozenText);

					// Moved sideways, a press on a pinned header cell opens it where it is, and the note doesn't move. A press on
					// the frozen column's copy opens the real cell at the strip's place, which keeps the keyboard; its row grows in
					// the column and the table alike, and Tab goes on to the next cell, beside the frozen column.
					await toRow(view, plants, 12);
					const head = firstBox(plants).querySelector('thead tr');
					plants.slideToStart();
					await sleep(200);
					plants.slideBy(head.cells[1].getBoundingClientRect().width);
					await sleep(200);
					await frames(3);
					const slid = plants.sideways().scroll;
					// The row at the pane's bottom, which mustn't move: a header that grows as it opens, showing the freeze mark,
					// grows over the rows under it, and the note's scroll moves to keep them still.
					const atBottom = () => Array.from(firstBox(plants).querySelectorAll(':scope > .table-wrapper tbody tr')).find((tr) => {
						const r = tr.getBoundingClientRect();
						return r.top < paneOf(view).bottom - 30 && r.bottom >= paneOf(view).bottom - 30;
					});
					const bottomRow = atBottom();
					const bottomBefore = bottomRow?.getBoundingClientRect().top;
					await pointAt(middle(head.cells[2], 15));
					const sown = oc(view);
					const moved = bottomRow ? bottomRow.getBoundingClientRect().top - bottomBefore : null;
					check('Own 67: a press on a pinned header cell, moved sideways, opens it where it is, and the row at the pane\'s bottom and the table stay', sown?.cell.row === 0 && sown.cell.column === 2 && shows(sown.view.contentDOM) && moved !== null && Math.abs(moved) <= 1 && plants.sideways().scroll === slid, { open: sown?.cell, moved, scroll: plants.sideways().scroll, slid });
					await leave();
					const strip = () => firstBox(plants).querySelector('.selectable-tables-strip');
					const mid = (paneOf(view).top + paneOf(view).bottom) / 2;
					const copyRow = Array.from(strip().querySelectorAll('tbody tr')).find((tr) => {
						const r = tr.getBoundingClientRect();
						return r.top < mid && r.bottom > mid;
					});
					const copyAt = copyRow.cells[0].getBoundingClientRect();
					const slidNow = plants.sideways().scroll;
					await pointAt({ x: copyAt.left + 10, y: copyAt.top + copyAt.height / 2 });
					await frames(3);
					const name = oc(view);
					const nameEl = name && plants.cellElement(name.cell);
					const nameAt = nameEl?.getBoundingClientRect();
					check('Own 67: a press on the frozen column\'s copy opens the real cell where the copy was, with the keyboard, and the table stays', name?.cell.column === 0 && name.view.hasFocus && Math.abs(nameAt.left - copyAt.left) <= 1 && Math.abs(nameAt.top - copyAt.top) <= 1 && shows(name.view.contentDOM) && plants.sideways().scroll === slidNow, { open: name?.cell, nameAt, copyAt, scroll: plants.sideways().scroll });
					const nameInk = name ? await inked(name.view.contentDOM) : 0;
					check('Own 67: the frozen column\'s open cell is drawn on screen, its text showing where the copy was', nameInk > 20, { ink: nameInk });
					// Each letter, as it wraps the cell's text onto more lines, grows its row in the strip as in the table, by the next
					// frame: the copy of the row below never covers what's typed (STA-92's hand check, 11/22).
					const grown = [];
					await key('End');
					// Short words at the text's end wrap onto new lines; a longer first word would widen the column instead.
					for (const letter of ' ab cd ef gh ij') {
						await key(letter === ' ' ? ' ' : letter);
						await frames(1);
						const realHeight = nameEl.parentElement.getBoundingClientRect().height;
						const copy = Array.from(strip().querySelectorAll('tbody tr')).find((tr) => Math.abs(tr.getBoundingClientRect().top - nameEl.parentElement.getBoundingClientRect().top) < 2);
						grown.push([letter, Math.round(realHeight), copy ? Math.round(copy.getBoundingClientRect().height) : null]);
					}
					check('Own 67: after each letter typed in the frozen column\'s open cell, its row is as tall in the strip as in the table', grown.every(([, a, b]) => b !== null && Math.abs(a - b) <= 1) && grown.some(([, a]) => a > grown[0][1]), grown);
					await key('Enter', { shift: true });
					await frames(3);
					const realRow = nameEl.parentElement;
					const rowCopy = Array.from(strip().querySelectorAll('tbody tr')).find((tr) => Math.abs(tr.getBoundingClientRect().top - realRow.getBoundingClientRect().top) < 2);
					const nextReal = realRow.nextElementSibling?.getBoundingClientRect().top;
					const nextCopy = rowCopy?.nextElementSibling?.getBoundingClientRect().top;
					check('Own 67: typing grows the row in the frozen column and across the table alike, and the rows below stay lined up', !!rowCopy && Math.abs(realRow.getBoundingClientRect().height - rowCopy.getBoundingClientRect().height) <= 1 && Math.abs(nextReal - nextCopy) <= 1 && shows(name.view.contentDOM), { real: realRow.getBoundingClientRect().height, copy: rowCopy?.getBoundingClientRect().height, nextReal, nextCopy });
					await key('Tab');
					await frames(3);
					const bed = oc(view);
					const bedAt = bed && plants.cellElement(bed.cell).getBoundingClientRect();
					const edge = strip()?.getBoundingClientRect().right;
					check('Own 67: Tab opens the next cell, and the table slides to show it beside the frozen column', bed?.cell.column === 1 && bed.cell.row === name.cell.row && Math.abs(bedAt.left - edge) <= 1 && shows(bed.view.contentDOM), { open: bed?.cell, left: bedAt?.left, edge });
					await leave();
					for (let i = 0; i < 24 && view.state.doc.toString() !== frozenText; i++) await key('z', { meta: true });
					check('Own 67: Cmd+Z takes the typing back', view.state.doc.toString() === frozenText);

					// A cell in a frozen row and a frozen column, opened with the rows pinned and the table moved sideways: the table
					// goes back to its start and the strip steps aside, so the open cell shows at the pane's top, and rows passing
					// under the pinned rows don't cover it (STA-92's hand check, 11/22). Escape brings the strip back.
					await toRow(view, plants, 12);
					plants.slideToStart();
					await sleep(150);
					plants.slideBy(200);
					await sleep(250);
					await frames(3);
					const cornerCopy = strip().querySelector('thead tr')?.cells[0];
					if (cornerCopy) await pointAt(middle(cornerCopy, -6));
					await frames(3);
					const corner = oc(view);
					const cornerInk = [corner ? await inked(corner.view.contentDOM) : 0];
					plants.slideBy(150);
					view.scrollDOM.scrollTop += 90;
					await sleep(250);
					await frames(3);
					cornerInk.push(corner ? await inked(corner.view.contentDOM) : 0);
					const cornerTop = corner?.view.dom.closest('th')?.getBoundingClientRect().top;
					check('Own 67: a cell in a frozen row and a frozen column opens at the pane\'s top with the table at its start, and stays drawn as rows pass under it', corner?.cell.row === 0 && corner.cell.column === 0 && plants.sideways().scroll === 0 && cornerInk.every((ink) => ink > 20) && Math.abs(cornerTop - paneOf(view).top) <= 2, { open: corner?.cell, scroll: plants.sideways().scroll, ink: cornerInk, top: cornerTop, pane: paneOf(view).top });
					await leave();
					await frames(2);
					const headCopy = strip().querySelector('thead tr');
					check('Own 67: closed, the strip and its copy of the header are back', !!headCopy && getComputedStyle(strip()).display !== 'none' && getComputedStyle(headCopy).visibility === 'visible', { display: getComputedStyle(strip()).display });
					for (let i = 0; i < 6 && view.state.doc.toString() !== frozenText; i++) await key('z', { meta: true });

					// Find shows its matches in the frozen column's copies, moved sideways, and leaves the table where it is.
					view.scrollDOM.scrollTop = view.lineBlockAt(plants.from).top - 50;
					await sleep(300);
					plants.slideBy(300);
					await sleep(200);
					const slidFind = plants.sideways().scroll;
					app.workspace.getLeaf(false).view.showSearch(false);
					await settle();
					const find = Object.values(app.workspace.getLeaf(false).view.editMode).find((value) => value?.searchInputEl);
					find.searchInputEl.value = 'Plant 7';
					find.searchInputEl.dispatchEvent(new Event('input'));
					await sleep(500);
					await frames(3);
					const stripMatch = strip().querySelector('.selectable-tables-match');
					check('Own 68: Find\'s match in the frozen column shows on its copy there, and the table stays where it was', stripMatch?.closest('td').textContent.trim() === 'Plant 7' && shows(stripMatch.closest('td')) && plants.sideways().scroll === slidFind, { match: stripMatch?.closest('td')?.textContent, scroll: plants.sideways().scroll, slidFind });
					find.searchInputEl.value = '';
					find.searchInputEl.dispatchEvent(new Event('input'));
					await sleep(300);
					check('Own 68: emptying Find takes the match off the copy', !strip().querySelector('.selectable-tables-match'));
					find.hide();
					await settle();

					// The freeze commands from a selected cell and an open one, Undo and Redo: the note's text as with the switch
					// off, Undo taking back the freeze alone, and the cell selected and in view after each.
					const commandsRun = async (on) => {
						preview.use(on);
						await sleep(400);
						view = await open('Frozen tables');
						await sleep(400);
						view.scrollDOM.scrollTop = 0;
						await sleep(200);
						const table = () => (on ? named(view, 'Plants') : null);
						const texts = [];
						const seen = [];
						const after = async () => {
							await sleep(400);
							await frames(3);
							texts.push(view.state.doc.toString());
							if (on) seen.push([table().cell && `${table().cell.row},${table().cell.column}`, clear(view, table())]);
						};
						const start = on ? table() : null;
						if (on) await selectAbove(view, start);
						else {
							const line = view.state.doc.toString().indexOf('## Plants');
							view.dispatch({ selection: { anchor: view.state.doc.lineAt(line).to + 1 }, scrollIntoView: true });
							view.focus();
							await sleep(250);
							await real('ArrowRight');
						}
						await key('Enter');
						for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight']) await key(k);
						app.commands.executeCommandById('selectable-tables:freeze-rows-and-columns');
						await after();
						await key('z', { meta: true });
						await after();
						await key('z', { meta: true, shift: true });
						await after();
						await key('z', { meta: true });
						await after();
						await key('Enter');
						const opened = !!(on ? oc(view) : view.contentDOM.querySelector('.cm-table-widget.has-focus'));
						app.commands.executeCommandById('selectable-tables:unfreeze-table');
						await after();
						const closed = on ? !oc(view) && table().cell?.row === 3 && table().cell?.column === 1 && view.hasFocus : true;
						await key('z', { meta: true });
						await after();
						await leave();
						await restore(view, frozenText);
						return { texts, seen, opened, closed };
					};
					const off = await commandsRun(false);
					const on = await commandsRun(true);
					// The mark on Plants' header line, two lines below its heading.
					const marks = (texts) => texts.map((text) => (text.slice(text.indexOf('## Plants')).split('\n')[2].match(/%%freeze \d+ \d+%%/) ?? ['none'])[0]);
					check('Own 69: freezing, Undo, Redo, Undo, Unfreeze from an open cell and Undo write the same text as with the switch off', on.texts.length === off.texts.length && on.texts.every((text, i) => text === off.texts[i]), { on: marks(on.texts), off: marks(off.texts) });
					check('Own 69: Undo takes back the freeze alone, and Redo puts it back', marks(on.texts).join() === '%%freeze 4 2%%,%%freeze 2 1%%,%%freeze 4 2%%,%%freeze 2 1%%,none,%%freeze 2 1%%', marks(on.texts));
					check('Own 69: after each, the cell stays selected and in view, clear of what\'s pinned', on.seen.every(([cell, at]) => cell === '3,1' && at === 'clear'), on.seen);
					check('Own 69: Unfreeze from an open cell closes it, leaves it selected, and the keyboard in the note', on.opened && on.closed, on);

					// The right-click menu: the freeze items on a cell of the plugin's table, with Unfreeze only for a table with a
					// mark, and inside an open cell. Obsidian draws its own menus for the check.
					const config = app.vault.config;
					const hadNative = Object.hasOwn(config, 'nativeMenus');
					const nativeBefore = config.nativeMenus;
					const shownMenu = () => Array.from(document.querySelectorAll('.menu')).pop() ?? null;
					const freezeItems = () => Array.from(shownMenu()?.querySelectorAll('.menu-item') ?? []).filter((item) => item.dataset.section === 'selectable-tables-freeze').map((item) => item.querySelector('.menu-item-title')?.textContent);
					const closeMenu = async () => {
						shownMenu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
						await sleep(200);
					};
					const choose = async (title) => {
						const item = Array.from(shownMenu()?.querySelectorAll('.menu-item') ?? []).find((el) => el.querySelector('.menu-item-title')?.textContent === title);
						if (!item) {
							await closeMenu();
							return false;
						}
						await pointAt(middle(item, 10));
						await sleep(300);
						return true;
					};
					try {
						config.nativeMenus = false;
						app.updateUseNativeMenu();
						// The parser reads only so far past the screen, so Sheds is found once it's scrolled to.
						view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.toString().indexOf('## Sheds'), { y: 'start' }) });
						await sleep(500);
						let sheds = named(view, 'Sheds');
						view.dispatch({ effects: view.constructor.scrollIntoView(sheds.from, { y: 'start', yMargin: 120 }) });
						await sleep(400);
						await pointAt(middle(sheds.cellElement({ row: 2, column: 1 })), 'right');
						const menuOne = freezeItems();
						const menus = document.querySelectorAll('.menu').length;
						const chose = await choose('Freeze columns up to here');
						await frames(3);
						sheds = named(view, 'Sheds');
						check('Own 70: a right-click on a cell of a table nothing freezes shows the three freeze items, in their own section, in one menu', menuOne.join() === 'Freeze rows up to here,Freeze columns up to here,Freeze rows and columns up to here' && menus === 1, { menuOne, menus });
						check('Own 70: Freeze columns up to here freezes up to the right-clicked cell, which is selected', chose && view.state.doc.lineAt(sheds.from).text.includes('%%freeze 0 2%%') && sheds.cell?.row === 2 && sheds.cell?.column === 1, { header: view.state.doc.lineAt(sheds.from).text.slice(0, 30), cell: sheds.cell });
						// The frozen header cell selected and the table moved sideways: nothing of its frame shows above the table
						// beside its copy's, as the real cell's did a pixel past it (STA-92's hand check, 11/22).
						await key('ArrowUp');
						await key('ArrowUp');
						sheds.slideToStart();
						await sleep(150);
						sheds.slideBy(250);
						await sleep(250);
						await frames(3);
						const shedsBlock = sheds.boxes[0];
						const shedsStrip = shedsBlock.querySelector('.selectable-tables-strip');
						const copyHead = shedsStrip?.querySelector('thead tr')?.cells[1];
						let peeking = null;
						if (shedsStrip && copyHead) {
							const top = Math.round(shedsStrip.getBoundingClientRect().top);
							const box = shedsBlock.getBoundingClientRect();
							const copyAt = copyHead.getBoundingClientRect();
							const shot = await window.electron.remote.getCurrentWebContents().capturePage({ x: Math.round(box.left), y: top - 3, width: Math.round(box.width), height: 3 });
							const bytes = shot.toBitmap();
							const width = Math.round(box.width);
							const [r0, g0, b0] = [bytes[2], bytes[1], bytes[0]];
							peeking = 0;
							for (let i = 0; i < bytes.length; i += 4) {
								const x = box.left + ((i / 4) % width);
								if (x >= copyAt.left - 2 && x <= copyAt.right + 2) continue;
								if (Math.abs(bytes[i + 2] - r0) + Math.abs(bytes[i + 1] - g0) + Math.abs(bytes[i] - b0) > 60) peeking++;
							}
						}
						check('Own 70: a selected frozen header cell, the table moved sideways, shows no line of its frame above the table beside its copy', sheds.cell?.row === 0 && peeking === 0, { cell: sheds.cell, peeking });
						await pointAt(middle(sheds.cellElement({ row: 3, column: 2 }), 10));
						const inside = oc(view);
						if (inside) await pointAt(middle(inside.view.contentDOM), 'right');
						const menuTwo = freezeItems();
						const choseTwo = await choose('Unfreeze table');
						await frames(3);
						sheds = named(view, 'Sheds');
						check('Own 70: a right-click inside an open cell shows the freeze items, Unfreeze too, and Unfreeze closes the cell and takes the mark out', !!inside && menuTwo.length === 4 && menuTwo[3] === 'Unfreeze table' && choseTwo && !view.state.doc.lineAt(sheds.from).text.includes('%%freeze') && !oc(view) && sheds.cell?.row === 3, { menuTwo, open: !!oc(view), header: view.state.doc.lineAt(sheds.from).text.slice(0, 30) });
						await closeMenu();
					} finally {
						if (hadNative) config.nativeMenus = nativeBefore;
						else delete config.nativeMenus;
						app.updateUseNativeMenu();
					}
					await leave();
					await restore(view, frozenText);

					// The 2,000-row table, in blocks of 100: deep down, a press on the pinned header opens the real cell at the
					// table's top, where it shows, and pins with the note while it's open; what's typed shows in the pinned
					// header's copies; a selected header cell's outline shows on the copy at every seam.
					view = await open('Frozen table 2000 by 12');
					await sleep(800);
					const bigText = view.state.doc.toString();
					const big = models(view)[0];
					await toRow(view, big, 520);
					const crossing = () => big.boxes.find((box) => {
						const r = box.isConnected && box.getBoundingClientRect();
						return r && r.top <= paneOf(view).top && r.bottom > paneOf(view).top;
					});
					const copyCell = (column) => crossing()?.querySelector('.selectable-tables-copy-table table')?.rows[0]?.cells[column];
					const pressed = copyCell(2);
					const pressedText = pressed?.textContent;
					if (pressed) await pointAt(middle(pressed, -6));
					await sleep(400);
					await frames(4);
					const deep = oc(view);
					check('Own 71: deep in the table, a press on the pinned header opens the real cell at the table\'s top, where it shows, with the keyboard', deep?.cell.row === 0 && deep.cell.column === 2 && deep.view.hasFocus && shows(deep.view.contentDOM) && deep.view.state.doc.toString() === pressedText, { open: deep?.cell, shows: deep && shows(deep.view.contentDOM), text: [deep?.view.state.doc.toString(), pressedText] });
					const deepInk = deep ? await inked(deep.view.contentDOM) : 0;
					check('Own 71: the open header cell is drawn on screen, its text showing under the hidden copy', deepInk > 20, { ink: deepInk });
					await key('End');
					await realType('q');
					view.scrollDOM.scrollTop += 600;
					await sleep(300);
					await frames(3);
					check('Own 71: scrolled on with it open, the open header cell pins at the pane\'s top and still shows', !!deep && shows(deep.view.contentDOM) && Math.abs(deep.view.dom.closest('th').getBoundingClientRect().top - paneOf(view).top) <= 2, { top: deep?.view.dom.closest('th')?.getBoundingClientRect().top, pane: paneOf(view).top });
					await leave();
					await toRow(view, big, 520);
					check('Own 71: after Escape, the pinned header deep down shows what was typed', copyCell(2)?.textContent === `${pressedText}q`, { copy: copyCell(2)?.textContent });
					for (let i = 0; i < 4 && view.state.doc.toString() !== bigText; i++) await key('z', { meta: true });
					await leave();
					await restore(view, bigText);
					// With the header cell open at the table's top, scrolled on within the first block past where its rows are
					// drawn, the frozen body row still pins under the header.
					view.scrollDOM.scrollTop = 0;
					await sleep(300);
					await toRow(view, big, 0);
					view.scrollDOM.scrollTop -= 200;
					await sleep(300);
					await frames(3);
					big.slideToStart();
					await sleep(200);
					await pointAt(middle(big.cellElement({ row: 0, column: 1 }), -6));
					const topOpen = oc(view);
					view.scrollDOM.scrollTop += 2400;
					await sleep(400);
					await frames(4);
					const below = big.cellElement({ row: 0, column: 1 })?.getBoundingClientRect();
					const hitRow = below && document.elementFromPoint(below.left + below.width / 2, paneOf(view).top + below.height + 6)?.closest('tr');
					const rowOne = !!hitRow && (hitRow.getAttribute('data-selectable-tables-row') === '1' || hitRow.getAttribute('aria-rowindex') === '2');
					check('Own 71: with the header cell open and the note scrolled on within the first block, the header and the frozen row under it stay pinned', topOpen?.cell.row === 0 && shows(topOpen.view.contentDOM) && rowOne, { open: topOpen?.cell, shows: topOpen && shows(topOpen.view.contentDOM), hitRow: hitRow?.outerHTML.slice(0, 120) });
					await leave();
					// Selected from above, Freeze rows up to a header cell, then Undo: Undo scrolls to the table's far end, and the
					// cell still ends in view.
					view.scrollDOM.scrollTop = 0;
					await sleep(300);
					await selectAbove(view, big);
					await key('Enter');
					await key('ArrowRight');
					app.commands.executeCommandById('selectable-tables:freeze-rows');
					await sleep(400);
					await key('z', { meta: true });
					await sleep(600);
					await frames(4);
					const undoneSeen = big.pins.chosenCopies.some((el) => shows(el)) || shows(big.cellElement(big.cell));
					check('Own 71: Undo of a freeze on the long table leaves the selected header cell in view', view.state.doc.toString() === bigText && big.cell?.row === 0 && undoneSeen, { cell: big.cell, seen: undoneSeen, text: view.state.doc.toString() === bigText });
					await leave();
					await restore(view, bigText);
					view.scrollDOM.scrollTop = 0;
					await sleep(300);
					await selectAbove(view, big);
					await key('Enter');
					await key('ArrowRight');
					const seams = [];
					for (const row of [60, 99, 101, 150, 199, 205, 1990]) {
						await toRow(view, big, row);
						seams.push([row, copyCell(1)?.classList.contains('selectable-tables-cell') && shows(copyCell(1))]);
					}
					check('Own 72: a selected header cell\'s outline shows on the pinned header across every seam', seams.every(([, ok]) => ok), seams);
					await leave();

					// 60 seeded random steps on both tables: keys, presses on real cells, pinned copies and the strip, the freeze
					// commands, Undo and Redo, typing, scrolling and swipes. After each, nothing crashed and the drawing, the copies
					// and the strip included, matches the text.
					let seed = 92;
					const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
					const pick = (list) => list[Math.floor(random() * list.length)];
					let bad = null;
					const log = [];
					for (const [note, steps] of [['Frozen tables', 30], ['Frozen table 2000 by 12', 30]]) {
						view = await open(note);
						await sleep(note === 'Frozen tables' ? 400 : 800);
						const text = view.state.doc.toString();
						const table = () => (note === 'Frozen tables' ? named(view, 'Plants') : models(view)[0]);
						await selectAbove(view, table());
						await key('Enter');
						for (let step = 0; step < steps && !bad; step++) {
							const roll = random();
							let what;
							const t = table();
							if (roll < 0.35) {
								const k = pick(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Tab', 'Enter', 'Escape', 'Home', 'End', 'PageDown', 'PageUp']);
								what = k;
								await key(k, { shift: k === 'Tab' && random() < 0.3 });
							} else if (roll < 0.55) {
								const kind = pick(['rail', 'strip', 'corner', 'real']);
								const box = t.boxes.find((b) => b.isConnected && b.getBoundingClientRect().top <= paneOf(view).bottom && b.getBoundingClientRect().bottom > paneOf(view).top);
								const sel = { rail: '.selectable-tables-copy-table td, .selectable-tables-copy-table th', strip: '.selectable-tables-strip td', corner: '.selectable-tables-corner th, .selectable-tables-corner td', real: ':scope > .table-wrapper td' }[kind];
								const cells = box ? Array.from(box.querySelectorAll(sel)).filter((el) => shows(el)) : [];
								what = `press ${kind}`;
								if (cells.length) await pointAt(middle(pick(cells), 8));
							} else if (roll < 0.65) {
								const c = pick(['freeze-rows', 'freeze-columns', 'freeze-rows-and-columns', 'unfreeze-table']);
								what = c;
								app.commands.executeCommandById(`selectable-tables:${c}`);
								await settle();
							} else if (roll < 0.75) {
								what = random() < 0.6 ? 'undo' : 'redo';
								await key('z', { meta: true, shift: what === 'redo' });
							} else if (roll < 0.85) {
								what = 'type';
								if (oc(view)) await realType('ab');
								else await key('Enter');
							} else if (roll < 0.93) {
								what = 'scroll';
								view.scrollDOM.scrollTop += (random() - 0.4) * 1500;
								await sleep(200);
							} else {
								what = 'swipe';
								t.slideBy((random() - 0.4) * 400);
								await sleep(150);
							}
							await sleep(150);
							await frames(3);
							const s = steady(view);
							log.push(what);
							if (!steadyOk(s)) bad = { note, step, what, steady: s, last: log.slice(-6) };
						}
						await leave();
						await leave();
						await restore(view, text);
					}
					check('Own 73: after each of 60 seeded random keys, presses on pinned cells and the strip, freezes, Undo, Redo, typing, scrolls and swipes, nothing crashed and the drawing matches the text, copies included', !bad, bad);
					view = await open('Watering schedule');
					await sleep(300);
					for (const name of touched) {
						const file = app.vault.getAbstractFileByPath(`${name}.md`);
						if ((await app.vault.read(file)) !== onDiskBefore[name]) await app.vault.modify(file, onDiskBefore[name]);
					}
					preview.use(false);
					await sleep(300);
				}
				if (!window.__checkCellsOnly || window.__checkEditsOnly) {
					// --- Editing rows and columns of the plugin's table (STA-97): the right-click menu's Row, Column and Sort items,
					// the table commands, and Tab and Enter adding a row, each against Obsidian's own table with the switch off. Real
					// keys and presses through the window's debugger. Run alone with window.__checkOwnOnly, __checkCellsOnly and
					// __checkEditsOnly all true.
					preview.use(true);
					await sleep(400);
					const codes = { Escape: 27, Enter: 13, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Backspace: 8, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
					const key = async (name, { alt, ctrl, meta, shift, repeat } = {}) => {
						const modifiers = (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);
						const code = codes[name] ?? name.toUpperCase().charCodeAt(0);
						const text = name.length === 1 && !(modifiers & 6) ? name : '';
						const event = { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, windowsVirtualKeyCode: code, modifiers, autoRepeat: !!repeat, unmodifiedText: macChar(name), text };
						await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: text ? 'keyDown' : 'rawKeyDown' });
						await cdp.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' });
						await settle();
					};
					const pointAt = async ({ x, y }, button = 'left') => {
						await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
						await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 });
						await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 });
						await sleep(350);
					};
					const hover = async ({ x, y }) => {
						await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
						await sleep(450);
					};
					const middle = (el, dx = null) => {
						const r = el.getBoundingClientRect();
						return { x: dx === null ? r.left + r.width / 2 : dx < 0 ? r.right + dx : r.left + dx, y: r.top + r.height / 2 };
					};
					const oc = (view) => preview.openCell(view);
					// A row's cells, without their padding: `\|` is a pipe in a cell's text.
					const rowCells = (line) => {
						const cells = [];
						let cell = '';
						const text = line.trim().replace(/^\|/, '');
						for (let i = 0; i < text.length; i++) {
							if (text[i] === '\\') cell += text[i] + (text[++i] ?? '');
							else if (text[i] === '|') {
								cells.push(cell.trim());
								cell = '';
							} else cell += text[i];
						}
						if (cell.trim()) cells.push(cell.trim());
						return cells;
					};
					const openAtNow = (view) => (oc(view) ? `${oc(view).cell.row},${oc(view).cell.column}` : null);
					const tableAt = (view, heading) => {
						const at = heading ? view.state.doc.toString().indexOf(`## ${heading}`) : 0;
						return models(view).find((model) => model.from > at);
					};
					// The drawn cell of a table, the plugin's or Obsidian's, by its row and column, the header being row 0.
					const cellOf = (view, on, heading, row, column) => {
						if (on) return tableAt(view, heading)?.cellElement({ row, column }) ?? null;
						const at = heading ? view.state.doc.toString().indexOf(`## ${heading}`) : 0;
						const widget = Array.from(view.contentDOM.querySelectorAll(':scope > .cm-table-widget')).find((el) => view.posAtDOM(el) > at);
						return widget?.querySelector('table')?.rows[row]?.cells[column] ?? null;
					};
					const scrollTo = async (view, heading) => {
						const at = heading ? view.state.doc.toString().indexOf(`## ${heading}`) : 0;
						view.dispatch({ effects: view.constructor.scrollIntoView(at, { y: 'start' }) });
						await sleep(400);
						await frames(3);
					};
					// Opens a cell with a press at its start, the plugin's or Obsidian's.
					const openCellAt = async (view, on, heading, row, column) => {
						const td = cellOf(view, on, heading, row, column);
						if (!td) return false;
						await pointAt(middle(td, 6));
						await sleep(200);
						return on ? openAtNow(view) === `${row},${column}` : !!view.contentDOM.querySelector('.cm-table-widget.has-focus');
					};
					// Where a right-click reaches an open cell's own menu: its text. Obsidian's open cell offers no table items in its
					// padding (STA-61), so the checks press its text.
					const menuAt = (view, on, heading, row, column) => {
						const td = cellOf(view, on, heading, row, column);
						const line = td?.querySelector('.cm-editor .cm-line');
						return middle(line ?? td, 4);
					};
					const leaveAll = async (view) => {
						await key('Escape');
						await key('Escape');
						await key('Escape');
						view.dispatch({ selection: { anchor: 0 } });
						await sleep(150);
					};
					const config = app.vault.config;
					const hadNative = Object.hasOwn(config, 'nativeMenus');
					const nativeBefore = config.nativeMenus;
					const menusShown = () => Array.from(document.querySelectorAll('.menu'));
					const titlesOf = (menu) => Array.from(menu?.querySelectorAll(':scope > .menu-scroll > .menu-group > .menu-item, :scope > .menu-scroll > .menu-item') ?? []).map((item) => item.querySelector('.menu-item-title')?.textContent ?? '');
					const closeMenus = async () => {
						for (let i = 0; i < 3 && menusShown().length; i++) {
							menusShown().pop()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
							await sleep(200);
						}
					};
					const itemIn = (menu, title) => Array.from(menu?.querySelectorAll('.menu-item') ?? []).find((el) => el.querySelector('.menu-item-title')?.textContent === title) ?? null;
					// The menu shown now, its Row and Column submenus' items too, read by hovering them.
					const readMenu = async () => {
						const top = menusShown()[0];
						const read = { top: titlesOf(top) };
						for (const title of ['Row', 'Column']) {
							const item = itemIn(top, title);
							if (!item) continue;
							await hover(middle(item, 10));
							read[title] = menusShown().length > 1 ? titlesOf(menusShown().pop()) : [];
						}
						return read;
					};
					// Picks an item of the menu shown, under Row or Column when it's one of theirs.
					const pick = async (under, title) => {
						const top = menusShown()[0];
						let menu = top;
						if (under) {
							const parent = itemIn(top, under);
							if (!parent) return false;
							await hover(middle(parent, 10));
							menu = menusShown().length > 1 ? menusShown().pop() : null;
						}
						const item = itemIn(menu, title);
						if (!item) {
							await closeMenus();
							return false;
						}
						await pointAt(middle(item, 10));
						await sleep(400);
						await frames(3);
						return true;
					};
					const touched = ['Two report tables', 'Table controls', 'Frozen tables', 'Table 2000 by 12'];
					const onDiskBefore = {};
					for (const name of touched) onDiskBefore[name] = await app.vault.read(app.vault.getAbstractFileByPath(`${name}.md`));
					let view;
					try {
						config.nativeMenus = false;
						app.updateUseNativeMenu();

						// The menu: on a cell that isn't open, over an open cell's text, and in an open cell's empty space below its
						// text, against Obsidian's own table's menus with the switch off.
						const menusFor = async (on) => {
							preview.use(on);
							await sleep(400);
							view = await open('Two report tables');
							await sleep(300);
							const read = {};
							await pointAt(middle(cellOf(view, on, null, 2, 0)), 'right');
							read.closed = await readMenu();
							await closeMenus();
							await openCellAt(view, on, null, 1, 0);
							const editor = view.contentDOM.querySelector('.cm-table-widget.has-focus .cm-content') ?? oc(view)?.view.contentDOM;
							if (editor) await pointAt(middle(editor.querySelector('.cm-line') ?? editor, 4), 'right');
							read.open = await readMenu();
							await closeMenus();
							await leaveAll(view);
							return read;
						};
						const offMenus = await menusFor(false);
						const onMenus = await menusFor(true);
						const tableTop = ['Row', 'Column', 'Sort by column (A to Z)', 'Sort by column (Z to A)', 'Freeze rows up to here', 'Freeze columns up to here', 'Freeze rows and columns up to here'];
						check('Own 74: a right-click on a cell that isn\'t open shows Row, Column, the two sorts, then the freeze items, as Obsidian\'s own table does', onMenus.closed.top.join() === tableTop.join() && offMenus.closed.top.join() === tableTop.join(), { on: onMenus.closed.top, off: offMenus.closed.top });
						check('Own 74: its Row and Column submenus hold Obsidian\'s items, worded and ordered as in Obsidian\'s', JSON.stringify([onMenus.closed.Row, onMenus.closed.Column]) === JSON.stringify([offMenus.closed.Row, offMenus.closed.Column]) && onMenus.closed.Row?.length === 6 && onMenus.closed.Column?.length === 8, { on: [onMenus.closed.Row, onMenus.closed.Column], off: [offMenus.closed.Row, offMenus.closed.Column] });
						// Obsidian's open cell puts the freeze items, from editor-menu, before its own table items; the plugin's cell puts
						// the table items first, then the freeze items, as on a cell that isn't open.
						const textItems = (titles) => titles.filter((title) => !tableTop.includes(title));
						const tableItemsOf = (titles) => titles.filter((title) => ['Row', 'Column', 'Sort by column (A to Z)', 'Sort by column (Z to A)'].includes(title));
						check('Own 74: over an open cell\'s text, the same text items come first as in Obsidian\'s open cell, then the table items and the freeze items', textItems(onMenus.open.top).length > 0 && textItems(onMenus.open.top).join() === textItems(offMenus.open.top).join() && onMenus.open.top.slice(onMenus.open.top.indexOf('Row')).join() === tableTop.join() && tableItemsOf(offMenus.open.top).join() === tableItemsOf(tableTop).join() && JSON.stringify(onMenus.open.Row) === JSON.stringify(offMenus.open.Row), { on: onMenus.open.top, off: offMenus.open.top, rows: [onMenus.open.Row, offMenus.open.Row] });

						// The empty space below a short cell's text in a tall row, open.
						view = await open('Table controls');
						await sleep(300);
						await scrollTo(view, 'Seeds');
						await openCellAt(view, true, 'Seeds', 4, 0);
						const shortCell = tableAt(view, 'Seeds').cellElement({ row: 4, column: 0 });
						const below = shortCell.getBoundingClientRect();
						const textBottom = oc(view)?.view.contentDOM.getBoundingClientRect().bottom ?? below.top;
						await pointAt({ x: below.left + 12, y: Math.min(below.bottom - 4, textBottom + (below.bottom - textBottom) / 2) }, 'right');
						const empty = await readMenu();
						await closeMenus();
						check('Own 74: a right-click in an open cell\'s empty space below its text shows the table items and the freeze items', empty.top.join() === tableTop.join() && below.bottom - textBottom > 10, { top: empty.top, room: below.bottom - textBottom });
						await leaveAll(view);

						// Every item, from an open cell in Seeds, against Obsidian's own: the note's text, and Undo and Redo.
						const items = [
							['Row', 'Add row above'], ['Row', 'Add row below'], ['Row', 'Move row up'], ['Row', 'Move row down'], ['Row', 'Duplicate row'], ['Row', 'Delete row'],
							['Column', 'Add column to the left'], ['Column', 'Add column to the right'], ['Column', 'Move column left'], ['Column', 'Move column right'],
							['Column', 'Align left'], ['Column', 'Align center'], ['Column', 'Align right'], ['Column', 'Duplicate column'], ['Column', 'Delete column'],
							[null, 'Sort by column (A to Z)'], [null, 'Sort by column (Z to A)'],
						];
						const itemsRun = async (on, heading, row, column) => {
							preview.use(on);
							await sleep(400);
							view = await open('Table controls');
							await sleep(300);
							const text = view.state.doc.toString();
							const out = [];
							for (const [under, title] of items) {
								await scrollTo(view, heading);
								const opened = await openCellAt(view, on, heading, row, column);
								await pointAt(menuAt(view, on, heading, row, column), 'right');
								const picked = await pick(under, title);
								await sleep(300);
								const after = view.state.doc.toString();
								const where = on ? { open: openAtNow(view), selected: tableAt(view, heading)?.cell ?? null } : null;
								await key('z', { meta: true });
								await sleep(300);
								const undone = view.state.doc.toString();
								await key('z', { meta: true, shift: true });
								await sleep(300);
								const redone = view.state.doc.toString();
								out.push({ title, opened, picked, after, undone: undone === text, redone: redone === after, where });
								await leaveAll(view);
								await restore(view, text);
							}
							return { out, text };
						};
						const offItems = await itemsRun(false, 'Seeds', 2, 1);
						const onItems = await itemsRun(true, 'Seeds', 2, 1);
						const differ = onItems.out.filter((each, i) => each.after !== offItems.out[i]?.after || each.after === onItems.text).map((each) => each.title);
						const seedsOf = (text) => text.slice(text.indexOf('## Seeds'), text.indexOf('A line between'));
						const firstDiffer = onItems.out.findIndex((each, i) => each.after !== offItems.out[i]?.after || each.after === onItems.text);
						check('Own 75: each Row, Column and Sort item, from an open cell, writes the same text as Obsidian\'s own table does', differ.length === 0 && onItems.out.every((each) => each.opened && each.picked), { differ, unpicked: onItems.out.filter((each) => !each.opened || !each.picked).map((each) => each.title), offUnpicked: offItems.out.filter((each) => !each.opened || !each.picked).map((each) => each.title), first: firstDiffer >= 0 ? { title: onItems.out[firstDiffer].title, on: seedsOf(onItems.out[firstDiffer].after), off: seedsOf(offItems.out[firstDiffer].after), was: seedsOf(onItems.text) } : null });
						check('Own 75: Undo takes each edit back alone, and Redo puts it back', onItems.out.every((each) => each.undone && each.redone), onItems.out.filter((each) => !each.undone || !each.redone).map((each) => each.title));
						const ended = Object.fromEntries(onItems.out.map((each) => [each.title, each.where.open]));
						check('Own 76: after an item from an open cell, the new row\'s or column\'s cell opens, the moved cell opens in its place, and Delete opens the cell above or to the left', ended['Add row above'] === '2,1' && ended['Add row below'] === '3,1' && ended['Move row up'] === '1,1' && ended['Move row down'] === '3,1' && ended['Delete row'] === '1,1' && ended['Add column to the left'] === '2,1' && ended['Add column to the right'] === '2,2' && ended['Move column left'] === '2,0' && ended['Move column right'] === '2,2' && ended['Delete column'] === '2,0' && ended['Sort by column (A to Z)'] === '2,1', ended);
						const sorted = (text) => text.slice(text.indexOf('## Seeds')).split('\n').slice(6, 12).map((line) => line.split('|')[1].trim());
						const az = onItems.out.find((each) => each.title === 'Sort by column (A to Z)');
						check('Own 75: Sort orders Count as numbers, the header kept on top', sorted(az.after).join() === 'bean,apple,Apricot,Basil,**Carrot top**,**Pear**', sorted(az.after));

						// The hand-spaced table: tidied on its first edit, as Obsidian's own table leaves it.
						const handRun = async (on) => {
							preview.use(on);
							await sleep(400);
							view = await open('Table controls');
							await sleep(300);
							const text = view.state.doc.toString();
							await scrollTo(view, 'Spaced by hand');
							await openCellAt(view, on, 'Spaced by hand', 1, 0);
							await pointAt(menuAt(view, on, 'Spaced by hand', 1, 0), 'right');
							await pick('Row', 'Move row down');
							const after = view.state.doc.toString();
							await leaveAll(view);
							await restore(view, text);
							return after;
						};
						const handOff = await handRun(false);
						const handOn = await handRun(true);
						check('Own 77: a table spaced by hand comes out tidied on its first edit, as Obsidian\'s own table leaves it', handOn === handOff && handOn.includes('| Hoe  | South |'), { on: handOn.slice(handOn.indexOf('## Spaced')), off: handOff.slice(handOff.indexOf('## Spaced')) });

						// The commands, from a selected cell: Fern moves down, then right, and stays selected, with nothing open; with no
						// cell selected or open, no table command is offered, and Obsidian's own aren't either.
						preview.use(true);
						await sleep(400);
						view = await open('Two report tables');
						await sleep(300);
						const reportText = view.state.doc.toString();
						const firstTable = models(view)[0];
						const above = view.state.doc.line(view.state.doc.lineAt(firstTable.from).number - 1);
						view.dispatch({ selection: { anchor: above.to }, scrollIntoView: true });
						view.focus();
						await sleep(250);
						await key('ArrowRight');
						await key('Enter');
						await key('ArrowDown');
						const offeredNow = (id) => {
							const command = app.commands.commands[id];
							const md = app.workspace.activeEditor;
							return !!command?.editorCheckCallback?.(true, md.editor, md);
						};
						const ids = ['row-before', 'row-after', 'row-up', 'row-down', 'row-copy', 'row-delete', 'col-before', 'col-after', 'col-left', 'col-right', 'col-copy', 'col-delete', 'col-align-left', 'col-align-center', 'col-align-right'];
						const withCell = ids.filter((id) => offeredNow(`selectable-tables:table-${id}`));
						const obsidianWithCell = ids.filter((id) => offeredNow(`editor:table-${id}`));
						app.commands.executeCommandById('selectable-tables:table-row-down');
						await sleep(300);
						const afterDown = { cell: models(view)[0].cell, open: openAtNow(view), line: view.state.doc.line(view.state.doc.lineAt(models(view)[0].from).number + 3).text };
						app.commands.executeCommandById('selectable-tables:table-col-right');
						await sleep(300);
						const afterRight = { cell: models(view)[0].cell, open: openAtNow(view), line: view.state.doc.line(view.state.doc.lineAt(models(view)[0].from).number + 3).text };
						check('Own 78: with Fern selected, every table command is offered but Move column left, and none of Obsidian\'s', withCell.length === 14 && !withCell.includes('col-left') && !obsidianWithCell.length, { withCell, obsidianWithCell });
						check('Own 78: Move row down, then Move column right, from a selected cell move Fern and keep it selected, with nothing open', afterDown.cell?.row === 2 && afterDown.cell?.column === 0 && !afterDown.open && afterDown.line.startsWith('| Fern') && afterRight.cell?.row === 2 && afterRight.cell?.column === 1 && !afterRight.open && /^\| \S+ +\| Fern/.test(afterRight.line), { afterDown, afterRight });
						app.commands.executeCommandById('selectable-tables:table-row-delete');
						await sleep(300);
						check('Own 78: Delete row on a selected cell selects the cell above', models(view)[0].cell?.row === 1 && models(view)[0].cell?.column === 1 && !openAtNow(view), { cell: models(view)[0].cell });
						await leaveAll(view);
						const withoutCell = ids.filter((id) => offeredNow(`selectable-tables:table-${id}`));
						check('Own 78: with no cell selected or open, no table command is offered', withoutCell.length === 0, withoutCell);
						await restore(view, reportText);

						// Tab and Enter add a row on a fresh press at the table's end, and never on a held key.
						const rowsNow = () => view.state.doc.toString().split('\n').filter((line) => line.startsWith('|')).length;
						const linesBefore = rowsNow();
						await scrollTo(view, null);
						await openCellAt(view, true, null, 0, 0);
						for (let i = 0; i < 11; i++) await key('Tab');
						const tapAtEnd = { open: openAtNow(view), rows: rowsNow() - linesBefore };
						await key('Tab');
						await sleep(300);
						await frames(3);
						const tapped = { open: openAtNow(view), rows: rowsNow() - linesBefore, hasFocus: oc(view)?.view.hasFocus };
						await key('z', { meta: true });
						await sleep(300);
						await leaveAll(view);
						await restore(view, reportText);
						await scrollTo(view, null);
						await openCellAt(view, true, null, 0, 0);
						await key('Tab');
						for (let i = 0; i < 20; i++) await key('Tab', { repeat: true });
						const held = { open: openAtNow(view), rows: rowsNow() - linesBefore };
						await leaveAll(view);
						await openCellAt(view, true, null, 3, 1);
						await key('Enter');
						await sleep(300);
						await frames(3);
						const entered = { open: openAtNow(view), rows: rowsNow() - linesBefore };
						for (let i = 0; i < 5; i++) await key('Enter', { repeat: true });
						const enterHeld = { open: openAtNow(view), rows: rowsNow() - linesBefore };
						check('Own 79: tapping Tab through the cells stops at the last, and one more tap adds a row and opens its first cell, with the keyboard', tapAtEnd.open === '3,2' && tapAtEnd.rows === 0 && tapped.open === '4,0' && tapped.rows === 1 && tapped.hasFocus, { tapAtEnd, tapped });
						check('Own 79: holding Tab stops at the last cell and adds nothing', held.open === '3,2' && held.rows === 0, held);
						check('Own 79: Enter on the last row adds a row below and opens its cell in the same column; held, it adds no more', entered.open === '4,1' && entered.rows === 1 && enterHeld.rows === 1, { entered, enterHeld });
						await leaveAll(view);
						await restore(view, reportText);

						// Frozen tables: the mark stays in the header, so the table stays frozen as before.
						view = await open('Frozen tables');
						await sleep(400);
						const frozenText = view.state.doc.toString();
						const headerOf = () => view.state.doc.lineAt(tableAt(view, 'Plants').from).text;
						const freezeBefore = headerOf().match(/%%freeze \d+ \d+%%/)?.[0];
						await scrollTo(view, 'Plants');
						await openCellAt(view, true, 'Plants', 0, 1);
						app.commands.executeCommandById('selectable-tables:table-row-down');
						await sleep(400);
						const downHeader = headerOf();
						await leaveAll(view);
						await scrollTo(view, 'Plants');
						const markColumn = rowCells(headerOf()).findIndex((cell) => cell.includes('%%freeze'));
						await openCellAt(view, true, 'Plants', 2, markColumn);
						app.commands.executeCommandById('selectable-tables:table-col-delete');
						await sleep(400);
						const deletedHeader = headerOf();
						const firstHas = (header) => rowCells(header)[0].startsWith(freezeBefore) && rowCells(header).filter((cell) => cell.includes('%%freeze')).length === 1;
						check('Own 80: Move row down on a frozen table\'s header keeps the mark in the new header\'s first cell, and the table frozen as before', !!freezeBefore && firstHas(downHeader) && tableAt(view, 'Plants').pins.freeze.rows > 0, { freezeBefore, downHeader: downHeader.slice(0, 60) });
						check('Own 80: Delete column on the mark\'s column moves the mark to the header\'s first cell', firstHas(deletedHeader), deletedHeader.slice(0, 60));
						await leaveAll(view);
						await restore(view, frozenText);

						// The 2,000-row table: Delete row on row 1,500, Move row down on row 100 across a seam, Sort on column 2. Each
						// writes the right text, under 1 s, and the row at the pane's bottom stays where it was.
						view = await open('Table 2000 by 12');
						await sleep(1500);
						const bigText = view.state.doc.toString();
						const big = models(view)[0];
						const headerLine = view.state.doc.lineAt(big.from).number;
						const bigLines = () => {
							const lines = [];
							for (let n = headerLine; n <= view.state.doc.lineAt(models(view)[0].to).number; n++) lines.push(view.state.doc.line(n).text);
							return lines;
						};
						// The table as Obsidian's table writes it: an edit writes it all again, so a table someone typed in by hand, as
						// this git-ignored note can be after a hand check, comes out tidied, its columns as wide as their longest text.
						const tidy = (lines) => {
							const rows = lines.filter((_, i) => i !== 1).map(rowCells);
							const aligns = rowCells(lines[1]).map((c) => (c.startsWith(':') ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null));
							const widths = aligns.map((_, c) => Math.max(5, ...rows.map((r) => (r[c] ?? '').length + 2)));
							const pad = (text, width, align) => {
								const space = width - text.length;
								const lead = align === 'right' ? space - 1 : align === 'center' ? Math.floor(space / 2) : 1;
								return ' '.repeat(lead) + text + ' '.repeat(space - lead);
							};
							const dashes = (width, align) => (align === 'left' ? ` :${'-'.repeat(width - 3)} ` : align === 'center' ? ` :${'-'.repeat(width - 4)}: ` : align === 'right' ? ` ${'-'.repeat(width - 3)}: ` : ` ${'-'.repeat(width - 2)} `);
							const out = rows.map((r) => `|${aligns.map((a, c) => pad(r[c] ?? '', widths[c], a)).join('|')}|`);
							out.splice(1, 0, `|${aligns.map((a, c) => dashes(widths[c], a)).join('|')}|`);
							return out;
						};
						// Timed on the table as Obsidian writes it, as the note is in git, so the first edit isn't the one that tidies it.
						const tidied = tidy(bigLines());
						const bigStart = view.state.doc.line(headerLine).from;
						view.dispatch({ changes: { from: bigStart, to: view.state.doc.lineAt(models(view)[0].to).to, insert: tidied.join('\n') } });
						await sleep(1500);
						await frames(3);
						const tidyText = view.state.doc.toString();
						const before = tidied;
						// The row at the pane's bottom, by its first cell, which counts the rows, and where it is; and the note's scroll.
						const bottomRow = () => {
							const pane = view.scrollDOM.getBoundingClientRect();
							const left = view.contentDOM.getBoundingClientRect().left;
							const hit = document.elementFromPoint(left + 40, pane.top + view.scrollDOM.clientHeight - 80)?.closest('tr');
							return { text: hit?.cells[0]?.textContent.trim() ?? null, top: hit?.getBoundingClientRect().top ?? null, scroll: view.scrollDOM.scrollTop };
						};
						const timedEdit = async (row, column, id) => {
							await leaveAll(view);
							view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.line(headerLine + 1 + row).from, { y: 'center' }) });
							await sleep(500);
							await frames(3);
							await openCellAt(view, true, null, row, column);
							const bottom = bottomRow();
							const start = performance.now();
							app.commands.executeCommandById(id);
							await frames(2);
							const ms = performance.now() - start;
							await sleep(500);
							await frames(3);
							const now = bottomRow();
							const lines = bigLines();
							await leaveAll(view);
							return { ms: Math.round(ms), lines, bottom, now };
						};
						const deleted = await timedEdit(1500, 1, 'selectable-tables:table-row-delete');
						const deletedRight = deleted.lines.length === before.length - 1 && deleted.lines.join('\n') === [...before.slice(0, 1501), ...before.slice(1502)].join('\n');
						await restore(view, tidyText);
						const moved = await timedEdit(100, 1, 'selectable-tables:table-row-down');
						const movedRight = moved.lines.join('\n') === [...before.slice(0, 101), before[102], before[101], ...before.slice(103)].join('\n');
						await restore(view, tidyText);
						// Sort through the menu, since it has no command.
						await leaveAll(view);
						view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.line(headerLine + 400).from, { y: 'center' }) });
						await sleep(500);
						await frames(3);
						const sortBottom = bottomRow();
						const anyCell = Array.from(view.contentDOM.querySelectorAll('.selectable-tables-own tbody td')).find((td) => td.isConnected && td.cellIndex === 1 && td.getBoundingClientRect().top > view.scrollDOM.getBoundingClientRect().top + 80);
						await pointAt(middle(anyCell, 6), 'right');
						const sortItem = itemIn(menusShown()[0], 'Sort by column (A to Z)');
						const sortStart = performance.now();
						if (sortItem) await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...middle(sortItem, 10), button: 'left', clickCount: 1 });
						if (sortItem) await cdp.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...middle(sortItem, 10), button: 'left', clickCount: 1 });
						await frames(2);
						const sortMs = Math.round(performance.now() - sortStart);
						await sleep(600);
						await frames(3);
						const sortNow = bottomRow();
						const sortedLines = bigLines();
						const collator = new Intl.Collator(undefined, { usage: 'sort', sensitivity: 'base', numeric: true });
						const sortColumn = anyCell.cellIndex;
						const bodySorted = sortedLines.slice(2).every((line, i, all) => i === 0 || collator.compare(rowCells(all[i - 1])[sortColumn], rowCells(line)[sortColumn]) <= 0);
						const sameRows = [...sortedLines.slice(2)].sort().join('\n') === [...before.slice(2)].sort().join('\n') && sortedLines[0] === before[0];
						await leaveAll(view);
						await restore(view, bigText);
						// The note doesn't scroll, and below an edit that keeps the number of rows, the row at the bottom is the same one.
						const stays = (r, sameRow) => Math.abs(r.bottom.scroll - r.now.scroll) <= 2 && (!sameRow || (r.bottom.text === r.now.text && Math.abs(r.bottom.top - r.now.top) <= 2));
						const firstOff = (got, want) => {
							const i = want.findIndex((line, n) => got[n] !== line);
							return i < 0 ? (got.length === want.length ? null : { lengths: [got.length, want.length] }) : { at: i, got: got[i]?.slice(0, 80), want: want[i]?.slice(0, 80), lengths: [got.length, want.length] };
						};
						check('Own 81: in Table 2000 by 12, Delete row on row 1,500, Move row down on row 100 across a seam, and Sort A to Z each write the right text', deletedRight && movedRight && bodySorted && sameRows && !!sortItem, { deletedRight, movedRight, bodySorted, sameRows, sortItem: !!sortItem, deleted: firstOff(deleted.lines, [...before.slice(0, 1501), ...before.slice(1502)]), moved: firstOff(moved.lines, [...before.slice(0, 101), before[102], before[101], ...before.slice(103)]), sortHeader: [sortedLines[0]?.slice(0, 60), before[0]?.slice(0, 60)], sortLengths: [sortedLines.length, before.length] });
						check('Own 81: each takes under 1 s', deleted.ms < 1000 && moved.ms < 1000 && sortMs < 1000, { deleted: deleted.ms, moved: moved.ms, sort: sortMs });
						check('Own 81: the row at the pane\'s bottom stays where it was', stays(deleted, false) && stays(moved, true) && stays({ bottom: sortBottom, now: sortNow }, false), { deleted: [deleted.bottom, deleted.now], moved: [moved.bottom, moved.now], sort: [sortBottom, sortNow] });
						results.push({ name: 'Own 81 timings (ms)', ok: true, detail: { deleteRow1500: deleted.ms, moveRow100: moved.ms, sortColumn2: sortMs } });
						check('Own 81: nothing crashed, and the drawing matches the text', crashed(view) === 0 && rowsRight(view).length === 0, { crashed: crashed(view), rows: rowsRight(view).slice(0, 5) });
					} finally {
						await closeMenus();
						if (hadNative) config.nativeMenus = nativeBefore;
						else delete config.nativeMenus;
						app.updateUseNativeMenu();
						view = await open('Watering schedule');
						await sleep(300);
						for (const name of touched) {
							const file = app.vault.getAbstractFileByPath(`${name}.md`);
							if ((await app.vault.read(file)) !== onDiskBefore[name]) await app.vault.modify(file, onDiskBefore[name]);
						}
						preview.use(false);
						await sleep(300);
					}
				}
			} finally {
				preview.skew(0);
				preview.use(false);
				await sleep(300);
			}
		}
	} catch (error) {
		results.push({ name: 'the check script itself', ok: false, detail: String(error && error.stack || error) });
	}
	if (previewWasOn) {
		const plugin = app.plugins.plugins['selectable-tables'];
		await plugin.saveData({ ...(await plugin.loadData()), ownTables: true });
		plugin.preview.use(true);
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
