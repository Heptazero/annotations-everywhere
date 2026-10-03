import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
	...obsidianmd.configs.recommended,
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
			},
		},
	},
]);
