import assert from "node:assert/strict";
import { searchFolderPaths } from "../src/pdf/folder-path-search";

const paths = [
	"99_assets/plugin-data/att-meta-map",
	"99_assets/plugin-data/margin-note",
	"70_research/神经网络",
	"70_research/神经网络/hopfield",
	"30_resource/book",
];

assert.equal(searchFolderPaths(paths, "", "99_assets/plugin-data/margin-note")[0], "99_assets/plugin-data/margin-note");
assert.equal(searchFolderPaths(paths, "margin")[0], "99_assets/plugin-data/margin-note");
assert.equal(searchFolderPaths(paths, "mrgn")[0], "99_assets/plugin-data/margin-note");
assert.equal(searchFolderPaths(paths, "plugin data")[0], "99_assets/plugin-data/margin-note");
assert.deepEqual(searchFolderPaths(paths, "不存在的目录"), []);
assert.equal(searchFolderPaths(paths, "神经网络/hopfield")[0], "70_research/神经网络/hopfield");
assert.deepEqual(searchFolderPaths(paths, "", "", 2).length, 2);
assert.equal(searchFolderPaths(["notes/cafe\u0301"], "café")[0], "notes/cafe\u0301");
console.log("folder-path-search: 8 cases passed");
