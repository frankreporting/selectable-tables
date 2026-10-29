// Copies the built plugin into the test vault, where Obsidian loads it. Run through `npm run test-vault`,
// which builds first.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';

const target = 'test-vault/Selectable Tables Test/.obsidian/plugins/selectable-tables';
mkdirSync(target, { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
	if (existsSync(file)) copyFileSync(file, `${target}/${file}`);
}
console.log(`Copied the plugin into ${target}`);
