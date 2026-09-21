/**
 * DPO / SFT data sink (Phase 4).
 *
 * Writes one HarvestedTrajectoryRecord per resolved episode to a
 * date-stamped file `<cwd>/.pi/harvest/trajectories_YYYY_MM.jsonl`
 * using `appendFileSync` for line-atomic POSIX writes. On Windows the
 * kernel still flushes the line before returning; concurrent writers
 * risk interleaving but each line is a self-contained JSON object so
 * consumers re-parse line-by-line.
 *
 * Phase 4 additions:
 * - Rotated filenames by year+month. `currentSinkPath(cwd)` resolves
 * the active month's file. Old records in `trajectories.jsonl` (Phase 3)
 * are still discovered by `listSinkFiles()` so the exporter can read them.
 * - Streaming line counters via `countLines(path)` so large files don't
 * blow up RAM.
 * - `listSinkFiles(cwd)` returns all `trajectories*.jsonl` paths sorted
 * oldest-first — the canonical input for the exporter.
 */

import { appendFileSync, mkdirSync, statSync, existsSync, createReadStream } from "node:fs";
import { join, basename } from "node:path";
import { createInterface } from "node:readline";

import type {
 ActiveFile,
 GoldenSFTRecord,
 HarvestedTrajectoryRecord,
 NeatSlice,
 VerifierAudit,
} from "./types.js";

export interface SinkContext {
 cwd: string;
 sessionManager?: { getSessionId(): string };
 // Permit extra fields (ui, model, navigateTree, ...) so callers can
 // pass a real ExtensionContext / ExtensionCommandContext / PiContext
 // without casts.
 [key: string]: unknown;
}

export interface SinkResult {
 path: string;
 bytes: number;
}

export type TriggerReason = "compiler_streak" | "periodic_turn" | "manual" | "thrashing_distillation" | "semantic_review" | "architectural_opinion";

/**
 * Filename pattern for rotated sinks. Matched by listSinkFiles().
 */
const SINK_GLOB = /^trajectories.*\.jsonl$/;

/**
 * Compute the active month's sink filename.
 * Format: `trajectories_YYYY_MM.jsonl`.
 */
export function currentSinkFilename(now: Date = new Date()): string {
 const y = now.getUTCFullYear();
 const m = String(now.getUTCMonth() + 1).padStart(2, "0");
 return `trajectories_${y}_${m}.jsonl`;
}

/**
 * Compute the active month's SFT Golden sink filename.
 * Format: `sft_golden_YYYY_MM.jsonl`.
 */
export function currentSftSinkFilename(now: Date = new Date()): string {
 const y = now.getUTCFullYear();
 const m = String(now.getUTCMonth() + 1).padStart(2, "0");
 return `sft_golden_${y}_${m}.jsonl`;
}

/**
 * Resolve the absolute path to the active SFT Golden sink file.
 */
export function currentSftSinkPath(cwd: string, now: Date = new Date()): string {
 return join(cwd, ".pi", "harvest", currentSftSinkFilename(now));
}

/**
 * Discover all SFT Golden sink files.
 */
export function listSftFiles(cwd: string): string[] {
 const dir = join(cwd, ".pi", "harvest");
 if (!existsSync(dir)) return [];
 const { readdirSync } = require("node:fs") as typeof import("node:fs");
 const entries = readdirSync(dir);
 return entries
 .filter((name: string) => /^sft_golden.*\.jsonl$/.test(name))
 .map((name: string) => join(dir, name))
 .sort();
}

/**
 * Append one GoldenSFTRecord as a JSONL line to the active month's
 * SFT Golden sink. Creates the directory if missing.
 */
export function appendGoldenSFT(cwd: string, record: GoldenSFTRecord, now: Date = new Date()): SinkResult {
 const dir = join(cwd, ".pi", "harvest");
 mkdirSync(dir, { recursive: true });
 const filePath = currentSftSinkPath(cwd, now);
 const line = JSON.stringify(record) + "\n";
 appendFileSync(filePath, line, { encoding: "utf8" });
 return { path: filePath, bytes: Buffer.byteLength(line, "utf8") };
}

