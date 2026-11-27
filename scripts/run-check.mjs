// Runs scripts/obsidian-check.js in the test vault's window, one section at a time, and always ends with an answer: each
// section's results as it ends, or why there are none. It sets the vault up as the checks expect first, puts the vault
// back and reloads the plugin between sections, so nothing one section leaves behind reaches the next, and puts back
// what it changed at the end.
//
//   node scripts/run-check.mjs [--only <sections>] [--install] [--minimize] [--minutes <n>] [--stall 10]
//
//   --only <sections> one section, or several split by commas, by name: tables (the plugin's table before its cells:
//                     drawing, edits, panes, sideways scrolling), cells, frozenCells, corners (part of frozenCells), edits, drags, shades, ranges, cellDrags,
//                     cellEdits, formatting, clicks, rangeMenus, typing, links, defaultFreeze, fallback (Obsidian's own
//                     tables where the plugin's doesn't draw). own is every section. Without it, every section.
//   --install         builds the plugin and copies it into the vault's plugin folder first.
//   --minimize        minimizes the window if it's in front. That changes the screen, so only with Brian's OK.
//   --minutes <n>     the whole run's deadline (default 180 for every section, 90 for --only).
//   --stall <n>       stops a section that reports nothing new for this long (default 10), and goes on to the next.
//   --script <file>   another copy of obsidian-check.js, such as another worktree's.
//
// Before the run it fixes what it can and says so: the window's throttling and focus emulation, Obsidian's own menus in
// place of the Mac's, which show on the screen even with the window minimized, leftover window.__check* flags, custom
// hotkeys (set aside in memory, never saved, since the checks press keys as Obsidian binds them by default), extra panes,
// and the build, reloaded from disk. It stops before starting when the window isn't minimized, or when a check script is
// still running there and won't stop. It warns about a theme, snippets or changed sample notes, which it leaves alone.
// Between sections it puts back the panes, the theme, light or dark, snippets, hotkeys and the plugin's settings as the
// run found them, reloads the plugin, and names what the section before had left. It takes the timing lock
// (/tmp/obsidian-timing.lock) for the whole run, waiting within the deadline while another chat holds it. Afterwards it
// puts back the hotkeys from hotkeys.json, the panes, the throttling, the debugger and the menus, writes every section's
// results to check-results.json, and releases the lock, whatever happened. Exit codes: 0 all passed, 1 some failed, 2 a
// section gave no results and the run couldn't go on (the window stopped answering, or a section wouldn't stop), or the
// deadline cut it short, 3 the setup stopped it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
	const at = args.indexOf(name);
	return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const vault = option('--vault', 'Selectable Tables Test');
const only = option('--only', null);
const deadline = Date.now() + Number(option('--minutes', only && only !== 'own' ? '90' : '180')) * 60_000;
const stallAfter = Number(option('--stall', '10')) * 60_000;
const script = path.resolve(option('--script', path.join(repo, 'scripts', 'obsidian-check.js')));
const started = Date.now();
const minutes = (from = started) => Math.round((Date.now() - from) / 60_000);
const say = (line) => console.log(`[${minutes()} min] ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every section of the check script, in its order. Each runs alone, with the flags `flagsFor` gives it. */
const SECTIONS = ['tables', 'cells', 'frozenCells', 'edits', 'drags', 'shades', 'ranges', 'cellDrags', 'cellEdits', 'formatting', 'clicks', 'rangeMenus', 'typing', 'links', 'defaultFreeze', 'fallback'];
const KNOWN = [...SECTIONS, 'corners'];

function sectionsFor(choice) {
	if (!choice || choice === 'own') return SECTIONS;
	return choice.split(',').map((each) => each.trim()).filter(Boolean);
}

/** The flags a section runs with. */
function flagsFor(section) {
	if (section === 'tables') return ['__checkOwnOnly', '__checkEarlierOnly'];
	if (section === 'cells') return ['__checkOwnOnly', '__checkCellsOnly'];
	if (section === 'corners') return ['__checkOwnOnly', '__checkCellsOnly', '__checkFrozenCellsOnly', '__checkCornersOnly'];
	return ['__checkOwnOnly', '__checkCellsOnly', `__check${section[0].toUpperCase()}${section.slice(1)}Only`];
}

/**
 * One call to the Obsidian CLI, never longer than `ms`: its value, or why there's none. SIGKILL, since a hung call
 * ignored the default SIGTERM for over an hour (BMT-121).
 */
function cli(command, ms = 20_000) {
	const run = spawnSync('obsidian', [`vault=${vault}`, ...command], { encoding: 'utf8', timeout: ms, killSignal: 'SIGKILL' });
	if (run.error?.code === 'ETIMEDOUT' || run.signal) return { ok: false, why: `Obsidian didn't answer within ${ms / 1000} s` };
	if (run.error) return { ok: false, why: String(run.error.message ?? run.error) };
	const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
	const line = out.split('\n').reverse().find((each) => each.startsWith('=> '));
	return line ? { ok: true, value: line.slice(3) } : { ok: run.status === 0, value: out, why: out };
}
const evaluate = (code, ms) => cli(['eval', `code=${code}`], ms);
const json = (answer) => {
	try {
		return answer.ok ? JSON.parse(answer.value) : null;
	} catch {
		return null;
	}
};

