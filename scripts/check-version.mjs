// Checks that package.json, manifest.json and versions.json name the same version, and, given a
// tag (`node scripts/check-version.mjs 0.2.3`), that the tag names it too. The directory reads
// manifest.json on the default branch and installs the release whose tag matches its version,
// so a mismatch ships a version nobody can install.
import { readFileSync } from 'node:fs';

const read = (file) => JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'));
const pkg = read('package.json');
const manifest = read('manifest.json');
const versions = read('versions.json');
const tag = process.argv[2];

const problems = [];
if (pkg.version !== manifest.version) {
	problems.push(`package.json has ${pkg.version}, manifest.json has ${manifest.version}.`);
}
if (versions[manifest.version] !== manifest.minAppVersion) {
	problems.push(
		`versions.json maps ${manifest.version} to ${versions[manifest.version] ?? 'nothing'}, ` +
			`manifest.json's minAppVersion is ${manifest.minAppVersion}.`,
	);
}
if (tag !== undefined && tag !== manifest.version) {
	problems.push(`The tag is ${tag}, manifest.json has ${manifest.version}.`);
}

if (problems.length > 0) {
	console.error(problems.join('\n'));
	process.exit(1);
}
console.log(`Version ${manifest.version} matches${tag === undefined ? '' : ' the tag'}.`);
