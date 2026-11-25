// Prints a version's release notes from CHANGELOG.md, as they're published
// (`node scripts/release-notes.mjs 0.2.3`). In the changelog they sit one level down, under the
// version's `## <version> (<date>)` heading: the headline as `### …`, then its sections as
// `#### New`, `#### Improved` and `#### Fixed`. The script prints the text under the version's
// heading, up to the next `## ` heading, with every heading lifted one level, so the release opens
// with an H2 headline and has an H3 for each section. The release workflow puts them on the draft
// release a tag builds, and stops when the version has no notes, or notes that don't open with
// their one headline, so no release is drafted without them or in the old shape. A second argument
// reads another file, for the tests.
import { readFileSync } from 'node:fs';

const stop = (message) => {
	console.error(message);
	process.exit(1);
};

const [version, file] = process.argv.slice(2);
if (!version) stop('Give a version: node scripts/release-notes.mjs 0.2.3');

const lines = readFileSync(file ?? new URL('../CHANGELOG.md', import.meta.url), 'utf8').split(/\r?\n/);
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(`^## ${escaped}(?: \\(.*\\))?\\s*$`);
const start = lines.findIndex((line) => heading.test(line));
const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
const notes = start === -1 ? '' : lines.slice(start + 1, end === -1 ? undefined : end).join('\n').trim();

if (notes === '') {
	stop(
		start === -1
			? `CHANGELOG.md has no section for ${version}. Add its notes under "## ${version} (<date>)" before tagging.`
			: `CHANGELOG.md's section for ${version} is empty. Add its notes before tagging.`,
	);
}

const headline = /^### \S/;
const shape = `Start it with its headline as "### <headline>", and put its sections under it as "#### New", "#### Improved" and "#### Fixed".`;
if (!headline.test(notes)) stop(`CHANGELOG.md's section for ${version} doesn't open with its headline. ${shape}`);
if (notes.split('\n').filter((line) => headline.test(line)).length > 1) {
	stop(`CHANGELOG.md's section for ${version} has more than one headline. ${shape}`);
}

process.stdout.write(`${notes.replace(/^#(#{2,}) /gm, '$1 ')}\n`);
