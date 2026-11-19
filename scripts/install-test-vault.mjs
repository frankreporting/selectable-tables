// Copies the built plugin into the test vault, where Obsidian loads it. Run through `npm run test-vault`, which
// builds a preview first and writes the test vault's large table note if it isn't there.
//   --preview      the build is a preview: its styles add the plugin's own table's (src/own-table/styles.css)
//   --to <folder>  another vault's plugin folder, such as the main clone's test vault from a worktree
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const preview = args.includes('--preview');
const to = args.indexOf('--to');
const target = to >= 0 && args[to + 1] ? args[to + 1] : 'test-vault/Selectable Tables Test/.obsidian/plugins/selectable-tables';
mkdirSync(target, { recursive: true });
for (const file of ['main.js', 'manifest.json']) {
	if (existsSync(file)) copyFileSync(file, `${target}/${file}`);
}
const styles = [readFileSync('styles.css', 'utf8')];
if (preview) styles.push(readFileSync('src/own-table/styles.css', 'utf8'));
writeFileSync(`${target}/styles.css`, styles.join('\n'));
console.log(`Copied the plugin${preview ? ' (a preview)' : ''} into ${target}`);
