/**
 * Local SQLite sink (dual-write alongside JSONL).
 *
 * Why SQLite when AGENTS.md used to forbid it: JSONL is perfect for
 * append-only capture, but terrible for "give me every rust record from
 * last month with flaw_category = logic_error". Downstream SFT/DPO
 * pipelines (LangGraph, Unsloth, trl) want a queryable store, and Node
 * >= 22.13 ships `node:sqlite` natively — zero npm dependencies, zero
 * node-gyp, zero compiled artifacts.
 *
 * Design constraints:
 * - **Dual write.** `src/sink.ts` keeps appending JSONL (all existing
 *   tests and human inspection rely on it) and additionally mirrors each
 *   record here inside a try/catch. A locked/corrupt/absent SQLite
 *   driver must never break trajectory capture.
 * - **Idempotent.** Every row carries a deterministic `record_hash`
 *   (SHA-256 over the fields that define the training pair) and inserts
 *   use `INSERT OR IGNORE`, so re-importing the same JSONL file or
 *   replaying a migration never duplicates rows.
 * - **SFT promotion.** When a DPO episode is stored, its resolved
 *   `chosen_completion` is also written to `sft_records` (source
 *   `dpo_<trigger>`). Supervisor-corrected code is the highest-value SFT
 *   signal we have; there is no reason to hide it in the DPO table only.
 * - **WAL + busy_timeout.** Parent sessions and `@tintinweb/pi-subagents`
 *   children all append to the same DB. WAL lets readers proceed during
 *   writes and the busy timeout absorbs short lock contention.
 *
 * The driver is loaded lazily via `require("node:sqlite")` so:
 * 1. importing `./db.js` on an older Node does not throw, and
 * 2. the ExperimentalWarning for node:sqlite only appears once a record
 *    is actually written.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ensureHarvestRoot } from "./paths.js";
import type { GoldenSFTRecord, HarvestedTrajectoryRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Minimal structural types for node:sqlite (avoids depending on a specific
// @types/node version exposing `node:sqlite`).
// ---------------------------------------------------------------------------

interface SqliteStatement {
 run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
 get(...params: unknown[]): unknown;
 all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
 exec(sql: string): void;
 prepare(sql: string): SqliteStatement;
 close(): void;
}

interface SqliteModule {
 DatabaseSync: new (path: string) => SqliteDatabase;
}

let sqliteModule: SqliteModule | null | undefined;
let sqliteUnavailableReason: string | null = null;

function loadSqlite(): SqliteModule | null {
 if (sqliteModule !== undefined) return sqliteModule;
 try {
 // `require` exists in the CommonJS build and in pi's extension host
 // (see src/sink.ts, which already uses it for node:fs).
 const req = typeof require === "function" ? require : null;
 if (!req) throw new Error("require() is unavailable in this runtime");
 // node:sqlite still emits an ExperimentalWarning on Node 22/24. It is
 // harmless, but a stray warning line in the middle of the pi TUI looks
 // like an extension bug, so filter just this one while loading.
 const originalEmitWarning = process.emitWarning;
 try {
 process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
 const text = typeof warning === "string" ? warning : warning?.message;
 if (typeof text === "string" && /SQLite is an experimental feature/i.test(text)) return;
 return (originalEmitWarning as (...a: unknown[]) => void).apply(process, [warning, ...rest]);
 }) as typeof process.emitWarning;
 sqliteModule = req("node:sqlite") as SqliteModule;
 } finally {
 process.emitWarning = originalEmitWarning;
 }
 } catch (err) {
 sqliteModule = null;
 sqliteUnavailableReason = (err as Error)?.message ?? String(err);
 }
 return sqliteModule;
}

/** True when `node:sqlite` could be loaded (Node >= 22.13 normally). */
export function isSqliteAvailable(): boolean {
 return loadSqlite() !== null;
}

