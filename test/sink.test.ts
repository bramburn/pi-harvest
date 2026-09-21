/**
 * Unit tests for the DPO/SFT sink (Phase 3 schema).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
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
 gitDiffSummary: null,
 ctx: { cwd, sessionManager: { getSessionId: () => "s" } },
 });
 const result = sink.writeTrajectoryRecord(rec, cwd);
 assert.equal(result.bytes > 0, true);
 const filePath = sink.currentSinkPath(cwd);
 const lines = (await readFile(filePath, "utf8")).trim().split("\n");
 assert.equal(lines.length, 1);
 const parsed = JSON.parse(lines[0]) as HarvestedTrajectoryRecord;
 assert.equal(parsed.session_id, "s");
 assert.equal(parsed.trigger_reason, "manual");
 assert.deepEqual(parsed.domain_tags, ["rust"]);
 assert.equal(parsed.git_diff_summary, null);
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
 gitDiffSummary: null,
 ctx: { cwd, sessionManager: { getSessionId: () => "s" } },
 });
 sink.writeTrajectoryRecord(rec, cwd);
 sink.writeTrajectoryRecord({ ...rec, chosen_completion: "B", trigger_reason: "manual" }, cwd);
 const filePath = sink.currentSinkPath(cwd);
 const lines = (await readFile(filePath, "utf8")).trim().split("\n");
 assert.equal(lines.length, 2);
 assert.equal((JSON.parse(lines[0]) as HarvestedTrajectoryRecord).chosen_completion, "A");
 assert.equal((JSON.parse(lines[1]) as HarvestedTrajectoryRecord).chosen_completion, "B");
 assert.equal((JSON.parse(lines[1]) as HarvestedTrajectoryRecord).trigger_reason, "manual");
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("countHarvestedRecords: returns 0 for missing file", () => {
 const cwd = join(tmpdir(), "pi-harvest-missing-" + Date.now());
 assert.equal(sink.countHarvestedRecords(cwd), 0);
});

test("countHarvestedRecords: counts lines on the current month's file", () => {
 const cwd = join(tmpdir(), "pi-harvest-count-" + Date.now());
 const filePath = sink.currentSinkPath(cwd);
 mkdirSync(join(cwd, ".pi", "harvest"), { recursive: true });
 writeFileSync(filePath, '{"a":1}\n{"a":2}\n{"a":3}\n', "utf8");
 assert.equal(sink.countHarvestedRecords(cwd), 3);
 rmSync(cwd, { recursive: true, force: true });
});

test("getSinkStats: returns path, count, size for the current month", async () => {
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
 triggerReason: "compiler_streak",
 divergenceEntryId: null,
 domainTags: [],
 gitDiffSummary: null,
 ctx: { cwd, sessionManager: { getSessionId: () => "s" } },
 });
 sink.writeTrajectoryRecord(rec, cwd);
 const stats = await sink.getSinkStats(cwd);
 assert.equal(stats.recordCount, 1);
 assert.ok(stats.sizeBytes > 0);
 assert.match(stats.path, /trajectories_\d{4}_\d{2}\.jsonl$/);
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
 const filePath = sink.currentSinkPath(cwd);
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

// ---------------------------------------------------------------------------
// Phase 4: log rotation + streaming
// ---------------------------------------------------------------------------

test("currentSinkFilename: format is trajectories_YYYY_MM.jsonl", () => {
 const fixed = new Date(Date.UTC(2026, 8, 21));
 assert.equal(sink.currentSinkFilename(fixed), "trajectories_2026_09.jsonl");
 const fixed2 = new Date(Date.UTC(2026, 11, 31));
 assert.equal(sink.currentSinkFilename(fixed2), "trajectories_2026_12.jsonl");
 const fixed3 = new Date(Date.UTC(2027, 0, 1));
 assert.equal(sink.currentSinkFilename(fixed3), "trajectories_2027_01.jsonl");
});

test("currentSinkPath: full path under .pi/harvest/", () => {
 const p = sink.currentSinkPath("/tmp/proj", new Date(Date.UTC(2026, 8, 21)));
 assert.match(p, /[\\/]\.pi[\\/]harvest[\\/]trajectories_2026_09\.jsonl$/);
});

test("writeTrajectoryRecord: routes to date-stamped file, not trajectories.jsonl", async () => {
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
 triggerReason: "compiler_streak",
 divergenceEntryId: null,
 domainTags: ["rust"],
 gitDiffSummary: null,
 ctx: { cwd, sessionManager: { getSessionId: () => "s" } },
 });
 const result = sink.writeTrajectoryRecord(rec, cwd);
 assert.match(result.path, /trajectories_\d{4}_\d{2}\.jsonl$/);
 // Should NOT have written to the v0.3 unrotated file
 const oldPath = join(cwd, ".pi", "harvest", "trajectories.jsonl");
 const { existsSync } = await import("node:fs");
 assert.equal(existsSync(oldPath), false);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("writeTrajectoryRecord: rolls to a new file when the month changes", async () => {
 const cwd = await tmpCwd();
 try {
 const rec = (month: string) => ({
 ...sink.buildTrajectoryRecord({
 audit: BASE_AUDIT,
 slice: BASE_SLICE,
 activeFiles: [],
 chosenCompletion: "C",
 rejectedCompletion: "R",
 workerModel: "w",
 verifierModel: "v",
 triggerReason: "compiler_streak" as const,
 divergenceEntryId: null,
 domainTags: ["rust"],
 gitDiffSummary: null,
 ctx: { cwd, sessionManager: { getSessionId: () => "s" } },
 }),
 });
 const sep = sink.writeTrajectoryRecord(rec("sep"), cwd, new Date(Date.UTC(2026, 8, 21)));
 const oct = sink.writeTrajectoryRecord(rec("oct"), cwd, new Date(Date.UTC(2026, 9, 1)));
 assert.match(sep.path, /trajectories_2026_09\.jsonl$/);
 assert.match(oct.path, /trajectories_2026_10\.jsonl$/);
 assert.notEqual(sep.path, oct.path);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("writeTrajectoryRecord: appends across calls in the same month", async () => {
 const cwd = await tmpCwd();
 try {
 const base = sink.buildTrajectoryRecord({
 audit: BASE_AUDIT,
 slice: BASE_SLICE,
 activeFiles: [],
 chosenCompletion: "C",
 rejectedCompletion: "R",
 workerModel: "w",
 verifierModel: "v",
 triggerReason: "compiler_streak",
 divergenceEntryId: null,
 domainTags: ["rust"],
 gitDiffSummary: null,
 ctx: { cwd, sessionManager: { getSessionId: () => "s" } },
 });
 const t = new Date(Date.UTC(2026, 8, 21));
 sink.writeTrajectoryRecord(base, cwd, t);
 sink.writeTrajectoryRecord({ ...base, chosen_completion: "C2" }, cwd, t);
 const lines = (await readFile(sink.currentSinkPath(cwd, t), "utf8")).trim().split("\n");
 assert.equal(lines.length, 2);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("listSinkFiles: returns date-stamped files plus the legacy unrotated file", async () => {
 const cwd = await tmpCwd();
 try {
 const harvestDir = join(cwd, ".pi", "harvest");
 await mkdir(harvestDir, { recursive: true });
 await writeFile(join(harvestDir, "trajectories.jsonl"), "{}\n", "utf8");
 await writeFile(join(harvestDir, "trajectories_2026_09.jsonl"), "{}\n", "utf8");
 await writeFile(join(harvestDir, "trajectories_2026_08.jsonl"), "{}\n", "utf8");
 await writeFile(join(harvestDir, "not_a_sink.txt"), "ignore", "utf8");
 const files = sink.listSinkFiles(cwd);
 assert.equal(files.length, 3);
 assert.ok(files[0].endsWith("trajectories.jsonl")); // legacy first
 assert.ok(files[1].endsWith("trajectories_2026_08.jsonl"));
 assert.ok(files[2].endsWith("trajectories_2026_09.jsonl"));
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("getSinkStats: counts records on the active month file", async () => {
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
 triggerReason: "compiler_streak",
 divergenceEntryId: null,
 domainTags: [],
 gitDiffSummary: null,
 ctx: { cwd, sessionManager: { getSessionId: () => "s" } },
 });
 const t = new Date(Date.UTC(2026, 8, 21));
 sink.writeTrajectoryRecord(rec, cwd, t);
 sink.writeTrajectoryRecord({ ...rec, chosen_completion: "C2" }, cwd, t);
 const stats = await sink.getSinkStats(cwd, t);
 assert.equal(stats.recordCount, 2);
 assert.ok(stats.sizeBytes > 0);
 assert.match(stats.path, /trajectories_2026_09\.jsonl$/);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("buildTrajectoryRecord: carries git_diff_summary through to the record", () => {
 const rec = sink.buildTrajectoryRecord({
 audit: BASE_AUDIT,
 slice: BASE_SLICE,
 activeFiles: [],
 chosenCompletion: "C",
 rejectedCompletion: "R",
 workerModel: "w",
 verifierModel: "v",
 triggerReason: "compiler_streak",
 divergenceEntryId: null,
 domainTags: [],
 gitDiffSummary: "diff --git a/x.rs",
 ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "s" } },
 });
 assert.equal(rec.git_diff_summary, "diff --git a/x.rs");
});

test("buildTrajectoryRecord: tolerates null git_diff_summary", () => {
 const rec = sink.buildTrajectoryRecord({
 audit: BASE_AUDIT,
 slice: BASE_SLICE,
 activeFiles: [],
 chosenCompletion: "C",
 rejectedCompletion: "R",
 workerModel: "w",
 verifierModel: "v",
 triggerReason: "compiler_streak",
 divergenceEntryId: null,
 domainTags: [],
 gitDiffSummary: null,
 ctx: { cwd: "/tmp", sessionManager: { getSessionId: () => "s" } },
 });
 assert.equal(rec.git_diff_summary, null);
});

// ---------------------------------------------------------------------------
// Phase 7: SFT Golden sink
// ---------------------------------------------------------------------------

import type { GoldenSFTRecord } from "../dist/types.js";

const BASE_SFT: GoldenSFTRecord = {
 session_id: "sess-sft-1",
 timestamp: "2026-09-21T12:00:00.000Z",
 worker_model: "minimax:MiniMax-M3",
 domain_tags: ["rust", "tauri"],
 immediate_prompt: "build a hello world",
 active_files: [{ path: "src/main.rs", content: "fn main() {}" }],
 git_diff_summary: null,
 chosen_completion: "fn main() { println!(\"hi\"); }",
};

test("currentSftSinkFilename: format is sft_golden_YYYY_MM.jsonl", () => {
 const fixed = new Date(Date.UTC(2026, 8, 21));
 assert.equal(sink.currentSftSinkFilename(fixed), "sft_golden_2026_09.jsonl");
 const fixed2 = new Date(Date.UTC(2026, 11, 1));
 assert.equal(sink.currentSftSinkFilename(fixed2), "sft_golden_2026_12.jsonl");
 const fixed3 = new Date(Date.UTC(2027, 0, 5));
 assert.equal(sink.currentSftSinkFilename(fixed3), "sft_golden_2027_01.jsonl");
});

test("currentSftSinkPath: full path under .pi/harvest/", () => {
 const p = sink.currentSftSinkPath("/tmp/proj", new Date(Date.UTC(2026, 8, 21)));
 assert.match(p, /[\\/]\.pi[\\/]harvest[\\/]sft_golden_2026_09\.jsonl$/);
});

test("appendGoldenSFT: creates .pi/harvest and writes one JSON line", async () => {
 const cwd = await tmpCwd();
 try {
 const result = sink.appendGoldenSFT(cwd, BASE_SFT);
 assert.equal(result.bytes > 0, true);
 assert.match(result.path, /sft_golden_\d{4}_\d{2}\.jsonl$/);
 const lines = (await readFile(result.path, "utf8")).trim().split("\n");
 assert.equal(lines.length, 1);
 const parsed = JSON.parse(lines[0]) as GoldenSFTRecord;
 assert.equal(parsed.session_id, "sess-sft-1");
 assert.equal(parsed.chosen_completion, BASE_SFT.chosen_completion);
 assert.equal(parsed.domain_tags.length, 2);
 assert.equal(parsed.active_files.length, 1);
 assert.equal(parsed.git_diff_summary, null);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("appendGoldenSFT: appends across calls in the same month", async () => {
 const cwd = await tmpCwd();
 try {
 const t = new Date(Date.UTC(2026, 8, 21));
 sink.appendGoldenSFT(cwd, BASE_SFT, t);
 sink.appendGoldenSFT(cwd, { ...BASE_SFT, session_id: "s2", chosen_completion: "fn main() { println!(\"hi2\"); }" }, t);
 const lines = (await readFile(sink.currentSftSinkPath(cwd, t), "utf8")).trim().split("\n");
 assert.equal(lines.length, 2);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("appendGoldenSFT: rolls to a new file when month changes", async () => {
 const cwd = await tmpCwd();
 try {
 const sep = sink.appendGoldenSFT(cwd, BASE_SFT, new Date(Date.UTC(2026, 8, 21)));
 const oct = sink.appendGoldenSFT(cwd, { ...BASE_SFT, session_id: "oct" }, new Date(Date.UTC(2026, 9, 1)));
 assert.match(sep.path, /sft_golden_2026_09\.jsonl$/);
 assert.match(oct.path, /sft_golden_2026_10\.jsonl$/);
 assert.notEqual(sep.path, oct.path);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("countSftRecords: counts lines in the current month's sink", async () => {
 const cwd = await tmpCwd();
 try {
 const t = new Date(Date.UTC(2026, 8, 21));
 sink.appendGoldenSFT(cwd, BASE_SFT, t);
 sink.appendGoldenSFT(cwd, BASE_SFT, t);
 sink.appendGoldenSFT(cwd, BASE_SFT, t);
 assert.equal(sink.countSftRecords(cwd, t), 3);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("countSftRecords: returns 0 when sink file is missing", () => {
 const cwd = join(tmpdir(), "pi-harvest-missing-sft-" + Date.now());
 assert.equal(sink.countSftRecords(cwd), 0);
});

test("listSftFiles: discovers sft_golden files and ignores other files", async () => {
 const cwd = await tmpCwd();
 try {
 const harvestDir = join(cwd, ".pi", "harvest");
 await mkdir(harvestDir, { recursive: true });
 await writeFile(join(harvestDir, "sft_golden_2026_08.jsonl"), "{}\n", "utf8");
 await writeFile(join(harvestDir, "sft_golden_2026_09.jsonl"), "{}\n", "utf8");
 await writeFile(join(harvestDir, "trajectories_2026_09.jsonl"), "{}\n", "utf8");
 await writeFile(join(harvestDir, "readme.txt"), "ignore", "utf8");
 const files = sink.listSftFiles(cwd);
 assert.equal(files.length, 2);
 assert.ok(files[0].endsWith("sft_golden_2026_08.jsonl"));
 assert.ok(files[1].endsWith("sft_golden_2026_09.jsonl"));
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("listSftFiles: returns empty array when .pi/harvest is missing", () => {
 const cwd = join(tmpdir(), "pi-harvest-no-harvest-" + Date.now());
 assert.deepEqual(sink.listSftFiles(cwd), []);
});
