/**
 * Unit tests for the slice extractor.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");

const slice = require("../dist/slice.js");

function msg(role, text) {
 return {
 type: "message",
 id: `id-${Math.random()}`,
 parentId: null,
 timestamp: "2026-01-01T00:00:00.000Z",
 message: { role, content: text },
 };
}

test("extractNeatSlice: returns degenerate result for empty input", () => {
 const out = slice.extractNeatSlice([]);
 assert.equal(out.inceptionIndex, -1);
 assert.equal(out.failedCode, "");
 assert.equal(out.compilerError, "");
});

test("extractNeatSlice: returns degenerate result when no user message", () => {
 const branch = [msg("assistant", "hi"), msg("tool", "output")];
 const out = slice.extractNeatSlice(branch);
 assert.equal(out.inceptionIndex, -1);
 assert.equal(out.failedCode.length > 0, true); // picks last assistant
});

test("extractNeatSlice: finds the most recent user message as inception", () => {
 const branch = [
 msg("assistant", "earlier assistant"),
 msg("user", "user A — first inception"),
 msg("assistant", "work after A"),
 msg("tool", "OK output"),
 msg("user", "user B — newer inception"),
 msg("assistant", "work after B"),
 msg("tool", "failed: error[E0425]: oops"),
 ];
 const out = slice.extractNeatSlice(branch);
 assert.equal(out.inceptionIndex, 4);
 assert.equal(out.inceptionPrompt, "user B — newer inception");
 assert.equal(out.sliceEntries.length, 3); // user B + assistant B + tool
});

test("extractNeatSlice: pulls the last assistant text as failedCode", () => {
 const branch = [
 msg("user", "build hello"),
 msg("assistant", "first attempt"),
 msg("tool", "error[E0425] bad"),
 msg("assistant", "second attempt — final"),
 ];
 const out = slice.extractNeatSlice(branch);
 assert.equal(out.failedCode, "second attempt — final");
});

test("extractNeatSlice: extracts compiler error from bash tool result", () => {
 const branch = [
 msg("user", "build"),
 msg("assistant", "code"),
 msg("tool", "some unrelated output"),
 msg("tool", "error[E0425]: cannot find value `x`\n--> src/main.rs:3:5\n"),
 ];
 const out = slice.extractNeatSlice(branch);
 assert.match(out.compilerError, /error\[E0425\]/);
});

test("extractNeatSlice: case-insensitive match on compiler signature", () => {
 const branch = [
 msg("user", "build"),
 msg("tool", "FAILED TO COMPILE: missing import"),
 ];
 const out = slice.extractNeatSlice(branch);
 assert.match(out.compilerError, /FAILED TO COMPILE/);
});

test("serializeSliceForVerifier: numbers turns and includes role", () => {
 const branch = [
 msg("user", "build hello"),
 msg("assistant", "first attempt"),
 ];
 const out = slice.extractNeatSlice(branch);
 const serialized = slice.serializeSliceForVerifier(out);
 assert.match(serialized, /=== TURN 1 \(user\) ===/);
 assert.match(serialized, /=== TURN 2 \(assistant\) ===/);
 assert.match(serialized, /build hello/);
});

test("entryIdForDivergenceTurn: returns the entry id at divergence_turn (1-based)", () => {
 const branch = [
 msg("user", "go"),
 msg("assistant", "v1"),
 msg("tool", "err"),
 msg("assistant", "v2"),
 msg("tool", "err"),
 ];
 const out = slice.extractNeatSlice(branch);
 const id = slice.entryIdForDivergenceTurn(out, 4); // v2 (the divergence)
 assert.equal(id, branch[3].id);
});

test("entryIdForDivergenceTurn: clamps to last slice entry when out of range", () => {
 const branch = [msg("user", "go"), msg("assistant", "v1")];
 const out = slice.extractNeatSlice(branch);
 const id = slice.entryIdForDivergenceTurn(out, 99);
 assert.equal(id, branch[1].id);
});

test("entryIdForDivergenceTurn: returns null for invalid turn numbers", () => {
 const branch = [msg("user", "go")];
 const out = slice.extractNeatSlice(branch);
 assert.equal(slice.entryIdForDivergenceTurn(out, 0), null);
 assert.equal(slice.entryIdForDivergenceTurn(out, -3), null);
 assert.equal(slice.entryIdForDivergenceTurn(out, NaN), null);
});