// The timing lock --------------------------------------------------------------------------------------------------

const LOCK = '/tmp/obsidian-timing.lock';
const session = process.env.CLAUDE_CODE_SESSION_ID ?? '-';
let locked = false;

/** Whether a lock's owner is gone: its process ended, its time passed, or a minute passed with no owner written. */
function abandoned() {
	try {
		const owner = Object.fromEntries(readFileSync(`${LOCK}/owner`, 'utf8').split('\n').filter(Boolean).map((line) => line.split('=')));
		if (owner.session === session && session !== '-') return 'ours';
		if (owner.until && owner.until !== '-' && Number(owner.until) * 1000 < Date.now()) return 'expired';
		if (owner.pid && owner.pid !== '-') {
			try {
				process.kill(Number(owner.pid), 0);
			} catch {
				return 'its process ended';
			}
		}
		return null;
	} catch {
		return Date.now() - statSync(LOCK).mtimeMs > 60_000 ? 'no owner' : null;
	}
}

async function takeLock() {
	for (;;) {
		try {
			mkdirSync(LOCK);
			break;
		} catch {
			const gone = abandoned();
			if (gone === 'ours') break;
			if (gone) {
				say(`the timing lock was left behind (${gone}): taking it`);
				rmSync(LOCK, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline) return false;
			let what = 'no owner yet';
			try {
				what = readFileSync(`${LOCK}/owner`, 'utf8').match(/what=(.*)/)?.[1] ?? what;
			} catch {
				// A lock just taken has no owner written yet.
			}
			say(`another chat holds the timing lock: ${what}; waiting`);
			await sleep(30_000);
		}
	}
	// Stopping a section and putting the vault back can run a few minutes past the deadline.
	writeFileSync(`${LOCK}/owner`, `pid=${process.pid}\nuntil=${Math.round(deadline / 1000) + 15 * 60}\nsession=${session}\nwhat=obsidian-check run${only ? ` (${only})` : ''}\n`);
	locked = true;
	return true;
}

/** Releases the lock if it's still this run's: one taken over by another chat stays. */
function releaseLock() {
	if (!locked) return;
	locked = false;
	try {
		if (!readFileSync(`${LOCK}/owner`, 'utf8').includes(`pid=${process.pid}\n`)) return;
	} catch {
		return;
	}
	rmSync(LOCK, { recursive: true, force: true });
}

// The vault's setup --------------------------------------------------------------------------------------------------

/** Run in the window first: where the vault is, and whether a check script is still running there. */
const BEFORE = `JSON.stringify({ basePath: app.vault.adapter.basePath, progress: window.__checkProgress ?? null })`;

/** Run in the window when a check script is still running: asks it to stop, and says whether it did within a minute. */
const STOP_OLD = `(async () => {
	window.__checkStop = 'a new run is starting';
	for (let i = 0; i < 60 && window.__checkProgress?.running; i++) await new Promise((resolve) => setTimeout(resolve, 1000));
	const progress = window.__checkProgress ?? null;
	if (!progress?.running) delete window.__checkStop;
	return JSON.stringify({ stopped: !progress?.running, progress });
})()`;

/** Shared by the steps below, in the window: sets the custom hotkeys aside in memory. removeHotkeys never saves. */
const HELPERS = `
	const setKeysAside = () => {
		const keys = app.hotkeyManager;
		const ids = Object.keys(keys.customKeys ?? {});
		for (const id of ids) keys.removeHotkeys(id);
		keys.bake();
		return ids;
	};
	const extraPanes = () => {
		const leaves = [];
		// A block body: iterateRootLeaves stops at the first leaf whose callback returns something truthy, as push's count is.
		app.workspace.iterateRootLeaves((leaf) => {
			leaves.push(leaf);
		});
		const keep = leaves.find((leaf) => leaf.view.getViewType() === 'markdown') ?? leaves[0];
		return leaves.filter((leaf) => leaf !== keep);
	};
	// Every setting on the plugin's tab, in its order, its click setting, and whether it draws tables, as the run found them.
	const pluginTab = () => app.setting.pluginTabs.find((each) => each.id === 'selectable-tables');
	const hookOf = () => {
		const plugin = app.plugins.plugins['selectable-tables'];
		return plugin?.debug ?? plugin?.preview;
	};
	async function settingsBack(want, done) {
		const hook = hookOf();
		const tab = pluginTab();
		if (!want || !hook) return;
		// The tab's settings in its order: Freeze tables before its rows and columns, since turning it on sets them to 1.
		for (const [key, value] of want.tab ?? []) {
			if (tab?.getControlValue?.(key) === value) continue;
			await tab.setControlValue(key, value);
			done.push('the setting ' + key);
		}
		if (hook.clickSelects() !== want.clickSelects) {
			hook.setClickSelects(want.clickSelects);
			app.workspace.updateOptions();
			done.push('the click setting');
		}
		if (hook.isOn() !== want.drawing) {
			hook.use(want.drawing);
			done.push('the plugin drawing tables');
		}
	}
	const win = require('electron').remote.getCurrentWindow();
	const debug = win.webContents.debugger;
	async function emulateFocus() {
		win.webContents.setBackgroundThrottling(false);
		if (!debug.isAttached()) {
			debug.attach('1.3');
			window.__runCheckSaved.attached = true;
		}
		await debug.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
	}
	// Leftover flags. Between sections a section's own flags, which the runner set, go unnamed.
	const clearFlags = (ownToo) => {
		const cleared = [];
		for (const name of Object.keys(window).filter((name) => name.startsWith('__check'))) {
			if (name !== '__checkProgress' && name !== '__checkStop' && (ownToo || !/^__check[A-Za-z]*Only$/.test(name))) cleared.push(name);
			delete window[name];
		}
		return cleared;
	};
`;

/** Run in the window: fixes what the checks need and keeps what it changed, to put back between sections and afterwards. */
const SETUP = `(async () => {
	${HELPERS}
	const out = { fixed: [], warnings: [] };
	out.minimized = win.isMinimized();
	if (!out.minimized && !${args.includes('--minimize')}) return JSON.stringify({ ...out, stop: 'the window is in front: minimizing it changes the screen, so it needs an OK first (then run with --minimize)' });
	// A run that never put its setup back left what it saved: that's the vault as it really was, so it's kept.
	const left = window.__runCheckSaved;
	if (left) out.warnings.push('an earlier run never put its setup back: putting back what it saved, at the end');
	const saved = (window.__runCheckSaved = left ?? { keys: false, layout: null, attached: false, settings: null });
	const hook = hookOf();
	if (hook && !left) {
		const tab = pluginTab();
		const tabKeys = (tab?.getSettingDefinitions?.() ?? []).map((each) => each.control?.key).filter(Boolean);
		saved.settings = { clickSelects: hook.clickSelects(), drawing: hook.isOn(), tab: tabKeys.map((key) => [key, tab.getControlValue(key)]) };
		if (!saved.settings.clickSelects) out.warnings.push('a click opens a cell: an earlier run left it so');
	}
	// Obsidian draws its own menus for the run, inside the window: a Mac's own menus show on the screen even with the
	// window minimized, where Brian can click them by accident (11/25). Unsaved, and put back afterwards.
	const config = app.vault.config;
	if (saved.menus === undefined) saved.menus = { had: Object.hasOwn(config, 'nativeMenus'), value: config.nativeMenus };
	if (config.nativeMenus !== false) {
		config.nativeMenus = false;
		out.fixed.push('Obsidian draws its own menus, inside the window, for the run, unsaved');
	}
	// The setting takes effect only through this.
	app.updateUseNativeMenu?.();
	await emulateFocus();
	if (!out.minimized) {
		win.minimize();
		out.fixed.push('minimized the window');
	}
	for (const name of clearFlags(true)) out.fixed.push('cleared ' + name);
	// The checks press keys as Obsidian binds them by default. customKeys hands out a copy, so the keys come off through
	// removeHotkeys, which changes only memory; hotkeys.json is read back at the end.
	const ids = setKeysAside();
	if (ids.length || left?.keys) {
		saved.keys = true;
	}
	if (ids.length) {
		out.fixed.push('set aside custom hotkeys, unsaved: ' + ids.join(', '));
	}
	const extra = extraPanes();
	if (extra.length) {
		if (!saved.layout) saved.layout = app.workspace.getLayout();
		for (const leaf of extra) leaf.detach();
		out.fixed.push('closed ' + extra.length + ' extra pane(s)');
	}
	if (!saved.look) saved.look = { theme: app.customCss.theme ?? '', base: app.vault.getConfig('theme'), snippets: [...(app.customCss.enabledSnippets ?? [])].sort() };
	if (saved.look.theme) out.warnings.push('a theme is on: ' + saved.look.theme);
	if (saved.look.snippets.length) out.warnings.push('snippets are on: ' + saved.look.snippets.join(', '));
	return JSON.stringify(out);
})()`;

/**
 * Run in the window after each section: puts back what the section left as the run found it, reloads the plugin from
 * disk, and names what it put back.
 */
const BETWEEN = `(async () => {
	${HELPERS}
	const saved = window.__runCheckSaved;
	const fixed = [];
	if (!saved) return JSON.stringify({ fixed, lost: true });
	for (const name of clearFlags()) fixed.push('cleared ' + name);
	const ids = setKeysAside();
	if (ids.length) fixed.push('set aside hotkeys again: ' + ids.join(', '));
	const extra = extraPanes();
	for (const leaf of extra) leaf.detach();
	if (extra.length) fixed.push('closed ' + extra.length + ' extra pane(s)');
	const look = saved.look;
	if ((app.customCss.theme ?? '') !== look.theme) {
		const was = app.customCss.theme;
		// A theme set right after another may not stick (STA-106), so it's read back.
		for (let i = 0; i < 10 && (app.customCss.theme ?? '') !== look.theme; i++) {
			app.customCss.setTheme(look.theme);
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		fixed.push('the theme ' + JSON.stringify(was) + ', back to ' + JSON.stringify(look.theme));
	}
	if (app.vault.getConfig('theme') !== look.base) {
		fixed.push('light or dark, back to ' + look.base);
		app.changeTheme(look.base);
	}
	const snippets = [...(app.customCss.enabledSnippets ?? [])].sort();
	if (snippets.join() !== look.snippets.join()) {
		for (const name of new Set([...snippets, ...look.snippets])) {
			const want = look.snippets.includes(name);
			if (app.customCss.enabledSnippets.has(name) !== want) app.customCss.setCssEnabledStatus(name, want);
		}
		fixed.push('snippets, back to ' + (look.snippets.join(', ') || 'none'));
	}
	if (app.vault.config.nativeMenus !== false) {
		app.vault.config.nativeMenus = false;
		app.updateUseNativeMenu?.();
		fixed.push('Obsidian\\'s own menus again');
	}
	if (!win.isMinimized()) {
		win.minimize();
		fixed.push('minimized the window again');
	}
	// The plugin reloaded from disk, so nothing a section changed in it reaches the next one.
	await app.plugins.disablePlugin('selectable-tables');
	await app.plugins.loadManifests();
	await app.plugins.enablePlugin('selectable-tables');
	for (let i = 0; i < 50 && !hookOf(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
	await new Promise((resolve) => setTimeout(resolve, 500));
	const settings = [];
	await settingsBack(saved.settings, settings);
	if (settings.length) fixed.push(...settings);
	await emulateFocus();
	return JSON.stringify({ fixed, loaded: !!hookOf() });
})()`;

/** Run in the window afterwards: puts back what SETUP changed. With only the keys, the hotkeys alone. */
const restoreCode = (keysOnly) => `(async () => {
	${HELPERS}
	const saved = window.__runCheckSaved;
	const done = [];
	// A check script still running would lose its flags and focus: it's asked to stop first, and left alone if it won't.
	let stillRunning = false;
	if (window.__checkProgress?.running) {
		if (!window.__checkStop) window.__checkStop = 'the run is ending';
		for (let i = 0; i < 90 && window.__checkProgress?.running; i++) await new Promise((resolve) => setTimeout(resolve, 1000));
		stillRunning = !!window.__checkProgress?.running;
		done.push(stillRunning ? 'nothing but the hotkeys: a check script is still running in the window' : 'stopped a check script still running');
	}
	if (saved?.keys) {
		await app.hotkeyManager.load();
		app.hotkeyManager.bake();
		app.appMenuBarManager?.requestRender?.();
		done.push('hotkeys, from hotkeys.json');
	}
	if (${keysOnly} || stillRunning) return JSON.stringify({ done, stillRunning });
	clearFlags();
	if (saved?.layout) {
		await app.workspace.changeLayout(saved.layout);
		done.push('panes');
	}
	await settingsBack(saved?.settings, done);
	if (saved?.attached && debug.isAttached()) {
		debug.detach();
		done.push('debugger');
	}
	if (saved?.menus) {
		if (saved.menus.had) app.vault.config.nativeMenus = saved.menus.value;
		else delete app.vault.config.nativeMenus;
		app.updateUseNativeMenu?.();
		done.push('menus');
		// A check that sets a theme saves the whole config, the run's menus included: then the file is saved back too.
		const onDisk = (await app.vault.readConfigJson('appearance')) ?? {};
		if (onDisk.nativeMenus !== app.vault.config.nativeMenus) {
			await app.vault.saveConfig();
			done.push('the saved menus setting');
		}
	}
	win.webContents.setBackgroundThrottling(true);
	delete window.__runCheckSaved;
	return JSON.stringify({ done, minimized: win.isMinimized() });
})()`;

/** Sample notes that differ from git, which the checks assume aren't changed: left alone, and named. */
function changedNotes(basePath) {
	const status = spawnSync('git', ['-C', basePath, 'status', '--porcelain', '--', '.'], { encoding: 'utf8' });
	return status.status === 0 ? status.stdout.trim().split('\n').filter(Boolean) : [];
}

const fileHash = (file) => (existsSync(file) ? createHash('sha1').update(readFileSync(file)).digest('hex').slice(0, 10) : 'none');

/** Which build runs: the repo, its branch and commit, and main.js's hash, against the vault's copy. */
function buildLine(plugins) {
	const git = (...command) => spawnSync('git', ['-C', repo, ...command], { encoding: 'utf8' }).stdout.trim();
	const here = fileHash(path.join(repo, 'main.js'));
	const there = fileHash(path.join(plugins, 'main.js'));
	const line = `the build: ${repo} (${git('rev-parse', '--abbrev-ref', 'HEAD')} at ${git('rev-parse', '--short', 'HEAD')}), main.js ${here}; the vault's main.js ${there}`;
	return here === there ? line : `${line}: warning, the vault holds another build than this repo's (--install copies this one in)`;
}

// One section ----------------------------------------------------------------------------------------------------------

/**
 * Runs one section and waits for its results. A section that reports nothing new for the stall limit, or runs past the
 * deadline, is asked to stop, which makes the script unwind and write what it has. Returns its results and how it ended;
 * `fatal` when the run can't go on (the window stopped answering, or the section wouldn't stop).
 */
async function runSection(section, file) {
	const before = existsSync(file) ? statSync(file).mtimeMs : 0;
	const flags = flagsFor(section);
	const sectionStart = Date.now();
	const start = evaluate(`(() => {
		${flags.map((flag) => `window.${flag} = true;`).join(' ')}
		window.__checkProgress = { running: true, count: 0, last: 'queued', at: Date.now(), queued: true };
		// A script that can't be read or throws before it starts reports that, rather than staying queued.
		setTimeout(() => {
			try {
				Promise.resolve(eval(require('fs').readFileSync(${JSON.stringify(script)}, 'utf8'))).catch((error) => {
					window.__checkProgress = { running: false, count: window.__checkProgress?.count ?? 0, last: 'failed: ' + String(error), at: Date.now() };
				});
			} catch (error) {
				window.__checkProgress = { running: false, count: 0, last: 'failed: ' + String(error), at: Date.now() };
			}
		}, 50);
		return 'started';
	})()`);
	if (!start.ok) return { results: [], ended: `didn't start: ${start.why}`, fatal: true };
	const written = () => existsSync(file) && statSync(file).mtimeMs > before;
	// The file can be caught as it's written, so a read that doesn't parse waits and tries again.
	const read = async () => {
		for (let i = 0; ; i++) {
			try {
				return JSON.parse(readFileSync(file, 'utf8'));
			} catch (error) {
				if (i >= 5) throw error;
				await sleep(1000);
			}
		}
	};
	let silent = 0;
	let lastSeen = { count: 0, last: 'queued', at: Date.now(), queued: true };
	let lastLine = Date.now();
	for (;;) {
		await sleep(5000);
		if (written()) {
			const got = await read();
			return { results: got.results ?? [], obsidian: got.obsidian, ended: 'done', minutes: minutes(sectionStart) };
		}
		const answer = json(evaluate('JSON.stringify(window.__checkProgress ?? null)', 15_000));
		if (answer) {
			silent = 0;
			lastSeen = answer;
			// Ended without writing its results: it never got going.
			if (!answer.running && !written()) {
				await sleep(2000);
				if (!written()) return { results: [], ended: `ended with no results: ${answer.last}`, fatal: true, minutes: minutes(sectionStart) };
			}
		} else if (++silent >= 3) {
			return { results: [], ended: `the window stopped answering, after ${lastSeen.count} results, the last: ${lastSeen.last}`, fatal: true, minutes: minutes(sectionStart) };
		}
		// A script that never reports leaves the queued mark: only the deadline applies to it.
		const stalled = !lastSeen.queued && Date.now() - lastSeen.at > stallAfter;
		const late = Date.now() > deadline;
		if (stalled || late) {
			const why = stalled ? `nothing new for ${Math.round((Date.now() - lastSeen.at) / 60_000)} min, after ${lastSeen.count} results, the last: ${lastSeen.last}` : `the run's deadline passed, after ${lastSeen.count} results, the last: ${lastSeen.last}`;
			say(`${section}: ${why}; stopping it`);
			evaluate(`window.__checkStop = ${JSON.stringify(why)}`, 15_000);
			for (let i = 0; i < 18 && !written(); i++) await sleep(5000);
			if (!written()) return { results: [], ended: `stopped: ${why}, and it wouldn't stop (the check script may still be running in the window)`, fatal: true, minutes: minutes(sectionStart) };
			const got = await read();
			const results = got.results ?? [];
			results.push({ name: `the runner stopped the ${section} section: ${why}`, ok: false });
			return { results, obsidian: got.obsidian, ended: `stopped: ${why}`, late, minutes: minutes(sectionStart) };
		}
		if (Date.now() - lastLine > 120_000) {
			say(lastSeen.queued ? `${section}: running, no progress reported by this script` : `${section}: ${lastSeen.count} results so far, the last: ${lastSeen.last}`);
			lastLine = Date.now();
		}
	}
}

function printFails(results, indent = '  ') {
	for (const result of results) {
		if (result.ok) continue;
		console.log(`${indent}FAIL ${String(result.name ?? '(no name)')}`);
		if (result.detail !== undefined) console.log(`${indent}     ${String(JSON.stringify(result.detail)).slice(0, 600)}`);
	}
}

// The run ------------------------------------------------------------------------------------------------------------

/** Puts the setup back, as far as a check script still running in the window allows. */
function putBack(what) {
	if (!what) return;
	const back = json(evaluate(restoreCode(what === 'keys'), 120_000));
	say(back ? `put back at the end: ${back.done.join(', ') || 'nothing to put back'}` : 'warning: couldn\'t put the setup back: the window didn\'t answer');
	if (back?.stillRunning) say('warning: a check script is still running in the window, so only the hotkeys were put back');
}

// Stopped by hand: the setup is put back and the lock released before it ends.
let restore = null;
for (const signal of ['SIGINT', 'SIGTERM']) {
	process.on(signal, () => {
		say(`stopped by ${signal}: putting the setup back`);
		putBack(restore);
		releaseLock();
		process.exit(130);
	});
}

async function main() {
	const sections = sectionsFor(only);
	const unknown = sections.filter((each) => !KNOWN.includes(each));
	if (unknown.length) {
		say(`no such section: ${unknown.join(', ')}. The sections: ${KNOWN.join(', ')}, or own for all`);
		return 3;
	}
	if (!existsSync(script)) {
		say(`no check script at ${script}`);
		return 3;
	}
	if (args.includes('--install')) {
		say(`building the plugin in ${repo}`);
		const build = spawnSync('npm', ['run', 'build'], { cwd: repo, encoding: 'utf8' });
		if (build.status !== 0) {
			console.log(build.stdout, build.stderr);
			return 3;
		}
	}
	const version = cli(['version'], 15_000);
	if (!version.ok) {
		say(`Obsidian isn't answering (${version.why}): a crashed or looping window, or a dialog holding the app`);
		return 2;
	}
	if (!(await takeLock())) {
		say('the deadline passed waiting for the timing lock');
		return 2;
	}
	const report = [];
	const all = [];
	let obsidian = null;
	let code = 0;
	let file = null;
	let keysFile = null;
	let keysBefore = null;
	try {
		const asked = evaluate(BEFORE, 15_000);
		const first = json(asked);
		if (!first) {
			say(`the window gave no answer: ${asked.why ?? asked.value}`);
			return 2;
		}
		// A check script left running from an earlier run would press keys under this one, so it's stopped first.
		if (first.progress?.running) {
			say(`a check script is still running in the window (${first.progress.count} results, the last: ${first.progress.last}): asking it to stop`);
			const old = json(evaluate(STOP_OLD, 75_000));
			if (!old?.stopped) {
				say(`stopped before starting: the check script still running in the window didn't stop within a minute${old ? ` (the last: ${old.progress?.last})` : ''}`);
				return 3;
			}
			say('it stopped');
		}
		keysFile = path.join(first.basePath, '.obsidian', 'hotkeys.json');
		keysBefore = existsSync(keysFile) ? readFileSync(keysFile) : null;
		// Set before the setup's call, which can change the window and still get no answer back.
		restore = 'all';
		const setup = json(evaluate(SETUP, 30_000));
		if (!setup) {
			say('the setup got no answer from the window');
			return 2;
		}
		if (setup.stop) {
			restore = null;
			say(`stopped before starting: ${setup.stop}`);
			return 3;
		}
		for (const line of setup.fixed) say(`fixed: ${line}`);
		for (const line of setup.warnings) say(`warning: ${line}`);
		for (const line of changedNotes(first.basePath)) say(`warning: a sample note differs from git: ${line}`);
		const plugins = path.join(first.basePath, '.obsidian', 'plugins', 'selectable-tables');
		if (args.includes('--install')) {
			const copy = spawnSync('node', ['scripts/install-test-vault.mjs', '--to', plugins], { cwd: repo, encoding: 'utf8' });
			if (copy.status !== 0) {
				say(`copying the build into the vault failed: ${copy.stderr || copy.stdout}`);
				return 3;
			}
			say('copied the build into the vault');
		}
		say(buildLine(plugins));
		say(`the check script: ${script}`);
		file = path.join(first.basePath, '..', 'check-results.json');

		say(`running ${sections.length === 1 ? `the ${sections[0]} section` : `${sections.length} sections, one at a time: ${sections.join(', ')}`}`);
		// Whether a section ran since the vault was last put back.
		let dirty = false;
		const notRun = (from, why) => {
			for (const rest of sections.slice(from)) report.push({ section: rest, ended: `not run: ${why}`, passed: 0, failed: 0 });
		};
		for (const section of sections) {
			if (Date.now() > deadline) {
				report.push({ section, ended: 'not run: the deadline passed', passed: 0, failed: 0 });
				code = 2;
				continue;
			}
			// The vault as the run found it, and the plugin reloaded, before every section.
			const between = json(evaluate(BETWEEN, 60_000));
			if (!between) {
				say(`putting the vault back before ${section} got no answer from the window`);
				code = 2;
				notRun(sections.indexOf(section), 'the window stopped answering');
				break;
			}
			dirty = false;
			const left = report[report.length - 1];
			if (left) left.putBack = between.fixed;
			if (between.fixed.length) say(`put back after ${left ? left.section : 'the setup'}: ${between.fixed.join('; ')}`);
			if (!between.loaded) {
				say('the plugin didn\'t load again after its reload, so no section can run');
				code = 2;
				notRun(sections.indexOf(section), 'the plugin didn\'t load');
				break;
			}
			say(`${section}: started`);
			dirty = true;
			const result = await runSection(section, file);
			obsidian = result.obsidian ?? obsidian;
			for (const each of result.results) all.push({ ...each, section });
			const failed = result.results.filter((each) => !each.ok).length;
			report.push({ section, ended: result.ended, passed: result.results.length - failed, failed, minutes: result.minutes });
			say(`${section}: ${result.results.length - failed} passed, ${failed} failed, in ${result.minutes ?? 0} min${result.ended === 'done' ? '' : ` (${result.ended})`}`);
			printFails(result.results);
			if (result.ended === 'done' && result.results.length === 0) {
				say(`${section} gave no results`);
				code = 2;
			}
			if (result.fatal) {
				// The put-back at the end stops a script still running first, and leaves the window alone if it won't.
				code = 2;
				dirty = false;
				notRun(sections.indexOf(section) + 1, 'the run ended');
				break;
			}
			if (result.late) code = 2;
		}
		if (dirty) {
			const last = [...report].reverse().find((each) => !each.ended.startsWith('not run'));
			const after = json(evaluate(BETWEEN, 60_000));
			if (after?.fixed.length && last) {
				last.putBack = after.fixed;
				say(`put back after ${last.section}: ${after.fixed.join('; ')}`);
			}
		}
	} finally {
		putBack(restore);
		restore = null;
		releaseLock();
		if (keysFile) {
			const keysAfter = existsSync(keysFile) ? readFileSync(keysFile) : null;
			const same = keysBefore === null ? keysAfter === null : keysAfter !== null && keysBefore.equals(keysAfter);
			say(same ? 'hotkeys.json is as it was' : 'warning: hotkeys.json changed during the run');
		}
	}

	const passed = all.filter((each) => each.ok).length;
	const failed = all.length - passed;
	if (file && report.length) {
		writeFileSync(file, JSON.stringify({ obsidian, passed, failed, sections: report, results: all }, null, '\t'));
	}
	console.log(`\nObsidian ${obsidian ?? '?'}: ${passed} passed, ${failed} failed, in ${minutes()} min`);
	for (const each of report) {
		const extra = each.putBack?.length ? `; put back after it: ${each.putBack.join('; ')}` : '';
		console.log(`  ${each.section.padEnd(14)} ${String(each.passed).padStart(4)} passed ${String(each.failed).padStart(3)} failed${each.minutes !== undefined ? `  ${each.minutes} min` : ''}${each.ended === 'done' ? '' : `  (${each.ended})`}${extra}`);
	}
	if (failed) {
		console.log('');
		printFails(all.map((each) => ({ ...each, name: `${each.section}: ${each.name}` })), '');
	}
	if (file) console.log(`\nResults in ${file}`);
	return code || (failed ? 1 : 0);
}

process.exitCode = await main();