/** Human-readable reason the driver is unavailable (null when it loaded). */
export function sqliteUnavailableError(): string | null {
 loadSqlite();
 return sqliteUnavailableReason;
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

export function getDbPath(): string {
 return join(ensureHarvestRoot(), "harvest.db");
}

/**
 * Open the DB for a single operation.
 *
 * The handle is intentionally NOT cached. pi-harvest is a low-frequency
 * writer (one insert per audit), and holding a handle open causes real
 * problems on Windows: `rm -rf` of a harvest root, test cleanup, and
 * `git clean` all fail with EBUSY while a connection (or its WAL sidecar)
 * is live. Open/close costs ~1ms, which is noise next to an LLM call.
 */
function withDb<T>(fn: (db: SqliteDatabase) => T): T {
 const targetPath = getDbPath();
 const mod = loadSqlite();
 if (!mod) {
 throw new Error(
 "node:sqlite is unavailable (" + (sqliteUnavailableReason ?? "unknown reason") + "); " +
 "SQLite mirroring is disabled. Node >= 22.13 is required.",
 );
 }
 const db = new mod.DatabaseSync(targetPath);
 try {
 initSchema(db);
 return fn(db);
 } finally {
 try {
 db.close();
 } catch {
 // ignore
 }
 }
}

/** Compatibility shim: connections are per-operation, so nothing to close. */
export function closeDatabase(): void {
 // Intentionally a no-op; see withDb(). Kept for API stability and for
 // tests/callers that want to be explicit about releasing the DB.
}

function initSchema(db: SqliteDatabase): void {
 try {
 db.exec("PRAGMA journal_mode = WAL;");
 } catch {
 // WAL is an optimization; a read-only or contended DB still works.
 }
 try {
 db.exec("PRAGMA synchronous = NORMAL;");
 } catch {
 // ignore
 }
 try {
 db.exec("PRAGMA busy_timeout = 5000;");
 } catch {
 // ignore
 }
 db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
 version INTEGER PRIMARY KEY,
 applied_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sft_records (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 record_hash TEXT UNIQUE NOT NULL,
 session_id TEXT NOT NULL,
 timestamp TEXT NOT NULL,
 worker_model TEXT NOT NULL,
 domain_tags_json TEXT NOT NULL,
 immediate_prompt TEXT NOT NULL,
 active_files_json TEXT NOT NULL,
 git_diff_summary TEXT,
 chosen_completion TEXT NOT NULL,
 messages_json TEXT NOT NULL,
 source TEXT NOT NULL DEFAULT 'live_golden'
);
CREATE TABLE IF NOT EXISTS dpo_records (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 record_hash TEXT UNIQUE NOT NULL,
 session_id TEXT NOT NULL,
 timestamp TEXT NOT NULL,
 worker_model TEXT NOT NULL,
 verifier_model TEXT NOT NULL,
 trigger_reason TEXT NOT NULL,
 flaw_category TEXT NOT NULL,
 domain_tags_json TEXT NOT NULL,
 immediate_prompt TEXT NOT NULL,
 active_files_json TEXT NOT NULL,
 compiler_error_summary TEXT NOT NULL,
 git_diff_summary TEXT,
 k3_audit_json TEXT NOT NULL,
 rejected_completion TEXT NOT NULL,
 chosen_completion TEXT NOT NULL,
 human_feedback TEXT
);
CREATE INDEX IF NOT EXISTS idx_sft_timestamp ON sft_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_dpo_timestamp ON dpo_records(timestamp);
CREATE INDEX IF NOT EXISTS idx_dpo_flaw ON dpo_records(flaw_category);
`);
 try {
 db.prepare(
 "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (1, ?)",
 ).run(new Date().toISOString());
 } catch {
 // A concurrent writer already inserted the row — harmless.
 }
}

/** Create the DB + schema eagerly (no-op when node:sqlite is missing). */
export function initDatabase(): void {
 withDb(() => undefined);
}

// ---------------------------------------------------------------------------
// Record hashes (shared by inserts, migration AND the exporter's dedupe)
// ---------------------------------------------------------------------------

function sha256(input: string): string {
 return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Deterministic DPO record identity. Deliberately excludes stack traces /
 * timestamps of the sink write so re-importing the same JSONL line from
 * another file does not create a duplicate.
 */
export function computeDpoRecordHash(record: {
 session_id?: string;
 timestamp?: string;
 trigger_reason?: string;
 chosen_completion?: string;
}): string {
 return sha256(
 [
 record.session_id ?? "unknown",
 record.timestamp ?? "",
 record.trigger_reason ?? "compiler_streak",
 record.chosen_completion ?? "",
 ].join("|"),
 );
}

/** Deterministic SFT record identity. */
export function computeSftRecordHash(record: {
 session_id?: string;
 timestamp?: string;
 immediate_prompt?: string;
 chosen_completion?: string;
}): string {
 return sha256(
 [
 record.session_id ?? "unknown",
 record.timestamp ?? "",
 record.immediate_prompt ?? "",
 record.chosen_completion ?? "",
 ].join("|"),
 );
}

// ---------------------------------------------------------------------------
// HF message shaping (kept byte-compatible with exporter.mapRecordToHfSFT)
// ---------------------------------------------------------------------------

interface SftShape {
 immediate_prompt?: string;
 git_diff_summary?: string | null;
 active_files?: Array<{ path?: string; content?: string } | null | undefined>;
 chosen_completion?: string;
}

/**
 * Build the `messages_json` payload stored on `sft_records`. Mirrors
 * `mapRecordToHfSFT()` in ./exporter.ts so a row exported straight from
 * SQLite is byte-identical to the same row exported from JSONL.
 */
export function buildSftMessagesJson(record: SftShape): string {
 const promptParts: string[] = [];
 const immediate = typeof record.immediate_prompt === "string" ? record.immediate_prompt : "";
 promptParts.push(immediate || "(no immediate prompt captured)");

 const diff = typeof record.git_diff_summary === "string" ? record.git_diff_summary : "";
 if (diff && diff.trim().length > 0) {
 promptParts.push("\n=== GIT DIFF (uncommitted, clamped) ===\n" + diff);
 }

 const files = Array.isArray(record.active_files) ? record.active_files : [];
 if (files.length > 0) {
 promptParts.push("\n=== ACTIVE FILES ===");
 for (const f of files) {
 if (!f || typeof f !== "object") continue;
 const path = typeof f.path === "string" ? f.path : "?";
 const content = typeof f.content === "string" ? f.content : "";
 promptParts.push("--- " + path + " ---");
 promptParts.push(content || "(empty)");
 }
 }

 return JSON.stringify([
 { role: "user", content: promptParts.join("\n") },
 { role: "assistant", content: typeof record.chosen_completion === "string" ? record.chosen_completion : "" },
 ]);
}

// ---------------------------------------------------------------------------
// Inserts
// ---------------------------------------------------------------------------

/**
 * Insert one Golden SFT record. Returns true when a new row was written,
 * false for a duplicate or when SQLite is unavailable.
 */
export function insertSftRecord(record: GoldenSFTRecord, source: string = "live_golden"): boolean {
 if (!record || typeof record !== "object") return false;
 try {
 return withDb((db) => {
 const hash = computeSftRecordHash(record);
 const stmt = db.prepare(`
INSERT OR IGNORE INTO sft_records (
 record_hash, session_id, timestamp, worker_model, domain_tags_json,
 immediate_prompt, active_files_json, git_diff_summary,
 chosen_completion, messages_json, source
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
 const res = stmt.run(
 hash,
 record.session_id || "unknown",
 record.timestamp || new Date().toISOString(),
 record.worker_model || "unknown",
 JSON.stringify(record.domain_tags ?? []),
 record.immediate_prompt || "",
 JSON.stringify(record.active_files ?? []),
 record.git_diff_summary ?? null,
 record.chosen_completion || "",
 buildSftMessagesJson(record),
 source,
 );
 return Number(res.changes) > 0;
 });
 } catch {
 return false;
 }
}

