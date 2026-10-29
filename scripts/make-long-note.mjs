// Writes the test vault's "Long note": a few thousand lines of invented text with dozens of tables, used
// only to check that the plugin's cost per keystroke doesn't grow with a note's length.
import { writeFileSync } from 'node:fs';

const words = ['river', 'lantern', 'meadow', 'copper', 'harbor', 'thistle', 'orchard', 'pebble', 'willow', 'canvas'];
const sentence = (n) => {
	const picked = Array.from({ length: 8 }, (_, i) => words[(n * 7 + i * 3) % words.length]);
	return `Line ${n}: the ${picked.slice(0, 4).join(' ')} and the ${picked.slice(4).join(' ')}.`;
};

const lines = ['# Long note', ''];
let n = 1;
for (let section = 1; section <= 40; section++) {
	lines.push(`## Section ${section}`, '');
	for (let i = 0; i < 50; i++) lines.push(sentence(n++));
	lines.push('', '| Item | Count | Place | Note |', '| ---- | ----- | ----- | ---- |');
	for (let row = 1; row <= 6; row++) {
		lines.push(`| ${words[(section + row) % words.length]} | ${section * 10 + row} | ${words[row % words.length]} | row ${row} |`);
	}
	lines.push('');
	for (let i = 0; i < 15; i++) lines.push(sentence(n++));
	lines.push('');
}
writeFileSync('test-vault/Selectable Tables Test/Long note.md', lines.join('\n'));
