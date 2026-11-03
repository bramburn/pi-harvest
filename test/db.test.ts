/**
 * Unit tests for the SQLite mirror (node:sqlite, zero dependencies).
 *
 * Skips itself when the running Node lacks `node:sqlite` (< 22.13) so the
 * suite still passes on older runtimes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as db from "../dist/db.js";

const available = db.isSqliteAvailable();
const skip = available ? false : "node:sqlite unavailable on this runtime";

async function freshRoot(): Promise<string> {
 const dir = await mkdtemp(join(tmpdir(), "pi-harvest-db-"));
 process.env.PI_HARVEST_ROOT = join(dir, ".pi", "harvest");
 return dir;
}

function sftRecord(overrides: Record<string, unknown> = {}) {
 return {
 session_id: "sess-1",
 timestamp: "2026-01-01T00:00:00.000Z",
 worker_model: "minimax:MiniMax-M3",
 domain_tags: ["rust", "tauri"],
 immediate_prompt: "add a greet command",
 active_files: [{ path: "src/main.rs", content: "fn main() {}", truncated: false }],
 git_diff_summary: "diff --git a/src/main.rs",
 chosen_completion: "fn main() { println!(\"hi\"); }",
 ...overrides,
 } as any;
}

function dpoRecord(overrides: Record<string, unknown> = {}) {
 return {
 session_id: "sess-1",
 timestamp: "2026-01-02T00:00:00.000Z",
 worker_model: "minimax:MiniMax-M3",
 verifier_model: "deepseek-chat",
 trigger_reason: "compiler_streak",
 domain_tags: ["rust"],
 immediate_prompt: "fix the borrow error",
 active_files: [{ path: "src/main.rs", content: "fn main() {}", truncated: false }],
 compiler_error_summary: "error[E0502]",
 git_diff_summary: null,
 k3_audit: { flaw_category: "logic_error", root_cause: "borrow", divergence_entry_id: "t2" },
 rejected_completion: "fn broken() {}",
 chosen_completion: "fn fixed() {}",
 human_feedback: null,
 ...overrides,
 } as any;
}

// ---------------------------------------------------------------------------
// schema + inserts
// ---------------------------------------------------------------------------

test("initDatabase: creates harvest.db with both tables", { skip }, async () => {
 const dir = await freshRoot();
 try {
 db.initDatabase();
 const info = await stat(db.getDbPath());
 assert.ok(info.size > 0);
 const stats = db.getDbStats();
 assert.equal(stats.available, true);
 assert.equal(stats.sftCount, 0);
 assert.equal(stats.dpoCount, 0);
 } finally {
 db.closeDatabase();
 await rm(dir, { recursive: true, force: true });
 }
});

test("insertSftRecord: inserts once and dedupes by record hash", { skip }, async () => {
 const dir = await freshRoot();
 try {
 assert.equal(db.insertSftRecord(sftRecord()), true);
 assert.equal(db.insertSftRecord(sftRecord(), "migrated_jsonl"), false);
 const stats = db.getDbStats();
 assert.equal(stats.sftCount, 1);
 } finally {
 db.closeDatabase();
 await rm(dir, { recursive: true, force: true });
 }
});

test("insertDpoRecord: stores the DPO row and promotes chosen → SFT", { skip }, async () => {
 const dir = await freshRoot();
 try {
 assert.equal(db.insertDpoRecord(dpoRecord()), true);
 const stats = db.getDbStats();
 assert.equal(stats.dpoCount, 1);
 assert.equal(stats.sftCount, 1, "chosen completion should be promoted into sft_records");

 const sft = db.readSftRows();
 assert.equal(sft.length, 1);
 const messages = JSON.parse(sft[0].messages_json) as Array<{ role: string; content: string }>;
 assert.equal(messages.length, 2);
 assert.equal(messages[0].role, "user");
 assert.equal(messages[1].role, "assistant");
 assert.equal(messages[1].content, "fn fixed() {}");

 const dpo = db.readDpoRows();
 assert.equal(dpo.length, 1);
 assert.equal(dpo[0].trigger_reason, "compiler_streak");
 assert.equal(JSON.parse(dpo[0].k3_audit_json).flaw_category, "logic_error");
 assert.deepEqual(JSON.parse(dpo[0].active_files_json)[0].path, "src/main.rs");
 } finally {
 db.closeDatabase();
 await rm(dir, { recursive: true, force: true });
 }
});

test("insertDpoRecord: empty chosen completion does not create an SFT row", { skip }, async () => {
 const dir = await freshRoot();
 try {
 assert.equal(db.insertDpoRecord(dpoRecord({ chosen_completion: "  " })), true);
 const stats = db.getDbStats();
 assert.equal(stats.dpoCount, 1);
 assert.equal(stats.sftCount, 0);
 } finally {
 db.closeDatabase();
 await rm(dir, { recursive: true, force: true });
 }
});

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------

test("migrateJsonlToSqlite: imports both sinks idempotently", { skip }, async () => {
 const dir = await freshRoot();
 try {
 const root = join(dir, ".pi", "harvest");
 await mkdir(root, { recursive: true });
 const sftFile = join(root, "sft_golden_2026_01.jsonl");
 const dpoFile = join(root, "trajectories_2026_01.jsonl");
 await writeFile(sftFile, JSON.stringify(sftRecord()) + "\n", "utf8");
 await writeFile(
 dpoFile,
 JSON.stringify(dpoRecord()) + "\n" + "not-json\n" + JSON.stringify(dpoRecord({ timestamp: "2026-01-03T00:00:00.000Z" })) + "\n",
 "utf8",
 );

 const first = db.migrateJsonlToSqlite({ sftFiles: [sftFile], dpoFiles: [dpoFile] });
 assert.equal(first.sftImported, 1);
 assert.equal(first.dpoImported, 2);
 assert.equal(first.dpoScanned, 3);

 const second = db.migrateJsonlToSqlite({ sftFiles: [sftFile], dpoFiles: [dpoFile] });
 assert.equal(second.sftImported, 0);
 assert.equal(second.dpoImported, 0);

 const stats = db.getDbStats();
 assert.equal(stats.dpoCount, 2);
 // 1 live SFT + 2 promoted from the DPO rows.
 assert.equal(stats.sftCount, 3);
 } finally {
 db.closeDatabase();
 await rm(dir, { recursive: true, force: true });
 }
});

test("migrateJsonlToSqlite: scans the harvest root when no files are given", { skip }, async () => {
 const dir = await freshRoot();
 try {
 const root = join(dir, ".pi", "harvest");
 await mkdir(root, { recursive: true });
 await writeFile(join(root, "sft_golden_2026_02.jsonl"), JSON.stringify(sftRecord({ timestamp: "2026-02-01T00:00:00.000Z" })) + "\n", "utf8");
 const result = db.migrateJsonlToSqlite();
 assert.equal(result.sftImported, 1);
 } finally {
 db.closeDatabase();
 await rm(dir, { recursive: true, force: true });
 }
});

test("getDbStats: reports unavailable instead of throwing when the path is unwritable", { skip }, async () => {
 const dir = await freshRoot();
 try {
 const root = join(dir, ".pi", "harvest");
 await mkdir(root, { recursive: true });
 // A directory where the DB file should be forces DatabaseSync to fail.
 await mkdir(join(root, "harvest.db"), { recursive: true });
 const stats = db.getDbStats();
 assert.equal(stats.available, false);
 assert.ok(typeof stats.error === "string" && stats.error.length > 0);
 } finally {
 db.closeDatabase();
 await rm(dir, { recursive: true, force: true });
 }
});

// ---------------------------------------------------------------------------
// hashes
// ---------------------------------------------------------------------------

test("record hashes: deterministic, field-sensitive and stable across calls", () => {
 const a = db.computeDpoRecordHash(dpoRecord());
 const b = db.computeDpoRecordHash(dpoRecord());
 assert.equal(a, b);
 assert.notEqual(a, db.computeDpoRecordHash(dpoRecord({ chosen_completion: "different" })));

 const s1 = db.computeSftRecordHash(sftRecord());
 assert.equal(s1, db.computeSftRecordHash(sftRecord()));
 assert.notEqual(s1, db.computeSftRecordHash(sftRecord({ immediate_prompt: "different" })));
});

test("buildSftMessagesJson: mirrors the HF SFT shape", () => {
 const json = db.buildSftMessagesJson(sftRecord());
 const parsed = JSON.parse(json) as Array<{ role: string; content: string }>;
 assert.equal(parsed.length, 2);
 assert.match(parsed[0].content, /add a greet command/);
 assert.match(parsed[0].content, /GIT DIFF/);
 assert.match(parsed[0].content, /src\/main\.rs/);
 assert.equal(parsed[1].content, 'fn main() { println!("hi"); }');
});

test("db file is written under PI_HARVEST_ROOT", { skip }, async () => {
 const dir = await freshRoot();
 try {
 db.initDatabase();
 await readFile(db.getDbPath());
 assert.ok(db.getDbPath().startsWith(process.env.PI_HARVEST_ROOT as string));
 } finally {
 db.closeDatabase();
 await rm(dir, { recursive: true, force: true });
 }
});