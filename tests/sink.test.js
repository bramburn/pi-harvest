/**
 * Tests for the DPO sink.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const sink = require("../dist/sink.js");

function tmpCwd() {
 return fs.mkdtempSync(path.join(os.tmpdir(), "pi-harvest-test-"));
}

test("writeDpoEntry: creates .pi/harvest/ and appends a JSON line", () => {
 const cwd = tmpCwd();
 try {
 const audit = {
 inferred_subtask: "build hello",
 divergence_detected: true,
 divergence_turn: 3,
 flaw_category: "logic_error",
 root_cause: "wrong import",
 discard_advice: "drop turns 2-3",
 steering_instructions: "fix the import",
 };
 const slice = {
 inceptionIndex: 0,
 branchEntries: [],
 sliceEntries: [],
 failedCode: "console.log('oops')",
 compilerError: "error[E0425]: cannot find `foo`",
 inceptionPrompt: "build hello",
 divergenceEntryId: null,
 };

 const result = sink.writeDpoEntry({
 audit,
 slice,
 chosenCompletion: "console.log('hello')",
 rejectedCompletion: "console.log('oops')",
 ctx: { cwd, sessionManager: { getSessionId: () => "sess-1" } },
 domainTags: ["rust", "build"],
 });

 assert.equal(result.bytes > 0, true);
 const filePath = path.join(cwd, ".pi", "harvest", "trajectories.jsonl");
 assert.equal(fs.existsSync(filePath), true);

 const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
 assert.equal(lines.length, 1);
 const parsed = JSON.parse(lines[0]);
 assert.equal(parsed.session_id, "sess-1");
 assert.deepEqual(parsed.domain_tags, ["rust", "build"]);
 assert.equal(parsed.k3_diagnosis.inferred_subtask, "build hello");
 assert.equal(parsed.rejected_completion, "console.log('oops')");
 assert.equal(parsed.chosen_completion, "console.log('hello')");
 assert.equal(parsed.immediate_prompt, "build hello");
 assert.equal(typeof parsed.ts, "string");
 } finally {
 fs.rmSync(cwd, { recursive: true, force: true });
 }
});

test("writeDpoEntry: appends to an existing file without clobbering", () => {
 const cwd = tmpCwd();
 try {
 const audit = {
 inferred_subtask: "x",
 divergence_detected: false,
 divergence_turn: 0,
 flaw_category: "none",
 root_cause: "",
 discard_advice: "",
 steering_instructions: "continue",
 };
 const slice = {
 inceptionIndex: 0,
 branchEntries: [],
 sliceEntries: [],
 failedCode: "",
 compilerError: "",
 inceptionPrompt: "x",
 divergenceEntryId: null,
 };

 const args = {
 audit,
 slice,
 chosenCompletion: "A",
 rejectedCompletion: "R",
 ctx: { cwd, sessionManager: { getSessionId: () => "s" } },
 };

 sink.writeDpoEntry(args);
 sink.writeDpoEntry({ ...args, chosenCompletion: "B", rejectedCompletion: "R2" });

 const filePath = path.join(cwd, ".pi", "harvest", "trajectories.jsonl");
 const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
 assert.equal(lines.length, 2);
 assert.equal(JSON.parse(lines[0]).chosen_completion, "A");
 assert.equal(JSON.parse(lines[1]).chosen_completion, "B");
 } finally {
 fs.rmSync(cwd, { recursive: true, force: true });
 }
});
