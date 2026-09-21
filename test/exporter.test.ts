/**
 * Unit tests for the HF DPO exporter.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as exporter from "../dist/exporter.js";
import * as sink from "../dist/sink.js";

async function tmpCwd() {
 return await mkdtemp(join(tmpdir(), "pi-harvest-exporter-"));
}

test("mapRecordToHfDpo: maps a complete record into HF conversational format", () => {
 const record = {
 session_id: "s1",
 timestamp: "2026-01-01T00:00:00.000Z",
 worker_model: "minimax:MiniMax-M3",
 verifier_model: "kimi-k2",
 trigger_reason: "compiler_streak",
 domain_tags: ["rust"],
 immediate_prompt: "build hello world",
 active_files: [
 { path: "src/main.rs", content: "fn main() {}", truncated: false },
 { path: "ignored.bin", content: "", truncated: false, skipped: "binary" },
 ],
 compiler_error_summary: "error[E0425]: x not found",
 git_diff_summary: "diff --git a/src/main.rs",
 k3_audit: {
 divergence_entry_id: "t1",
 flaw_category: "logic_error",
 root_cause: "missing import",
 steering_instructions: "fix import",
 },
 rejected_completion: "broken code",
 chosen_completion: "fixed code",
 };
 const out = exporter.mapRecordToHfDpo(record);
 assert.equal(out.flaw_category, "logic_error");
 assert.equal(out.chosen[0].content, "fixed code");
 assert.equal(out.rejected[0].content, "broken code");
 assert.equal(out.prompt[0].role, "user");
 assert.match(out.prompt[0].content, /build hello world/);
 assert.match(out.prompt[0].content, /GIT DIFF/);
 assert.match(out.prompt[0].content, /src\/main\.rs/);
 assert.match(out.prompt[0].content, /fn main/);
 // Skipped file should be marked but not crash
 assert.match(out.prompt[0].content, /ignored\.bin/);
 assert.match(out.prompt[0].content, /skipped: binary/);
});

test("mapRecordToHfDpo: tolerates missing fields", () => {
 const out = exporter.mapRecordToHfDpo({});
 assert.equal(out.flaw_category, "unknown");
 assert.equal(out.chosen[0].content, "");
 assert.equal(out.rejected[0].content, "");
 assert.match(out.prompt[0].content, /\(no immediate prompt captured\)/);
 assert.match(out.prompt[0].content, /\(no git diff captured\)/);
});

test("mapRecordToHfDpo: marks empty git diff explicitly", () => {
 const out = exporter.mapRecordToHfDpo({ git_diff_summary: "", immediate_prompt: "x" });
 assert.match(out.prompt[0].content, /\(no git diff captured\)/);
});

test("exportFilename: format YYYY_MM_DD", () => {
 const fixed = new Date(Date.UTC(2026, 8, 21)); // Sep 21 2026
 assert.equal(exporter.exportFilename(fixed), "dpo_dataset_2026_09_21.jsonl");
});

test("exportToHuggingFaceDPO: streams every record into a single export file", async () => {
 const cwd = await tmpCwd();
 try {
 const dir = join(cwd, ".pi", "harvest");
 await mkdir(dir, { recursive: true });

 // Write three records to the current month's sink (uses real date).
 const records = [
 {
 session_id: "s1",
 timestamp: "2026-09-21T10:00:00.000Z",
 worker_model: "minimax:MiniMax-M3",
 verifier_model: "kimi-k2",
 trigger_reason: "compiler_streak",
 domain_tags: ["rust"],
 immediate_prompt: "build 1",
 active_files: [],
 compiler_error_summary: "err1",
 git_diff_summary: "diff1",
 k3_audit: { divergence_entry_id: "t1", flaw_category: "logic_error", root_cause: "r1", steering_instructions: "s1" },
 rejected_completion: "R1",
 chosen_completion: "C1",
 },
 {
 session_id: "s2",
 timestamp: "2026-09-21T11:00:00.000Z",
 worker_model: "minimax:MiniMax-M3",
 verifier_model: "kimi-k2",
 trigger_reason: "periodic_turn",
 domain_tags: ["typescript"],
 immediate_prompt: "build 2",
 active_files: [],
 compiler_error_summary: "err2",
 git_diff_summary: null,
 k3_audit: { divergence_entry_id: null, flaw_category: "logic_error", root_cause: "r2", steering_instructions: "s2" },
 rejected_completion: "R2",
 chosen_completion: "C2",
 },
 {
 session_id: "s3",
 timestamp: "2026-09-21T12:00:00.000Z",
 worker_model: "minimax:MiniMax-M3",
 verifier_model: "kimi-k2",
 trigger_reason: "manual",
 domain_tags: ["csharp"],
 immediate_prompt: "build 3",
 active_files: [],
 compiler_error_summary: "err3",
 git_diff_summary: "diff3",
 k3_audit: { divergence_entry_id: "t3", flaw_category: "missed_spec", root_cause: "r3", steering_instructions: "s3" },
 rejected_completion: "R3",
 chosen_completion: "C3",
 },
 ];

 const sinkPath = sink.currentSinkPath(cwd);
 for (const r of records) {
 await writeFile(sinkPath, JSON.stringify(r) + "\n", { encoding: "utf8", flag: "a" });
 }

 const result = await exporter.exportToHuggingFaceDPO({ cwd });
 assert.equal(result.count, 3);
 assert.ok(result.bytes > 0);

 const outPath = join(cwd, ".pi", "harvest", "exports", exporter.exportFilename(new Date()));
 const lines = (await readFile(outPath, "utf8")).trim().split("\n");
 assert.equal(lines.length, 3);

 const parsed0 = JSON.parse(lines[0]);
 assert.equal(parsed0.chosen[0].content, "C1");
 assert.equal(parsed0.flaw_category, "logic_error");
 assert.match(parsed0.prompt[0].content, /build 1/);

 // Ensure chosen+rejected+prompt shape is correct
 for (const line of lines) {
 const parsed = JSON.parse(line);
 assert.equal(parsed.prompt.length, 1);
 assert.equal(parsed.chosen.length, 1);
 assert.equal(parsed.rejected.length, 1);
 assert.equal(parsed.prompt[0].role, "user");
 assert.equal(parsed.chosen[0].role, "assistant");
 assert.equal(parsed.rejected[0].role, "assistant");
 }
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("exportToHuggingFaceDPO: handles empty sink gracefully", async () => {
 const cwd = await tmpCwd();
 try {
 const result = await exporter.exportToHuggingFaceDPO({ cwd });
 assert.equal(result.count, 0);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("exportToHuggingFaceDPO: writes to exports/ subdirectory", async () => {
 const cwd = await tmpCwd();
 try {
 const result = await exporter.exportToHuggingFaceDPO({ cwd });
 assert.match(result.path, /[\\/]\.pi[\\/]harvest[\\/]exports[\\/]/);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});
