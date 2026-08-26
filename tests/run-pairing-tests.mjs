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
await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
