import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Runs scripts/release-notes.mjs as the release workflow does, from the repo's root.
const notesFor = (...args: string[]) => {
	const run = spawnSync(process.execPath, ['scripts/release-notes.mjs', ...args], { encoding: 'utf8' });
	return { status: run.status, out: run.stdout, err: run.stderr };
};

const withChangelog = (text: string, check: (file: string) => void) => {
	const folder = mkdtempSync(join(tmpdir(), 'release-notes-'));
	try {
		const file = join(folder, 'CHANGELOG.md');
		writeFileSync(file, text);
		check(file);
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
};

test("a version's notes run from under its heading to the next version's", () => {
	const { status, out } = notesFor('0.2.3');
	assert.equal(status, 0);
	assert.ok(out.startsWith('Freeze from the right-click menu or the command palette\n\n### New\n'));
	assert.ok(out.endsWith('- A header cell with a freeze comment no longer grows a line taller in a narrow column.\n'));
	assert.doesNotMatch(out, /^## /m);
});

test("the oldest version's notes run to the end of the file", () => {
	const { status, out } = notesFor('0.1.0');
	assert.equal(status, 0);
	assert.ok(out.startsWith('First release.\n'));
	assert.ok(out.endsWith('- Shift with an arrow selects a table whole.\n'));
});

test('a version with no section stops with a message, and prints nothing', () => {
	for (const version of ['9.9.9', '0.2', '0.2.30', '0x2.3']) {
		const { status, out, err } = notesFor(version);
		assert.equal(status, 1, version);
		assert.equal(out, '', version);
		assert.match(err, new RegExp(`no section for ${version.replace(/\./g, '\\.')}\\.`), version);
	}
});

test('an empty section stops with a message', () => {
	withChangelog('# Changelog\n\n## 1.0.0 (2026-12-01)\n\n\n## 0.9.0 (2026-11-01)\n\nOlder.\n', (file) => {
		const { status, out, err } = notesFor('1.0.0', file);
		assert.equal(status, 1);
		assert.equal(out, '');
		assert.match(err, /section for 1\.0\.0 is empty/);
	});
});

test('a deeper heading stays in the notes, and a heading without a date counts', () => {
	withChangelog('## 1.0.0\n\nIntro.\n\n### Fixed\n\n- A fix.\n\n## 0.9.0 (2026-11-01)\n\nOlder.\n', (file) => {
		const { status, out } = notesFor('1.0.0', file);
		assert.equal(status, 0);
		assert.equal(out, 'Intro.\n\n### Fixed\n\n- A fix.\n');
	});
});

test('no version given stops with a message', () => {
	const { status, err } = notesFor();
	assert.equal(status, 1);
	assert.match(err, /Give a version/);
});
