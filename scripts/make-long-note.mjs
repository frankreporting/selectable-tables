// Writes the test vault's "Long note": a few thousand lines of invented text with dozens of tables, used
// only to check that the plugin's cost per keystroke doesn't grow with a note's length.
import { writeFileSync } from 'node:fs';

const words = ['river', 'lantern', 'meadow', 'copper', 'harbor', 'thistle', 'orchard', 'pebble', 'willow', 'canvas'];
const sentence = (n) => {
	const picked = Array.from({ length: 8 }, (_, i) => words[(n * 7 + i * 3) % words.length]);
	return `Line ${n}: the ${picked.slice(0, 4).join(' ')} and the ${picked.slice(4).join(' ')}.`;
};

// Padded the way Obsidian's table editor pads a table when a cell opens, so timing runs that open cells
// leave the note unchanged.
function table(rows) {
	const widths = rows[0].map((_, col) => Math.max(3, ...rows.map((row) => row[col].length)));
	const line = (cells) => `| ${cells.map((cell, col) => cell.padEnd(widths[col])).join(' | ')} |`;
	return [line(rows[0]), line(widths.map((width) => '-'.repeat(width))), ...rows.slice(1).map(line)];
}

const lines = ['# Long note', ''];
let n = 1;
for (let section = 1; section <= 40; section++) {
	lines.push(`## Section ${section}`, '');
	for (let i = 0; i < 50; i++) lines.push(sentence(n++));
	const rows = [['Item', 'Count', 'Place', 'Note']];
	for (let row = 1; row <= 6; row++) {
		rows.push([words[(section + row) % words.length], String(section * 10 + row), words[row % words.length], `row ${row}`]);
	}
	lines.push('', ...table(rows), '');
	for (let i = 0; i < 15; i++) lines.push(sentence(n++));
	lines.push('');
}
writeFileSync('test-vault/Selectable Tables Test/Long note.md', lines.join('\n'));
