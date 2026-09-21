/**
 * Unit tests for the slice extractor + clampCompilerOutput + payload guard.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as slice from "../dist/slice.js";

function msg(role: string, text: string) {
 return {
 type: "message" as const,
 id: "id-" + Math.random(),
 parentId: null,
 timestamp: "2026-01-01T00:00:00.000Z",
 message: { role, content: text },
 };
}

test("extractNeatSlice: returns degenerate result for empty input", () => {
 const out = slice.extractNeatSlice([], "/tmp");
 assert.equal(out.inceptionIndex, -1);
 assert.equal(out.failedCode, "");
 assert.equal(out.compilerError, "");
});

test("extractNeatSlice: returns degenerate result when no user message", () => {
 const branch = [msg("assistant", "hi"), msg("tool", "output")];
 const out = slice.extractNeatSlice(branch, "/tmp");
 assert.equal(out.inceptionIndex, -1);
 assert.equal(out.failedCode.length > 0, true);
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
 const out = slice.extractNeatSlice(branch, "/tmp");
 assert.equal(out.inceptionIndex, 4);
 assert.equal(out.inceptionPrompt, "user B — newer inception");
 assert.equal(out.sliceEntries.length, 3);
});

test("extractNeatSlice: pulls the last assistant text as failedCode", () => {
 const branch = [
 msg("user", "build hello"),
 msg("assistant", "first attempt"),
 msg("tool", "error[E0425] bad"),
 msg("assistant", "second attempt — final"),
 ];
 const out = slice.extractNeatSlice(branch, "/tmp");
 assert.equal(out.failedCode, "second attempt — final");
});

test("extractNeatSlice: extracts compiler error and clamps it", () => {
 const branch = [
 msg("user", "build"),
 msg("tool", "warning: unused variable `x`\nerror[E0425]: cannot find value `x`\n   --> src/main.rs:3:5\n"),
 ];
 const out = slice.extractNeatSlice(branch, "/tmp");
 assert.match(out.compilerError, /error\[E0425\]/);
 // warning line should be stripped
 assert.doesNotMatch(out.compilerError, /warning:/);
});

test("extractNeatSlice: case-insensitive scan still works", () => {
 const branch = [
 msg("user", "build"),
 msg("tool", "FAILED TO COMPILE: missing import"),
 ];
 const out = slice.extractNeatSlice(branch, "/tmp");
 assert.match(out.compilerError, /FAILED TO COMPILE/);
});

test("extractNeatSlice: collects modifiedPaths when cwd is provided", () => {
 const branch = [
 msg("user", "edit foo.rs"),
 {
 type: "message" as const,
 id: "a1",
 parentId: null,
 timestamp: "2026-01-01T00:00:00.000Z",
 message: {
 role: "assistant",
 content: [
 {
 type: "toolCall",
 name: "write",
 id: "tc1",
 arguments: { path: "/tmp/proj/src/foo.rs", content: "fn main() {}" },
 },
 ],
 },
 },
 ];
 const out = slice.extractNeatSlice(branch, "/tmp/proj");
 assert.deepEqual(out.modifiedPaths, ["src/foo.rs"]);
});

test("clampCompilerOutput: keeps error lines and strips warning lines", () => {
 const raw = [
 "warning: unused variable",
 "warning: deprecated function call",
 "  --> src/main.rs:3:5",
 "error[E0425]: cannot find value `x`",
 "  --> src/main.rs:4:5",
 "error: aborting due to previous error",
 ].join("\n");
 const out = slice.clampCompilerOutput(raw, 50);
 assert.match(out, /error\[E0425\]/);
 assert.match(out, /aborting/);
 assert.doesNotMatch(out, /warning/);
});

test("clampCompilerOutput: appends truncation marker when over limit", () => {
 const big = Array.from({ length: 200 }, (_, i) => "warning: line " + i).join("\n");
 const out = slice.clampCompilerOutput(big, 10);
 // Should drop all warnings (no error-ish lines) and clamp.
 assert.match(out, /clamped/);
});

test("enforcePayloadSize: passes through short payloads", () => {
 const s = "hello world";
 assert.equal(slice.enforcePayloadSize(s, 100), "hello world");
});

test("enforcePayloadSize: clamps over-limit payloads at a newline", () => {
 const s = "a".repeat(100) + "\n" + "b".repeat(100) + "\n" + "c".repeat(100);
 const out = slice.enforcePayloadSize(s, 150);
 assert.ok(Buffer.byteLength(out, "utf8") <= 250); // 150 + marker overhead
 assert.match(out, /clamped/);
});

test("serializeSliceForVerifier: numbers turns and includes role", () => {
 const branch = [msg("user", "build hello"), msg("assistant", "first attempt")];
 const out = slice.extractNeatSlice(branch, "/tmp");
 const serialized = slice.serializeSliceForVerifier(out);
 assert.match(serialized, /=== TURN 1 \(user\) ===/);
 assert.match(serialized, /=== TURN 2 \(assistant\) ===/);
 assert.match(serialized, /build hello/);
});

test("buildVerifierPayload: includes inception, clamped error, code, paths, transcript", () => {
 const branch = [
 msg("user", "build hello world"),
 msg("assistant", "fn main() {}"),
 msg("tool", "error[E0425]: x not found\n   --> src/main.rs:1:1"),
 ];
 const out = slice.extractNeatSlice(branch, "/tmp");
 const payload = slice.buildVerifierPayload(out);
 assert.match(payload, /INCEPTION PROMPT/);
 assert.match(payload, /build hello world/);
 assert.match(payload, /COMPILER ERROR/);
 assert.match(payload, /LAST ASSISTANT CODE/);
 assert.match(payload, /fn main\(\) \{\}/);
 assert.match(payload, /TRANSCRIPT/);
});

test("entryIdForDivergenceTurn: maps 1-based turn to entry id", () => {
 const branch = [msg("user", "go"), msg("assistant", "v1"), msg("tool", "err")];
 const out = slice.extractNeatSlice(branch, "/tmp");
 const id = slice.entryIdForDivergenceTurn(out, 2);
 assert.equal(id, branch[1].id);
});

test("entryIdForDivergenceTurn: clamps when out of range", () => {
 const branch = [msg("user", "go"), msg("assistant", "v1")];
 const out = slice.extractNeatSlice(branch, "/tmp");
 assert.equal(slice.entryIdForDivergenceTurn(out, 99), branch[1].id);
});

test("entryIdForDivergenceTurn: returns null for invalid input", () => {
 const branch = [msg("user", "go")];
 const out = slice.extractNeatSlice(branch, "/tmp");
 assert.equal(slice.entryIdForDivergenceTurn(out, 0), null);
 assert.equal(slice.entryIdForDivergenceTurn(out, -1), null);
 assert.equal(slice.entryIdForDivergenceTurn(out, NaN), null);
});

// ---------------------------------------------------------------------------
// Phase 7 bugfix regression: real pi ToolResultEvent shape
//
// Real pi emits tool_result events with `content: Array<TextContent |
// ImageContent>`, where each text part carries `.text`. The extension's
// tool_result handler reads this array to detect compile failures and
// drive Phase 7 SFT capture. Earlier the handler read undefined
// `output`/`stdout`/`stderr` instead and silently never detected
// anything. extractToolResultText is the pure helper that fixes it.
// ---------------------------------------------------------------------------

test("extractToolResultText: real pi shape with content[] (text + image)", () => {
 const out = slice.extractToolResultText({
 toolName: "bash",
 isError: false,
 content: [
 { type: "text", text: "error[E0425]: cannot find value x" },
 { type: "image", data: "abc", mimeType: "image/png" },
 ],
 });
 assert.equal(out, "error[E0425]: cannot find value x");
});

test("extractToolResultText: multi-part content joins with newlines", () => {
 const out = slice.extractToolResultText({
 toolName: "bash",
 content: [
 { type: "text", text: "line one" },
 { type: "text", text: "line two" },
 ],
 });
 assert.equal(out, "line one\nline two");
});

test("extractToolResultText: legacy output/stdout/stderr shape still works", () => {
 const out = slice.extractToolResultText({
 toolName: "bash",
 output: "from output",
 stdout: "from stdout",
 });
 assert.match(out, /from output/);
 assert.match(out, /from stdout/);
});

test("extractToolResultText: string content passes through", () => {
 const out = slice.extractToolResultText({
 toolName: "bash",
 content: "direct string",
 });
 assert.equal(out, "direct string");
});

test("extractToolResultText: returns empty string for non-object / null", () => {
 assert.equal(slice.extractToolResultText(null), "");
 assert.equal(slice.extractToolResultText(undefined), "");
 assert.equal(slice.extractToolResultText("string"), "");
 assert.equal(slice.extractToolResultText(42), "");
});

test("extractToolResultText: empty content + empty legacy fields returns empty string", () => {
 const out = slice.extractToolResultText({ toolName: "bash", content: [] });
 assert.equal(out, "");
});

test("extractToolResultText: drops empty text parts but keeps non-empty ones", () => {
 const out = slice.extractToolResultText({
 toolName: "bash",
 content: [
 { type: "text", text: "" },
 { type: "text", text: "real" },
 { type: "text", text: "" },
 ],
 });
 assert.equal(out, "real");
});
