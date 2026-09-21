/**
 * DPO / SFT data sink (Phase 3 schema).
 *
 * Writes one HarvestedTrajectoryRecord per resolved episode to
 * `<cwd>/.pi/harvest/trajectories.jsonl` using `appendFileSync` for
 * line-atomic POSIX writes. On Windows the kernel still flushes the
 * line before returning; concurrent writers risk interleaving but
 * each line is a self-contained JSON object so consumers re-parse
 * line-by-line.
 *
 * Schema (see types.ts HarvestedTrajectoryRecord):
 * - session_id, timestamp, worker_model, verifier_model, trigger_reason
 * - domain_tags, immediate_prompt, active_files, compiler_error_summary
 * - k3_audit (nested divergence/root_cause/steering), rejected_completion, chosen_completion
 */

import { appendFileSync, mkdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

import type {
 ActiveFile,
 HarvestedTrajectoryRecord,
 NeatSlice,
 VerifierAudit,
} from "./types.js";

export interface SinkContext {
 cwd: string;
 sessionManager?: { getSessionId(): string };
}

export interface SinkResult {
 path: string;
 bytes: number;
}

export type TriggerReason = "compiler_streak" | "periodic_turn" | "manual";

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
 k3_audit: {
 divergence_entry_id: args.divergenceEntryId,
 flaw_category: args.audit.flaw_category,
 root_cause: args.audit.root_cause,
 steering_instructions: args.audit.steering_instructions,
 },
 rejected_completion: args.rejectedCompletion,
 chosen_completion: args.chosenCompletion,
 };
}

/**
 * Append a single JSONL line to <cwd>/.pi/harvest/trajectories.jsonl.
 * Creates the directory if missing (recursive).
 */
export function writeTrajectoryRecord(record: HarvestedTrajectoryRecord, cwd: string): SinkResult {
 const dir = join(cwd, ".pi", "harvest");
 mkdirSync(dir, { recursive: true });
 const filePath = join(dir, "trajectories.jsonl");

 const line = JSON.stringify(record) + "\n";
 mkdirSync(dirname(filePath), { recursive: true });
 appendFileSync(filePath, line, { encoding: "utf8" });
 return { path: filePath, bytes: Buffer.byteLength(line, "utf8") };
}

/**
 * Backwards-compatible thin wrapper: maps the Phase 2 argument shape
 * onto the new HarvestedTrajectoryRecord schema. Existing callers
 * (Phase 2 index.ts) keep working without modification, though new
 * code should call buildTrajectoryRecord() + writeTrajectoryRecord()
 * directly.
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
 ctx: args.ctx,
 });
 return writeTrajectoryRecord(record, args.ctx.cwd);
}

/**
 * Count lines in the JSONL sink. Returns 0 if file doesn't exist.
 */
export function countHarvestedRecords(cwd: string): number {
 const filePath = join(cwd, ".pi", "harvest", "trajectories.jsonl");
 if (!existsSync(filePath)) return 0;
 try {
 const buf = require("node:fs").readFileSync(filePath, "utf8") as string;
 if (!buf) return 0;
 let n = 0;
 for (let i = 0; i < buf.length; i++) {
 if (buf.charCodeAt(i) === 10) n++; // \n
 }
 // If file doesn't end with newline, count the partial last line.
 if (!buf.endsWith("\n")) n++;
 return n;
 } catch {
 return 0;
 }
}

/**
 * Sink stats for /harvest status.
 */
export interface SinkStats {
 path: string;
 recordCount: number;
 sizeBytes: number;
}

export function getSinkStats(cwd: string): SinkStats {
 const filePath = join(cwd, ".pi", "harvest", "trajectories.jsonl");
 if (!existsSync(filePath)) {
 return { path: filePath, recordCount: 0, sizeBytes: 0 };
 }
 const st = statSync(filePath);
 return {
 path: filePath,
 recordCount: countHarvestedRecords(cwd),
 sizeBytes: st.size,
 };
}
