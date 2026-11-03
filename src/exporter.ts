/**
 * Native HuggingFace SFT/DPO dataset exporter.
 *
 * Reads all `<harvestRoot>/trajectories*.jsonl` + `sft_golden*.jsonl`
 * files via streaming (line-by-line, never loads the full file into RAM),
 * merges in rows from the SQLite mirror (`harvest.db`), and maps each
 * record into the conversational formats expected by `trl.DPOTrainer`:
 *
 * DPO:
 * {
 * "prompt": [{ "role": "user", "content": "<multi-line>" }],
 * "chosen": [{ "role": "assistant", "content": "<chosen>" }],
 * "rejected": [{ "role": "assistant", "content": "<rejected>" }],
 * "flaw_category": "..."
 * }
 *
 * SFT:
 * { "messages": [{ "role": "user", ... }, { "role": "assistant", ... }] }
 *
 * The `prompt` content concatenates:
 * 1. the Inception Prompt (immediate_prompt)
 * 2. the clamped git_diff_summary (or a no-diff placeholder)
 * 3. a per-file context dump (path + clamped content) for each active file
 *
 * Deduplication: dual-written records appear in both JSONL and SQLite.
 * Both paths key off the same deterministic record hash (see ./db.ts), so
 * an episode is exported exactly once no matter which store it came from.
 *
 * Output: `<harvestRoot>/exports/dpo_dataset_YYYY_MM_DD.jsonl` and
 * `<harvestRoot>/exports/sft_dataset_YYYY_MM_DD.jsonl`.
 */