/**
 * Sync count of SFT Golden records in the current month's sink.
 */
export function countSftRecords(cwd: string, now: Date = new Date()): number {
 const filePath = currentSftSinkPath(cwd, now);
 if (!existsSync(filePath)) return 0;
 const buf = (require("node:fs") as typeof import("node:fs")).readFileSync(filePath, "utf8") as string;
 if (!buf) return 0;
 let n = 0;
 for (let i = 0; i < buf.length; i++) {
 if (buf.charCodeAt(i) === 10) n++;
 }
 if (!buf.endsWith("\n")) n++;
 return n;
}

/**
 * Resolve the absolute path to the active sink file.
 */
export function currentSinkPath(cwd: string, now: Date = new Date()): string {
 return join(cwd, ".pi", "harvest", currentSinkFilename(now));
}

/**
 * Discover all sink files (rotated + the v0.3.0 unrotated default)
 * sorted oldest-first by filename so streaming is deterministic.
 */
export function listSinkFiles(cwd: string): string[] {
 const dir = join(cwd, ".pi", "harvest");
 if (!existsSync(dir)) return [];
 const { readdirSync } = require("node:fs") as typeof import("node:fs");
 const entries = readdirSync(dir);
 const matches = entries
 .filter((name: string) => SINK_GLOB.test(name))
 .map((name: string) => join(dir, name))
 .sort();
 return matches;
}

/**
 * Construct a full HarvestedTrajectoryRecord from the audit + slice +
 * chosen/rejected completions. Pure data; does not touch disk.
 */
export function buildTrajectoryRecord(args: {
 audit: VerifierAudit;
 slice: NeatSlice;
 activeFiles: ActiveFile[];
 chosenCompletion: string;
 rejectedCompletion: string;
 workerModel: string;
 verifierModel: string;
 triggerReason: TriggerReason;
 divergenceEntryId: string | null;
 domainTags: string[];
 gitDiffSummary: string | null;
 humanFeedback?: string | null;
 ctx: SinkContext;
}): HarvestedTrajectoryRecord {
 return {
 session_id: args.ctx.sessionManager?.getSessionId?.() ?? "unknown",
 timestamp: new Date().toISOString(),
 worker_model: args.workerModel || "unknown",
 verifier_model: args.verifierModel || "unknown",
 trigger_reason: args.triggerReason,
 domain_tags: args.domainTags,
 immediate_prompt: args.slice.inceptionPrompt,
 active_files: args.activeFiles,
 compiler_error_summary: args.slice.compilerError || "",
 git_diff_summary: args.gitDiffSummary,
 k3_audit: {
 divergence_entry_id: args.divergenceEntryId,
 flaw_category: args.audit.flaw_category,
 root_cause: args.audit.root_cause,
 steering_instructions: args.audit.steering_instructions,
 },
 rejected_completion: args.rejectedCompletion,
 chosen_completion: args.chosenCompletion,
 human_feedback: args.humanFeedback ?? null,
 };
}

/**
 * Append a single JSONL line to the active month's sink.
 * Creates the directory if missing (recursive).
 */
export function writeTrajectoryRecord(
 record: HarvestedTrajectoryRecord,
 cwd: string,
 now: Date = new Date(),
): SinkResult {
 const dir = join(cwd, ".pi", "harvest");
 mkdirSync(dir, { recursive: true });
 const filePath = currentSinkPath(cwd, now);
 const line = JSON.stringify(record) + "\n";
 appendFileSync(filePath, line, { encoding: "utf8" });
 return { path: filePath, bytes: Buffer.byteLength(line, "utf8") };
}

/**
 * Backwards-compatible thin wrapper.
 */