/**
 * Insert one DPO record AND promote its resolved completion into
 * `sft_records` (source `dpo_<trigger_reason>`).
 */
export function insertDpoRecord(record: HarvestedTrajectoryRecord): boolean {
 if (!record || typeof record !== "object") return false;
 let inserted = false;
 try {
 inserted = withDb((db) => {
 const hash = computeDpoRecordHash(record);
 const stmt = db.prepare(`
INSERT OR IGNORE INTO dpo_records (
 record_hash, session_id, timestamp, worker_model, verifier_model,
 trigger_reason, flaw_category, domain_tags_json, immediate_prompt,
 active_files_json, compiler_error_summary, git_diff_summary,
 k3_audit_json, rejected_completion, chosen_completion, human_feedback
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
 const res = stmt.run(
 hash,
 record.session_id || "unknown",
 record.timestamp || new Date().toISOString(),
 record.worker_model || "unknown",
 record.verifier_model || "unknown",
 record.trigger_reason || "compiler_streak",
 record.k3_audit?.flaw_category || "unknown",
 JSON.stringify(record.domain_tags ?? []),
 record.immediate_prompt || "",
 JSON.stringify(record.active_files ?? []),
 record.compiler_error_summary || "",
 record.git_diff_summary ?? null,
 JSON.stringify(record.k3_audit ?? {}),
 record.rejected_completion || "",
 record.chosen_completion || "",
 record.human_feedback ?? null,
 );
 return Number(res.changes) > 0;
 });
 } catch {
 return false;
 }

 // Promote the corrected code to SFT even if the DPO row already existed
 // (a re-run of the same episode shouldn't cost us the SFT row).
 const chosen = typeof record.chosen_completion === "string" ? record.chosen_completion : "";
 if (chosen.trim().length > 0) {
 insertSftRecord(
 {
 session_id: record.session_id,
 timestamp: record.timestamp,
 worker_model: record.worker_model,
 domain_tags: record.domain_tags ?? [],
 immediate_prompt: record.immediate_prompt,
 active_files: (record.active_files ?? [])
 .filter((f) => f && !f.skipped)
 .map((f) => ({ path: f.path, content: f.content })),
 git_diff_summary: record.git_diff_summary ?? null,
 chosen_completion: chosen,
 },
 "dpo_" + (record.trigger_reason || "compiler_streak"),
 );
 }
 return inserted;
}

// ---------------------------------------------------------------------------
// Read side (used by the exporter to include SQLite-only rows)
// ---------------------------------------------------------------------------

export interface SftRow {
 record_hash: string;
 messages_json: string;
}

export interface DpoRow {
 record_hash: string;
 session_id: string;
 timestamp: string;
 trigger_reason: string;
 immediate_prompt: string;
 active_files_json: string;
 git_diff_summary: string | null;
 k3_audit_json: string;
 rejected_completion: string;
 chosen_completion: string;
}

export function readSftRows(): SftRow[] {
 try {
 return withDb(
 (db) => db.prepare("SELECT record_hash, messages_json FROM sft_records ORDER BY id").all() as unknown as SftRow[],
 );
 } catch {
 return [];
 }
}

export function readDpoRows(): DpoRow[] {
 try {
 return withDb(
 (db) =>
 db
 .prepare(
 `SELECT record_hash, session_id, timestamp, trigger_reason, immediate_prompt,
 active_files_json, git_diff_summary, k3_audit_json,
 rejected_completion, chosen_completion
 FROM dpo_records ORDER BY id`,
 )
 .all() as unknown as DpoRow[],
 );
 } catch {
 return [];
 }
}

// ---------------------------------------------------------------------------
// Stats + migration
// ---------------------------------------------------------------------------

export interface DbStats {
 dbPath: string;
 sftCount: number;
 dpoCount: number;
 available: boolean;
 error?: string;
}

export function getDbStats(): DbStats {
 const dbPath = getDbPath();
 try {
 return withDb((db) => {
 const sftRow = db.prepare("SELECT COUNT(*) AS cnt FROM sft_records").get() as { cnt?: number } | undefined;
 const dpoRow = db.prepare("SELECT COUNT(*) AS cnt FROM dpo_records").get() as { cnt?: number } | undefined;
 return {
 dbPath,
 sftCount: Number(sftRow?.cnt ?? 0),
 dpoCount: Number(dpoRow?.cnt ?? 0),
 available: true,
 };
 });
 } catch (err) {
 return {
 dbPath,
 sftCount: 0,
 dpoCount: 0,
 available: false,
 error: (err as Error)?.message ?? String(err),
 };
 }
}

export interface MigrationInput {
 sftFiles?: string[];
 dpoFiles?: string[];
}

export interface MigrationResult {
 sftImported: number;
 dpoImported: number;
 sftScanned: number;
 dpoScanned: number;
}

/**
 * Import records from JSONL files into SQLite. Idempotent thanks to the
 * `record_hash` uniqueness constraint; malformed lines are skipped.
 *
 * Callers normally pass `listSftFiles()` / `listSinkFiles()` explicitly
 * (avoids a `db -> sink` import cycle). When omitted, the harvest root is
 * scanned for the two known filename patterns.
 */
export function migrateJsonlToSqlite(input: MigrationInput = {}): MigrationResult {
 const result: MigrationResult = { sftImported: 0, dpoImported: 0, sftScanned: 0, dpoScanned: 0 };
 try {
 initDatabase();
 } catch {
 return result;
 }

 const sftFiles = input.sftFiles ?? scanHarvestRoot(/^sft_golden.*\.jsonl$/);
 const dpoFiles = input.dpoFiles ?? scanHarvestRoot(/^trajectories.*\.jsonl$/);

 for (const file of sftFiles) {
 for (const line of readJsonlLines(file)) {
 result.sftScanned += 1;
 try {
 const parsed = JSON.parse(line) as GoldenSFTRecord;
 if (insertSftRecord(parsed, "migrated_jsonl")) result.sftImported += 1;
 } catch {
 // skip malformed
 }
 }
 }

 for (const file of dpoFiles) {
 for (const line of readJsonlLines(file)) {
 result.dpoScanned += 1;
 try {
 const parsed = JSON.parse(line) as HarvestedTrajectoryRecord;
 if (insertDpoRecord(parsed)) result.dpoImported += 1;
 } catch {
 // skip malformed
 }
 }
 }

 return result;
}

function scanHarvestRoot(pattern: RegExp): string[] {
 try {
 const root = ensureHarvestRoot();
 return readdirSync(root)
 .filter((name) => pattern.test(name))
 .map((name) => join(root, name))
 .sort();
 } catch {
 return [];
 }
}

function* readJsonlLines(file: string): Generator<string> {
 if (!existsSync(file)) return;
 let body: string;
 try {
 body = readFileSync(file, "utf8");
 } catch {
 return;
 }
 for (const line of body.split(/\r?\n/)) {
 const trimmed = line.trim();
 if (trimmed.length > 0) yield trimmed;
 }
}