import { appendFileSync, createReadStream, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { listSinkFiles, listSftFiles } from "./sink.js";
import { ensureHarvestRoot } from "./paths.js";
import {
 computeDpoRecordHash,
 computeSftRecordHash,
 getDbPath,
 readDpoRows,
 readSftRows,
} from "./db.js";

export interface ExportOptions {
 cwd: string;
 now?: Date;
}

export interface ExportResult {
 path: string;
 count: number;
 bytes: number;
 sources: string[];
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
 if (typeof raw !== "string" || raw.length === 0) return fallback;
 try {
 return JSON.parse(raw) as T;
 } catch {
 return fallback;
 }
}

/**
 * Map a single Phase 4 HarvestedTrajectoryRecord to the HF conversational
 * DPO format. Pure function — exported so unit tests can verify the
 * mapping independently of disk I/O.
 */
export function mapRecordToHfDpo(record: any): {
 prompt: Array<{ role: string; content: string }>;
 chosen: Array<{ role: string; content: string }>;
 rejected: Array<{ role: string; content: string }>;
 flaw_category: string;
} {
 const lines: string[] = [];

 const immediate = typeof record?.immediate_prompt === "string" ? record.immediate_prompt : "";
 lines.push("=== TASK ===");
 lines.push(immediate || "(no immediate prompt captured)");

 const diff = typeof record?.git_diff_summary === "string" ? record.git_diff_summary : "";
 if (diff && diff.trim().length > 0) {
 lines.push("");
 lines.push("=== GIT DIFF (uncommitted, clamped) ===");
 lines.push(diff);
 } else {
 lines.push("");
 lines.push("=== GIT DIFF ===");
 lines.push("(no git diff captured)");
 }

 const files = Array.isArray(record?.active_files) ? record.active_files : [];
 if (files.length > 0) {
 lines.push("");
 lines.push("=== ACTIVE FILES ===");
 for (const f of files) {
 if (!f || typeof f !== "object") continue;
 const path = typeof f.path === "string" ? f.path : "?";
 const skipped = typeof f.skipped === "string" ? f.skipped : undefined;
 if (skipped) {
 lines.push("--- " + path + " ---");
 lines.push("(skipped: " + skipped + ")");
 continue;
 }
 const content = typeof f.content === "string" ? f.content : "";
 lines.push("--- " + path + " ---");
 lines.push(content || "(empty)");
 }
 }

 const promptContent = lines.join("\n");

 return {
 prompt: [{ role: "user", content: promptContent }],
 chosen: [{ role: "assistant", content: typeof record?.chosen_completion === "string" ? record.chosen_completion : "" }],
 rejected: [{ role: "assistant", content: typeof record?.rejected_completion === "string" ? record.rejected_completion : "" }],
 flaw_category: typeof record?.k3_audit?.flaw_category === "string" ? record.k3_audit.flaw_category : "unknown",
 };
}

/**
 * Compute the export filename. Format: `dpo_dataset_YYYY_MM_DD.jsonl`.
 */
export function exportFilename(now: Date = new Date()): string {
 const y = now.getUTCFullYear();
 const m = String(now.getUTCMonth() + 1).padStart(2, "0");
 const d = String(now.getUTCDate()).padStart(2, "0");
 return `dpo_dataset_${y}_${m}_${d}.jsonl`;
}

/**
 * Stream-read every sink file and append mapped HF-DPO records to the
 * export file. Returns the output path + record count.
 *
 * Sources are the rotated JSONL files AND the SQLite `dpo_records`
 * table. Rows are deduplicated by the same deterministic record hash the
 * DB uses, so dual-written episodes appear exactly once regardless of
 * which store they came from.
 */
export async function exportToHuggingFaceDPO(opts: ExportOptions): Promise<ExportResult> {
 const now = opts.now ?? new Date();
 const dir = join(ensureHarvestRoot(), "exports");
 mkdirSync(dir, { recursive: true });

 const outPath = join(dir, exportFilename(now));
 // Truncate any existing export for today so re-runs are deterministic.
 writeFileSync(outPath, "", { encoding: "utf8" });

 const sources = listSinkFiles(opts.cwd);
 const seen = new Set<string>();
 let count = 0;
 let bytes = 0;

 const emit = (mapped: unknown, hash: string): void => {
 if (seen.has(hash)) return;
 seen.add(hash);
 const out = JSON.stringify(mapped) + "\n";
 appendFileSync(outPath, out, { encoding: "utf8" });
 count++;
 bytes += Buffer.byteLength(out, "utf8");
 };

 for (const sourcePath of sources) {
 if (!existsSync(sourcePath)) continue;
 const rl = createInterface({
 input: createReadStream(sourcePath, { encoding: "utf8" }),
 crlfDelay: Infinity,
 });
 await new Promise<void>((resolve, reject) => {
 rl.on("line", (line) => {
 const trimmed = line.trim();
 if (!trimmed) return;
 let parsed: any;
 try {
 parsed = JSON.parse(trimmed);
 } catch {
 return;
 }
 emit(mapRecordToHfDpo(parsed), computeDpoRecordHash(parsed));
 });
 rl.on("close", () => resolve());
 rl.on("error", reject);
 });
 }

 // SQLite-only rows (e.g. records inserted by a migration whose JSONL
 // source was later rotated away).
 let usedDb = false;
 for (const row of readDpoRows()) {
 usedDb = true;
 const record = {
 immediate_prompt: row.immediate_prompt,
 git_diff_summary: row.git_diff_summary,
 active_files: safeJsonParse<unknown[]>(row.active_files_json, []),
 chosen_completion: row.chosen_completion,
 rejected_completion: row.rejected_completion,
 k3_audit: safeJsonParse<Record<string, unknown>>(row.k3_audit_json, {}),
 };
 emit(mapRecordToHfDpo(record), row.record_hash || computeDpoRecordHash(row));
 }
 if (usedDb && !sources.includes(getDbPath())) sources.push(getDbPath());

 return { path: outPath, count, bytes, sources };
}

// ============================================================================
// SFT Golden exporter (Phase 7)
// ============================================================================

/**
 * Map a Phase 7 Golden SFT record to the standard Hugging Face
 * conversational SFT format expected by `trl.SFTTrainer`:
 *
 * { "messages": [{ "role": "user", "content": "..." }, { "role": "assistant", "content": "..." }] }
 */
export function mapRecordToHfSFT(record: any): {
 messages: Array<{ role: string; content: string }>;
} {
 const promptParts: string[] = [];
 const immediate = typeof record?.immediate_prompt === "string" ? record.immediate_prompt : "";
 if (immediate) {
 promptParts.push(immediate);
 } else {
 promptParts.push("(no immediate prompt captured)");
 }
 const diff = typeof record?.git_diff_summary === "string" ? record.git_diff_summary : "";
 if (diff && diff.trim().length > 0) {
 promptParts.push("\n=== GIT DIFF (uncommitted, clamped) ===\n" + diff);
 }
 const files = Array.isArray(record?.active_files) ? record.active_files : [];
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

 return {
 messages: [
 { role: "user", content: promptParts.join("\n") },
 { role: "assistant", content: typeof record?.chosen_completion === "string" ? record.chosen_completion : "" },
 ],
 };
}

/**
 * Compute the SFT export filename. Format: `sft_dataset_YYYY_MM_DD.jsonl`.
 */
export function sftExportFilename(now: Date = new Date()): string {
 const y = now.getUTCFullYear();
 const m = String(now.getUTCMonth() + 1).padStart(2, "0");
 const d = String(now.getUTCDate()).padStart(2, "0");
 return `sft_dataset_${y}_${m}_${d}.jsonl`;
}

/**
 * Stream-read every SFT Golden sink file and append mapped HF-SFT
 * records to the export file. SQLite `sft_records` (including rows
 * promoted from resolved DPO episodes) are merged in and deduplicated
 * by record hash.
 */
export async function exportToHuggingFaceSFT(opts: ExportOptions): Promise<ExportResult> {
 const now = opts.now ?? new Date();
 const dir = join(ensureHarvestRoot(), "exports");
 mkdirSync(dir, { recursive: true });

 const outPath = join(dir, sftExportFilename(now));
 writeFileSync(outPath, "", { encoding: "utf8" });

 const sources = listSftFiles(opts.cwd);
 const seen = new Set<string>();
 let count = 0;
 let bytes = 0;

 const emit = (mapped: unknown, hash: string): void => {
 if (seen.has(hash)) return;
 seen.add(hash);
 const out = JSON.stringify(mapped) + "\n";
 appendFileSync(outPath, out, { encoding: "utf8" });
 count++;
 bytes += Buffer.byteLength(out, "utf8");
 };

 for (const sourcePath of sources) {
 if (!existsSync(sourcePath)) continue;
 const rl = createInterface({
 input: createReadStream(sourcePath, { encoding: "utf8" }),
 crlfDelay: Infinity,
 });
 await new Promise<void>((resolve, reject) => {
 rl.on("line", (line) => {
 const trimmed = line.trim();
 if (!trimmed) return;
 let parsed: any;
 try {
 parsed = JSON.parse(trimmed);
 } catch {
 return;
 }
 emit(mapRecordToHfSFT(parsed), computeSftRecordHash(parsed));
 });
 rl.on("close", () => resolve());
 rl.on("error", reject);
 });
 }

 let usedDb = false;
 for (const row of readSftRows()) {
 usedDb = true;
 // `messages_json` is the bare HF message array (see db.buildSftMessagesJson),
 // but tolerate both a raw array and a `{ messages: [...] }` wrapper.
 const parsed = safeJsonParse<unknown>(row.messages_json, []);
 const messages = Array.isArray(parsed)
 ? parsed
 : parsed && typeof parsed === "object" && Array.isArray((parsed as { messages?: unknown }).messages)
 ? (parsed as { messages: unknown[] }).messages
 : [];
 if (messages.length === 0) continue;
 emit({ messages }, row.record_hash);
 }
 if (usedDb && !sources.includes(getDbPath())) sources.push(getDbPath());

 return { path: outPath, count, bytes, sources };
}
