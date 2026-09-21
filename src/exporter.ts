/**
 * Native HuggingFace DPO dataset exporter (Phase 4).
 *
 * Reads all `.pi/harvest/trajectories*.jsonl` files via streaming
 * (line-by-line, never loads the full file into RAM), maps each record
 * into the HF conversational DPO format expected by `trl.DPOTrainer`:
 *
 * {
 *   "prompt":   [{ "role": "user", "content": "<multi-line>" }],
 *   "chosen":   [{ "role": "assistant", "content": "<chosen>" }],
 *   "rejected": [{ "role": "assistant", "content": "<rejected>" }],
 *   "flaw_category": "..."
 * }
 *
 * The `prompt` content concatenates:
 * 1. the Inception Prompt (immediate_prompt)
 * 2. the clamped git_diff_summary (or a no-diff placeholder)
 * 3. a per-file context dump (path + clamped content) for each active file
 *
 * Output: `.pi/harvest/exports/dpo_dataset_YYYY_MM_DD.jsonl`.
 */

import { appendFileSync, createReadStream, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";

import { listSinkFiles } from "./sink.js";

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
 */
export async function exportToHuggingFaceDPO(opts: ExportOptions): Promise<ExportResult> {
 const now = opts.now ?? new Date();
 const dir = join(opts.cwd, ".pi", "harvest", "exports");
 mkdirSync(dir, { recursive: true });

 const outPath = join(dir, exportFilename(now));
 // Truncate any existing export for today so re-runs are deterministic.
 const { writeFileSync } = await import("node:fs");
 writeFileSync(outPath, "", { encoding: "utf8" });

 const sources = listSinkFiles(opts.cwd);
 let count = 0;
 let bytes = 0;

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
 const mapped = mapRecordToHfDpo(parsed);
 const out = JSON.stringify(mapped) + "\n";
 appendFileSync(outPath, out, { encoding: "utf8" });
 count++;
 bytes += Buffer.byteLength(out, "utf8");
 });
 rl.on("close", () => resolve());
 rl.on("error", reject);
 });
 }

 return { path: outPath, count, bytes, sources };
}
