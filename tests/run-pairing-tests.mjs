import esbuild from "esbuild";
import path from "node:path";

const result = await esbuild.build({
	entryPoints: ["tests/pairing-state.test.ts"],
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node20",
	alias: { obsidian: path.resolve("tests/obsidian-stub.ts") },
	write: false,
	logLevel: "silent",
});

const source = result.outputFiles[0].text;
try {
	await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
} catch (error) {
	// An uncaught data: URL stack dumps the entire bundled test suite as base64.
	console.error(error instanceof Error ? `${error.name}: ${error.message}` : error);
	process.exitCode = 1;
}
