// Prints a version's release notes from CHANGELOG.md: the text under its `## <version> (<date>)`
// heading, up to the next `## ` heading, without the heading itself
// (`node scripts/release-notes.mjs 0.2.3`). The release workflow puts them on the draft release a
// tag builds, and stops when the version has no notes, so no release is drafted without them. A
// second argument reads another file, for the tests.
import { readFileSync } from 'node:fs';

const [version, file] = process.argv.slice(2);
if (!version) {
	console.error('Give a version: node scripts/release-notes.mjs 0.2.3');
	process.exit(1);
}

const lines = readFileSync(file ?? new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/);
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^## ${escaped}(?: \\(.*\\))?\\s*$`);
const start = lines.findIndex((line) => heading.test(line));
const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
const notes = start === -1 ? '' : lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();

if (notes === '') {
	console.error(
		start === -1
			? `CHANGELOG.md has no section for ${version}. Add its notes under "## ${version} (<date>)" before tagging.`
			: `CHANGELOG.md's section for ${version} is empty. Add its notes before tagging.`,
	);
	process.exit(1);
}
process.stdout.write(`${notes}\n`);
