import assert from "node:assert/strict";
import { isMarkClick } from "../src/pdf/mark-click";

const start = { x: 100, y: 200, button: 0 };
assert.equal(isMarkClick(start, { x: 102, y: 201 }, ""), true);
assert.equal(isMarkClick(start, { x: 102, y: 201 }, "a"), false);
assert.equal(isMarkClick(start, { x: 102, y: 201 }, "  词  "), false);
assert.equal(isMarkClick(start, { x: 120, y: 201 }, ""), false);
assert.equal(isMarkClick({ ...start, button: 2 }, { x: 100, y: 200 }, ""), false);
assert.equal(isMarkClick(null, { x: 100, y: 200 }, ""), false);
