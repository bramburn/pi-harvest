/**
 * Unit tests for the DPO/SFT sink (Phase 3 schema).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sink from "../dist/sink.js";
import type { ActiveFile, HarvestedTrajectoryRecord, NeatSlice, VerifierAudit } from "../dist/types.js";

async function tmpCwd() {
 return await mkdtemp(join(tmpdir(), "pi-harvest-sink-"));
}

const BASE_AUDIT: VerifierAudit = {
 inferred_subtask: "build hello",
 divergence_detected: true,
 divergence_turn_entry_id: "a1",
 flaw_category: "logic_error",
 root_cause: "wrong import",
 discard_advice: "drop turn 2",
 steering_instructions: "fix the import",
 domain_tags: ["rust", "tauri"],
};

const BASE_SLICE: NeatSlice = {
 inceptionIndex: 0,
 branchEntries: [],
 sliceEntries: [],
 failedCode: "console.log('oops')",
 compilerError: "error[E0425]: cannot find foo",
 compilerErrorRaw: "error[E0425]: cannot find foo",
 inceptionPrompt: "build hello",
 modifiedPaths: ["src/main.rs"],
 divergenceEntryId: "a1",
};

test("buildTrajectoryRecord: produces a fully populated Phase 3 record", () => {
 const rec = sink.buildTrajectoryRecord({
 audit: BASE_AUDIT,
 slice: BASE_SLICE,
 activeFiles: [{ path: "src/main.rs", content: "fn main() {}", truncated: false }],
 chosenCompletion: "fn main() { println!(\"hi\"); }",
 rejectedCompletion: "console.log('oops')",
 workerModel: "minimax:MiniMax-M3",
 verifierModel: "kimi-k2",
 triggerReason: "compiler_streak",
 divergenceEntryId: "a1",
 domainTags: ["rust", "tauri"],
 ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "sess-1" } },
 });
 assert.equal(rec.session_id, "sess-1");
 assert.equal(rec.worker_model, "minimax:MiniMax-M3");
 assert.equal(rec.verifier_model, "kimi-k2");
 assert.equal(rec.trigger_reason, "compiler_streak");
 assert.deepEqual(rec.domain_tags, ["rust", "tauri"]);
 assert.equal(rec.immediate_prompt, "build hello");
 assert.equal(rec.active_files.length, 1);
 assert.equal(rec.active_files[0].path, "src/main.rs");
 assert.equal(rec.compiler_error_summary, "error[E0425]: cannot find foo");
 assert.equal(rec.k3_audit.divergence_entry_id, "a1");
 assert.equal(rec.k3_audit.flaw_category, "logic_error");
 assert.equal(rec.rejected_completion, "console.log('oops')");
 assert.equal(rec.chosen_completion, "fn main() { println!(\"hi\"); }");
 assert.match(rec.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("writeTrajectoryRecord: creates .pi/harvest/ and appends a JSON line", async () => {
 const cwd = await tmpCwd();
 try {
 const rec = sink.buildTrajectoryRecord({
 audit: BASE_AUDIT,
 slice: BASE_SLICE,
 activeFiles: [],
 chosenCompletion: "C",
 rejectedCompletion: "R",
 workerModel: "w",
 verifierModel: "v",
 triggerReason: "manual",
 divergenceEntryId: null,
 domainTags: ["rust"],
 ctx: { cwd, sessionManager: { getSessionId: () => "s" } },
 });
 const result = sink.writeTrajectoryRecord(rec, cwd);
 assert.equal(result.bytes > 0, true);
 const filePath = join(cwd, ".pi", "harvest", "trajectories.jsonl");
 const lines = (await readFile(filePath, "utf8")).trim().split("\n");
 assert.equal(lines.length, 1);
 const parsed = JSON.parse(lines[0]) as HarvestedTrajectoryRecord;
 assert.equal(parsed.session_id, "s");
 assert.equal(parsed.trigger_reason, "manual");
 assert.deepEqual(parsed.domain_tags, ["rust"]);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("writeTrajectoryRecord: appends to an existing file without clobbering", async () => {
 const cwd = await tmpCwd();
 try {
 const rec = sink.buildTrajectoryRecord({
 audit: BASE_AUDIT,
 slice: BASE_SLICE,
 activeFiles: [],
 chosenCompletion: "A",
 rejectedCompletion: "R",
 workerModel: "w",
 verifierModel: "v",
 triggerReason: "compiler_streak",
 divergenceEntryId: null,
 domainTags: ["rust"],
 ctx: { cwd, sessionManager: { getSessionId: () => "s" } },
 });
 sink.writeTrajectoryRecord(rec, cwd);
 sink.writeTrajectoryRecord({ ...rec, chosen_completion: "B", trigger_reason: "manual" }, cwd);
 const filePath = join(cwd, ".pi", "harvest", "trajectories.jsonl");
 const lines = (await readFile(filePath, "utf8")).trim().split("\n");
 assert.equal(lines.length, 2);
 assert.equal((JSON.parse(lines[0]) as HarvestedTrajectoryRecord).chosen_completion, "A");
 assert.equal((JSON.parse(lines[1]) as HarvestedTrajectoryRecord).chosen_completion, "B");
 assert.equal((JSON.parse(lines[1]) as HarvestedTrajectoryRecord).trigger_reason, "manual");
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("countHarvestedRecords: returns 0 for missing file", async () => {
 const cwd = await tmpCwd();
 try {
 assert.equal(sink.countHarvestedRecords(cwd), 0);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("countHarvestedRecords: counts lines correctly", async () => {
 const cwd = await tmpCwd();
 try {
 const filePath = join(cwd, ".pi", "harvest", "trajectories.jsonl");
 const { mkdirSync } = await import("node:fs");
 mkdirSync(join(cwd, ".pi", "harvest"), { recursive: true });
 await writeFile(filePath, '{"a":1}\n{"a":2}\n{"a":3}\n', "utf8");
 assert.equal(sink.countHarvestedRecords(cwd), 3);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("getSinkStats: returns path, count, size", async () => {
 const cwd = await tmpCwd();
 try {
 const { mkdirSync } = await import("node:fs");
 mkdirSync(join(cwd, ".pi", "harvest"), { recursive: true });
 await writeFile(join(cwd, ".pi", "harvest", "trajectories.jsonl"), '{"a":1}\n', "utf8");
 const stats = sink.getSinkStats(cwd);
 assert.equal(stats.recordCount, 1);
 assert.equal(stats.sizeBytes, 8);
 assert.match(stats.path, /trajectories\.jsonl$/);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("writeDpoEntry (Phase 2 compat): still works with the legacy signature", async () => {
 const cwd = await tmpCwd();
 try {
 process.env.VERIFIER_MODEL = "compat-model";
 const result = sink.writeDpoEntry({
 audit: BASE_AUDIT,
 slice: BASE_SLICE,
 chosenCompletion: "C",
 rejectedCompletion: "R",
 ctx: { cwd, sessionManager: { getSessionId: () => "legacy" } },
 activeFiles: [{ path: "src/main.rs", content: "fn main(){}", truncated: false } as ActiveFile],
 triggerReason: "manual",
 divergenceEntryId: "a1",
 });
 const filePath = join(cwd, ".pi", "harvest", "trajectories.jsonl");
 const lines = (await readFile(filePath, "utf8")).trim().split("\n");
 const parsed = JSON.parse(lines[0]) as HarvestedTrajectoryRecord;
 assert.equal(parsed.session_id, "legacy");
 assert.equal(parsed.trigger_reason, "manual");
 assert.equal(parsed.k3_audit.divergence_entry_id, "a1");
 assert.equal(parsed.active_files.length, 1);
 assert.equal(result.bytes > 0, true);
 delete process.env.VERIFIER_MODEL;
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});
