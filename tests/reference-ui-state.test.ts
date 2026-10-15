import assert from "node:assert/strict";
import { settingsSearchMatcher } from "../src/pdf/settings-search";
import { referencePickerNextIndex, referencePickerPlacement } from "../src/pdf/reference-picker-layout";

assert.equal(settingsSearchMatcher("")([]), true);
assert.equal(settingsSearchMatcher("颜色 定理")(["颜色与语义组", "定理与证明"]), true);
assert.equal(settingsSearchMatcher("定理 颜色")(["颜色与语义组", "定理与证明"]), true);
assert.equal(settingsSearchMatcher("管理 research")(["管理", "存放路径", "99_assets/research"]), true);
assert.equal(settingsSearchMatcher("CAFÉ")(["cafe\u0301"]), true);
assert.equal(settingsSearchMatcher("中文不存在")(["颜色", "已填路径"]), false);
assert.equal(settingsSearchMatcher("引用 模板")(["引用", "复制格式", "仅链接模板"]), true);

assert.equal(referencePickerNextIndex("ArrowUp", -1, 5), 4);
assert.equal(referencePickerNextIndex("ArrowDown", -1, 5), 0);
assert.equal(referencePickerNextIndex("ArrowDown", 4, 5), 4);
assert.equal(referencePickerNextIndex("ArrowUp", 0, 5), 0);
assert.equal(referencePickerNextIndex("Home", 3, 5), 0);
assert.equal(referencePickerNextIndex("End", 0, 5), 4);
assert.equal(referencePickerNextIndex("Home", -1, 5), null, "search retains native caret navigation");
assert.equal(referencePickerNextIndex("End", -1, 5), null);
assert.equal(referencePickerNextIndex("ArrowDown", -1, 0), null);

const desktop = referencePickerPlacement({ x: 950, y: 760 }, { width: 340, height: 350 }, { left: 0, top: 0, width: 1024, height: 800 });
assert.deepEqual(desktop, { left: 676, top: 442, maxWidth: 1008, maxHeight: 784 });
// Keyboard height and visual-viewport offsets are independent of layout viewport size.
const mobile = referencePickerPlacement({ x: 300, y: 650 }, { width: 340, height: 400 }, { left: 10, top: 120, width: 320, height: 240 });
assert.deepEqual(mobile, { left: 18, top: 128, maxWidth: 304, maxHeight: 224 });
for (const width of [8, 200, 375, 1024]) for (const height of [8, 120, 800]) {
	const viewport = { left: 12, top: 80, width, height };
	for (const anchor of [{ x: -500, y: -10 }, { x: 8000, y: 9000 }]) {
		const result = referencePickerPlacement(anchor, { width: 340, height: 400 }, viewport);
		assert.ok(result.left >= viewport.left && result.top >= viewport.top);
		assert.ok(result.left + Math.min(340, result.maxWidth) <= viewport.left + width);
		assert.ok(result.top + Math.min(400, result.maxHeight) <= viewport.top + height);
	}
}
console.log("reference-ui-state: Unicode/multi-term settings search, result keyboard navigation and visible viewport bounds passed");
