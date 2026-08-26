import assert from "node:assert/strict";
import { footnoteRefIsVisible, scanFootnotes } from "../src/footnote-scan";
import { normalizeMarkdownMarginSettings } from "../src/markdown-margin-settings";

const text = "隐藏[^same]\n显示[^same]\n\n[^same]: 侧注";
const refs = scanFootnotes(text).refs;
assert.equal(refs.length, 2);
assert.equal(refs[0].to - refs[0].pos, "[^same]".length);
assert.equal(footnoteRefIsVisible(refs[0], [{ from: 0, to: text.length }]), true);
assert.equal(footnoteRefIsVisible(refs[0], [{ from: refs[0].to, to: text.length }]), false);
assert.equal(footnoteRefIsVisible(refs[1], [{ from: refs[1].pos, to: refs[1].to }]), true);

assert.deepEqual(normalizeMarkdownMarginSettings(undefined), { width: 176, gap: 12 });
assert.deepEqual(normalizeMarkdownMarginSettings({ width: 40, gap: -2 }), { width: 120, gap: 4 });
assert.deepEqual(normalizeMarkdownMarginSettings({ width: 900, gap: 20.4 }), { width: 480, gap: 20 });

console.log("markdown-margin/fold-visibility: 8 cases passed");
