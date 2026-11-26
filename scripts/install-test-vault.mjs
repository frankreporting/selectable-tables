// Copies the built plugin into the test vault, where Obsidian loads it. Run through `npm run test-vault`, which
// builds it first and writes the test vault's large table note if it isn't there.
//   --to <folder>  another vault's plugin folder, such as the main clone's test vault from a worktree
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const to = args.indexOf('--to');
const target = to >= 0 && args[to + 1] ? args[to + 1] : 'test-vault/Selectable Tables Test/.obsidian/plugins/selectable-tables';
mkdirSync(target, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
	if (existsSync(file)) copyFileSync(file, `${target}/${file}`);
}
console.log(`Copied the plugin into ${target}`);