export function writeDpoEntry(args: {
 audit: VerifierAudit;
 slice: NeatSlice;
 chosenCompletion: string;
 rejectedCompletion: string;
 ctx: SinkContext;
 domainTags?: string[];
 workerModel?: string;
 verifierModel?: string;
 triggerReason?: TriggerReason;
 divergenceEntryId?: string | null;
 activeFiles?: ActiveFile[];
 gitDiffSummary?: string | null;
 humanFeedback?: string | null;
}): SinkResult {
 const record = buildTrajectoryRecord({
 audit: args.audit,
 slice: args.slice,
 activeFiles: args.activeFiles ?? [],
 chosenCompletion: args.chosenCompletion,
 rejectedCompletion: args.rejectedCompletion,
 workerModel: args.workerModel ?? "unknown",
 verifierModel: args.verifierModel ?? (process.env.VERIFIER_MODEL ?? "unknown"),
 triggerReason: args.triggerReason ?? "compiler_streak",
 divergenceEntryId: args.divergenceEntryId ?? null,
 domainTags: args.domainTags ?? args.audit.domain_tags ?? [],
 gitDiffSummary: args.gitDiffSummary ?? null,
 humanFeedback: args.humanFeedback ?? null,
 ctx: args.ctx,
 });
 return writeTrajectoryRecord(record, args.ctx.cwd);
}

/**
 * Stream-count newlines in a JSONL file. Avoids loading the whole file
 * into RAM for the 200MB-scale files the spec warns about.
 */
export async function countLines(path: string): Promise<number> {
 if (!existsSync(path)) return 0;
 return new Promise<number>((resolve, reject) => {
 let n = 0;
 const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
 rl.on("line", () => {
 n++;
 });
 rl.on("close", () => resolve(n));
 rl.on("error", reject);
 });
}

/**
 * Stream-count records via JSON parse. Slightly slower than countLines
 * but ignores trailing partial lines and blank lines.
 */
export async function countRecords(path: string): Promise<number> {
 if (!existsSync(path)) return 0;
 return new Promise<number>((resolve, reject) => {
 let n = 0;
 const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
 rl.on("line", (line) => {
 const trimmed = line.trim();
 if (trimmed.length > 0) n++;
 });
 rl.on("close", () => resolve(n));
 rl.on("error", reject);
 });
}

/**
 * Backwards-compatible synchronous record counter for the CURRENT
 * MONTH's sink file. Preserves the v0.3.0 API for any external
 * consumers (and the unit tests that import it directly).
 */
export function countHarvestedRecords(cwd: string, now: Date = new Date()): number {
 const filePath = currentSinkPath(cwd, now);
 if (!existsSync(filePath)) return 0;
 const buf = require("node:fs").readFileSync(filePath, "utf8") as string;
 if (!buf) return 0;
 let n = 0;
 for (let i = 0; i < buf.length; i++) {
 if (buf.charCodeAt(i) === 10) n++;
 }
 if (!buf.endsWith("\n")) n++;
 return n;
}

/**
 * Sink stats for /harvest status. Reports the CURRENT month's file so
 * the output stays relevant even after long-running installs.
 */
export interface SinkStats {
 path: string;
 recordCount: number;
 sizeBytes: number;
}

export async function getSinkStats(cwd: string, now: Date = new Date()): Promise<SinkStats> {
 const filePath = currentSinkPath(cwd, now);
 if (!existsSync(filePath)) {
 return { path: filePath, recordCount: 0, sizeBytes: 0 };
 }
 const st = statSync(filePath);
 return {
 path: filePath,
 recordCount: await countRecords(filePath),
 sizeBytes: st.size,
 };
}

/**
 * Get the basename of the current sink file (e.g. `trajectories_2026_09.jsonl`).
 * Useful for telemetry/status formatting.
 */
export function activeSinkBasename(cwd: string, now: Date = new Date()): string {
 return basename(currentSinkPath(cwd, now));
}
