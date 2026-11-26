// Runs scripts/obsidian-check.js in the test vault's window and always ends with an answer: the results, or why
// there are none. It sets the vault up as the checks expect first, watches the run as it goes, and puts back what it
// changed.
//
//   node scripts/run-check.mjs [--only <section>] [--install] [--minimize] [--minutes 90] [--stall 10]
//
//   --only <section>  own, earlier (the own table's sections before the cells'), cells, or a cells section by its flag's name: Formatting runs window.__checkFormattingOnly
//                     with __checkOwnOnly and __checkCellsOnly, and Fallback the last section, Obsidian's own tables
//                     where the plugin's doesn't draw. Without it, the full run.
//   --install         builds the plugin and copies it into the vault's plugin folder first.
//   --minimize        minimizes the window if it's in front. That changes the screen, so only with Brian's OK.
//   --minutes <n>     the whole run's deadline (default 90).
//   --stall <n>       stops when the run reports nothing new for this long (default 10): it reports each result and
//                     each note it opens. A check script from before progress reports only meets the deadline.
//   --script <file>   another copy of obsidian-check.js, such as another worktree's.
//
// Before the run it fixes what it can and says so: the window's throttling and focus emulation, Obsidian's own menus in
// place of the Mac's, which show on the screen even with the window minimized, leftover
// window.__check* flags, custom hotkeys (all set aside in memory, unsaved, since the checks press keys as Obsidian
// binds them by default), extra panes, and the build, reloaded from disk. It stops before starting when the window
// isn't minimized, and warns about a theme, snippets, changed sample notes, or a click setting running other than
// it's saved, which it leaves alone. It takes the timing lock (/tmp/obsidian-timing.lock) for the run, waiting within
// the deadline while another chat holds it. Afterwards it puts the hotkeys, the panes, the throttling, the debugger,
// the plugin's click setting and whether it draws tables back, and releases the lock, whatever happened. Exit codes: 0 all passed, 1 some failed, 2 no results (stalled, deadline, or the window stopped
// answering), 3 the setup stopped it.
import { spawnSync } from 'node:child_process';
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
const deadline = Date.now() + Number(option('--minutes', '90')) * 60_000;
const stallAfter = Number(option('--stall', '10')) * 60_000;
const script = path.resolve(option('--script', path.join(repo, 'scripts', 'obsidian-check.js')));
const started = Date.now();
const minutes = () => Math.round((Date.now() - started) / 60_000);
const say = (line) => console.log(`[${minutes()} min] ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The flags a section runs with: the own table's sections, the cells', or one cells section. */
function flagsFor(section) {
	if (!section) return [];
	if (section === 'own') return ['__checkOwnOnly'];
	if (section === 'cells') return ['__checkOwnOnly', '__checkCellsOnly'];
	if (section === 'earlier') return ['__checkOwnOnly', '__checkEarlierOnly'];
	const name = `__check${section[0].toUpperCase()}${section.slice(1)}Only`;
	return ['__checkOwnOnly', '__checkCellsOnly', ...(section === 'corners' ? ['__checkFrozenCellsOnly'] : []), name];
}

/** One call to the Obsidian CLI, never longer than `ms`: its value, or why there's none. */
function cli(command, ms = 20_000) {
	const run = spawnSync('obsidian', [`vault=${vault}`, ...command], { encoding: 'utf8', timeout: ms });
	if (run.error?.code === 'ETIMEDOUT' || run.signal) return { ok: false, why: `no answer within ${ms / 1000} s` };
	const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();
	const line = out.split('\n').reverse().find((each) => each.startsWith('=> '));
	return line ? { ok: true, value: line.slice(3) } : { ok: run.status === 0, value: out, why: out };
}
const evaluate = (code, ms) => cli(['eval', `code=${code}`], ms);
const json = (answer) => {
	try {
		return JSON.parse(answer.value);
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
		if (owner.session === session) return 'ours';
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
			say(`another chat holds the timing lock: ${readFileSync(`${LOCK}/owner`, 'utf8').match(/what=(.*)/)?.[1] ?? 'no owner yet'}; waiting`);
			await sleep(30_000);
		}
	}
	writeFileSync(`${LOCK}/owner`, `pid=${process.pid}\nuntil=${Math.round(deadline / 1000)}\nsession=${session}\nwhat=obsidian-check run${only ? ` (${only})` : ''}\n`);
	locked = true;
	return true;
}

function releaseLock() {
	if (locked) rmSync(LOCK, { recursive: true, force: true });
	locked = false;
}

// The vault's setup --------------------------------------------------------------------------------------------------

/** Run in the window: fixes what the checks need and keeps what it changed, to put back afterwards. */
const SETUP = `(async () => {
	const out = { fixed: [], warnings: [] };
	const win = require('electron').remote.getCurrentWindow();
	out.minimized = win.isMinimized();
	if (!out.minimized && !${args.includes('--minimize')}) return JSON.stringify({ ...out, stop: 'the window is in front: minimizing it changes the screen, so it needs an OK first (then run with --minimize)' });
	const saved = (window.__runCheckSaved = { keys: null, layout: null, attached: false, settings: null });
	const plugin = app.plugins.plugins['selectable-tables'];
	const hook = plugin?.debug ?? plugin?.preview;
	if (hook) {
		const tab = app.setting.pluginTabs.find((each) => each.id === 'selectable-tables');
		// Every setting on the plugin's tab, in its order, so the run can put back what a check changed.
		const tabKeys = (tab?.getSettingDefinitions?.() ?? []).map((each) => each.control?.key).filter(Boolean);
		saved.settings = { clickSelects: hook.clickSelects(), drawing: hook.isOn(), tab: tabKeys.map((key) => [key, tab.getControlValue(key)]) };
		if (!saved.settings.clickSelects) out.warnings.push('a click opens a cell: an earlier run left it so');
	}
	// Obsidian draws its own menus for the run, inside the window: a Mac's own menus show on the screen even with the
	// window minimized, where Brian can click them by accident (11/25). Unsaved, and put back afterwards.
	const config = app.vault.config;
	saved.menus = { had: Object.hasOwn(config, 'nativeMenus'), value: config.nativeMenus };
	if (config.nativeMenus !== false) {
		config.nativeMenus = false;
		out.fixed.push('Obsidian draws its own menus, inside the window, for the run, unsaved');
	}
	win.webContents.setBackgroundThrottling(false);
	const debug = win.webContents.debugger;
	if (!debug.isAttached()) {
		debug.attach('1.3');
		saved.attached = true;
	}
	await debug.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
	if (!out.minimized) {
		win.minimize();
		out.fixed.push('minimized the window');
	}
	for (const name of Object.keys(window).filter((name) => name.startsWith('__check'))) {
		if (name !== '__checkProgress') out.fixed.push('cleared ' + name);
		delete window[name];
	}
	const keys = app.hotkeyManager;
	const custom = Object.keys(keys.customKeys ?? {});
	if (custom.length && typeof keys.bake === 'function') {
		saved.keys = { ...keys.customKeys };
		for (const id of custom) delete keys.customKeys[id];
		keys.bake();
		out.fixed.push('set aside custom hotkeys, unsaved: ' + custom.join(', '));
	}
	const leaves = [];
	// A block body: iterateRootLeaves stops at the first leaf whose callback returns something truthy, as push's count is.
	app.workspace.iterateRootLeaves((leaf) => {
		leaves.push(leaf);
	});
	if (leaves.length > 1) {
		saved.layout = app.workspace.getLayout();
		const keep = leaves.find((leaf) => leaf.view.getViewType() === 'markdown') ?? leaves[0];
		for (const leaf of leaves) if (leaf !== keep) leaf.detach();
		out.fixed.push('closed ' + (leaves.length - 1) + ' extra pane(s)');
	}
	const theme = app.vault.getConfig('cssTheme');
	if (theme) out.warnings.push('a theme is on: ' + theme);
	const snippets = [...(app.customCss.enabledSnippets ?? [])];
	if (snippets.length) out.warnings.push('snippets are on: ' + snippets.join(', '));
	out.basePath = app.vault.adapter.basePath;
	return JSON.stringify(out);
})()`;

/** Run in the window afterwards: puts back what SETUP changed. */
const RESTORE = `(async () => {
	const saved = window.__runCheckSaved;
	const done = [];
	for (const name of Object.keys(window).filter((name) => name.startsWith('__check'))) delete window[name];
	if (saved?.keys) {
		Object.assign(app.hotkeyManager.customKeys, saved.keys);
		app.hotkeyManager.bake();
		done.push('hotkeys');
	}
	if (saved?.layout) {
		await app.workspace.changeLayout(saved.layout);
		done.push('panes');
	}
	// The plugin as it was: a click selecting a cell, which the checks turn off to check a click opening one, and whether
	// the plugin draws tables, which the checks leave to Obsidian as they end. A build from before BMT-137 has a settings tab
	// for the click, put back through it, so its saved file agrees. And every setting on the tab through it (BMT-138, BMT-140).
	const plugin = app.plugins.plugins['selectable-tables'];
	const hook = plugin?.debug ?? plugin?.preview;
	if (saved?.settings && hook) {
		const tab = app.setting.pluginTabs.find((each) => each.id === 'selectable-tables');
		const want = saved.settings.clickSelects;
		const differed = hook.clickSelects() !== want;
		const keys = (tab?.getSettingDefinitions?.() ?? []).map((each) => each.control?.key);
		if (keys.includes('clickSelects')) await tab.setControlValue('clickSelects', want);
		else if (differed) {
			hook.setClickSelects(want);
			app.workspace.updateOptions();
		}
		if (differed) done.push('the click setting');
		// The tab's settings in its order: Freeze tables before its rows and columns, since turning it on sets them to 1.
		for (const [key, value] of saved.settings.tab ?? []) {
			if (key === 'clickSelects' || tab?.getControlValue?.(key) === value) continue;
			await tab.setControlValue(key, value);
			done.push('the setting ' + key);
		}
		if (hook.isOn() !== saved.settings.drawing) {
			hook.use(saved.settings.drawing);
			done.push('the plugin drawing tables');
		}
	}
	const win = require('electron').remote.getCurrentWindow();
	if (saved?.attached && win.webContents.debugger.isAttached()) {
		win.webContents.debugger.detach();
		done.push('debugger');
	}
	if (saved?.menus) {
		if (saved.menus.had) app.vault.config.nativeMenus = saved.menus.value;
		else delete app.vault.config.nativeMenus;
		done.push('menus');
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

// The run ------------------------------------------------------------------------------------------------------------

function summary(file) {
	const results = JSON.parse(readFileSync(file, 'utf8'));
	console.log(`\nObsidian ${results.obsidian}: ${results.passed} passed, ${results.failed} failed`);
	for (const result of results.results ?? []) {
		if (result.ok) continue;
		console.log(`FAIL ${String(result.name ?? '(no name)')}`);
		if (result.detail !== undefined) console.log(`     ${String(JSON.stringify(result.detail)).slice(0, 600)}`);
	}
	return results.failed ? 1 : 0;
}

async function main() {
	if (args.includes('--install')) {
		say('building the plugin');
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
	let restore = false;
	try {
		const setup = json(evaluate(SETUP, 30_000));
		if (!setup) {
			say('the setup got no answer from the window');
			return 2;
		}
		if (setup.stop) {
			say(`stopped before starting: ${setup.stop}`);
			return 3;
		}
		restore = true;
		for (const line of setup.fixed) say(`fixed: ${line}`);
		for (const line of setup.warnings) say(`warning: ${line}`);
		for (const line of changedNotes(setup.basePath)) say(`warning: a sample note differs from git: ${line}`);
		const plugins = path.join(setup.basePath, '.obsidian', 'plugins', 'selectable-tables');
		if (args.includes('--install')) {
			spawnSync('node', ['scripts/install-test-vault.mjs', '--to', plugins], { cwd: repo, encoding: 'utf8' });
			say('copied the build into the vault');
		} else if (existsSync(path.join(repo, 'main.js')) && readFileSync(path.join(repo, 'main.js'), 'utf8') !== readFileSync(path.join(plugins, 'main.js'), 'utf8')) {
			say('warning: the vault holds another build than this repo\'s main.js (--install copies this one in)');
		}
		const reload = cli(['plugin:reload', 'id=selectable-tables'], 30_000);
		if (!reload.ok) say(`warning: reloading the plugin: ${reload.why}`);
		await sleep(1500);

		const file = path.join(setup.basePath, '..', 'check-results.json');
		const before = existsSync(file) ? statSync(file).mtimeMs : 0;
		const flags = flagsFor(only);
		const start = evaluate(`(() => {
			${flags.map((flag) => `window.${flag} = true;`).join(' ')}
			window.__checkProgress = { running: true, count: 0, last: 'queued', at: Date.now(), queued: true };
			setTimeout(() => eval(require('fs').readFileSync(${JSON.stringify(script)}, 'utf8')), 50);
			return 'started';
		})()`);
		if (!start.ok) {
			say(`the run didn't start: ${start.why}`);
			return 2;
		}
		say(`started ${only ? `the ${only} section` : 'the full run'}${flags.length ? ` (${flags.join(', ')})` : ''}`);

		// Nothing stops the check script itself: a run cut short may still be going in the window.
		const cut = ' (the check script may still be running in the window)';
		let silent = 0;
		let lastSeen = { count: 0, last: 'queued', at: Date.now() };
		let lastLine = 0;
		for (;;) {
			await sleep(10_000);
			if (existsSync(file) && statSync(file).mtimeMs > before) return summary(file);
			const answer = evaluate('JSON.stringify(window.__checkProgress ?? null)', 15_000);
			if (answer.ok) {
				silent = 0;
				lastSeen = json(answer) ?? lastSeen;
			} else if (++silent >= 3) {
				say(`the window stopped answering, after ${lastSeen.count} results, the last: ${lastSeen.last}`);
				return 2;
			}
			// A script that never reports leaves the queued mark: only the deadline applies to it.
			if (!lastSeen.queued && Date.now() - lastSeen.at > stallAfter) {
				say(`stalled: nothing new for ${Math.round((Date.now() - lastSeen.at) / 60_000)} min, after ${lastSeen.count} results, the last: ${lastSeen.last}${cut}`);
				return 2;
			}
			if (Date.now() > deadline) {
				say(`the deadline passed, after ${lastSeen.count} results, the last: ${lastSeen.last}${cut}`);
				return 2;
			}
			if (Date.now() - lastLine > 120_000) {
				const where = json(evaluate('JSON.stringify(app.workspace.getActiveFile()?.path ?? null)', 15_000));
				say(lastSeen.queued ? `running, no progress reported by this script; on ${where}` : `${lastSeen.count} results so far, the last: ${lastSeen.last}; on ${where}`);
				lastLine = Date.now();
			}
		}
	} finally {
		if (restore) {
			const back = json(evaluate(RESTORE, 30_000));
			say(back ? `put back: ${back.done.join(', ') || 'nothing to put back'}` : 'warning: couldn\'t put the setup back: the window didn\'t answer');
		}
		releaseLock();
	}
}

process.exitCode = await main();
