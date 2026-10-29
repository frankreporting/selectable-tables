import obsidianmd from 'eslint-plugin-obsidianmd';
import globals from 'globals';
import { globalIgnores, defineConfig } from 'eslint/config';

export default defineConfig(
	globalIgnores([
		'node_modules',
		'dist',
		'.test-build',
		'test-vault',
		// Runs inside Obsidian through its CLI's eval, outside the plugin bundle.
		'scripts/obsidian-check.js',
		'esbuild.config.mjs',
		'version-bump.mjs',
		'versions.json',
		'main.js',
		'package.json',
		'package-lock.json',
		'tsconfig.json',
	]),
	{
		languageOptions: {
			globals: {
				...globals.browser,
			},
			parserOptions: {
				projectService: {
					allowDefaultProject: ['eslint.config.mts', 'manifest.json', 'scripts/*.mjs'],
				},
				tsconfigRootDir: import.meta.dirname,
				extraFileExtensions: ['.json'],
			},
		},
	},
	...obsidianmd.configs.recommended,
	{
		// Tests and repo scripts run in Node, never inside Obsidian.
		files: ['test/**/*.ts', 'scripts/*.mjs'],
		languageOptions: {
			globals: {
				...globals.node,
			},
		},
		rules: {
			'obsidianmd/no-nodejs-modules': 'off',
			'@typescript-eslint/no-floating-promises': 'off',
			'obsidianmd/hardcoded-config-path': 'off',
			'obsidianmd/rule-custom-message': 'off',
		},
	},
);
