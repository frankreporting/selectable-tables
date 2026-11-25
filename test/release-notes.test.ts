import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test("a version's notes run from under its heading to the next version's, under an H2 headline", () => {
	const { status, out } = notesFor('0.2.3');
	assert.equal(status, 0);
	assert.ok(out.startsWith('## Freeze from the right-click menu or the command palette\n\n### New\n'));
	assert.match(out, /^### Fixed$/m);
	assert.ok(out.endsWith('- A header cell with a freeze comment no longer grows a line taller in a narrow column.\n'));
	assert.equal(out.match(/^## /gm)?.length, 1);
	assert.doesNotMatch(out, /^## 0\.2\.3/m);
	assert.doesNotMatch(out, /^####/m);
});

test("the oldest version's notes run to the end of the file", () => {
	const { status, out } = notesFor('0.1.0');
	assert.equal(status, 0);
	assert.ok(out.startsWith('## First release.\n'));
	assert.ok(out.endsWith('- Shift with an arrow selects a table whole.\n'));
});

test('every version in the changelog prints one H2 headline, then its H3 sections', () => {
	const versions = [...readFileSync('CHANGELOG.md', 'utf8').matchAll(/^## (\S+) \(/gm)].flatMap((match) => match[1] ?? []);
	assert.ok(versions.length >= 6);
	for (const version of versions) {
		const { status, out } = notesFor(version);
		assert.equal(status, 0, version);
		assert.match(out, /^## \S/, version);
		const headings = out.match(/^#+ /gm) ?? [];
		assert.deepEqual(headings.slice(1), headings.slice(1).map(() => '### '), version);
	}
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
	withChangelog('# Changelog\n\n## 1.0.0 (2026-12-01)\n\n\n## 0.9.0 (2026-11-01)\n\n### Older\n', (file) => {
		const { status, out, err } = notesFor('1.0.0', file);
		assert.equal(status, 1);
		assert.equal(out, '');
		assert.match(err, /section for 1\.0\.0 is empty/);
	});
});

test('every heading in the notes is lifted one level, and a heading without a date counts', () => {
	const changelog = '## 1.0.0\n\n### Small fixes\n\n#### Fixed\n\n- A fix.\n\n##### Aside\n\nText with ### inside.\n\n## 0.9.0 (2026-11-01)\n\n### Older\n';
	withChangelog(changelog, (file) => {
		const { status, out } = notesFor('1.0.0', file);
		assert.equal(status, 0);
		assert.equal(out, '## Small fixes\n\n### Fixed\n\n- A fix.\n\n#### Aside\n\nText with ### inside.\n');
	});
});

test('notes that open without a headline stop with a message, as the old shape does', () => {
	withChangelog('## 1.0.0 (2026-12-01)\n\nSmall fixes\n\n### Fixed\n\n- A fix.\n', (file) => {
		const { status, out, err } = notesFor('1.0.0', file);
		assert.equal(status, 1);
		assert.equal(out, '');
		assert.match(err, /section for 1\.0\.0 doesn't open with its headline/);
	});
	withChangelog('## 1.0.0 (2026-12-01)\n\n#### Fixed\n\n- A fix.\n', (file) => {
		assert.equal(notesFor('1.0.0', file).status, 1);
	});
});

test('notes with a second headline stop with a message', () => {
	withChangelog('## 1.0.0 (2026-12-01)\n\n### Small fixes\n\n### Fixed\n\n- A fix.\n', (file) => {
		const { status, out, err } = notesFor('1.0.0', file);
		assert.equal(status, 1);
		assert.equal(out, '');
		assert.match(err, /section for 1\.0\.0 has more than one headline/);
	});
});

test('no version given stops with a message', () => {
	const { status, err } = notesFor();
	assert.equal(status, 1);
	assert.match(err, /Give a version/);
});
