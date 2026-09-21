/**
 * DPO data sink: append a single JSON line per resolved harvest to
 * `<cwd>/.pi/harvest/trajectories.jsonl`.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

import type { DpoEntry, NeatSlice, VerifierAudit } from "./types.js";

export interface SinkContext {
 cwd: string;
 sessionManager?: { getSessionId(): string };
}

export interface SinkResult {
 path: string;
 bytes: number;
}

/**
 * Atomically append a JSONL line. mkdirSync with recursive: true ensures
 * `.pi/harvest/` exists even on a fresh checkout.
 *
 * Writes are line-atomic on POSIX (a single write(2) under PIPE_BUF)
 * and best-effort atomic on Windows; we accept that windows file
 * locking may briefly interleave — each line is a self-contained
 * JSON object so any consumer re-parses line-by-line.
 */
export function writeDpoEntry(args: {
 audit: VerifierAudit;
 slice: NeatSlice;
 chosenCompletion: string;
 rejectedCompletion: string;
 ctx: SinkContext;
 domainTags?: string[];
}): SinkResult {
 const dir = join(args.ctx.cwd, ".pi", "harvest");
 mkdirSync(dir, { recursive: true });

 const filePath = join(dir, "trajectories.jsonl");

 const entry: DpoEntry = {
 session_id: args.ctx.sessionManager?.getSessionId?.() ?? "unknown",
 domain_tags: args.domainTags ?? [],
 k3_diagnosis: args.audit,
 immediate_prompt: args.slice.inceptionPrompt,
 rejected_completion: args.rejectedCompletion,
 chosen_completion: args.chosenCompletion,
 ts: new Date().toISOString(),
 };

 // Use JSON.stringify with no indentation (single line).
 const line = JSON.stringify(entry) + "\n";
 // Ensure parent dir still exists right before write (defensive).
 mkdirSync(dirname(filePath), { recursive: true });
 appendFileSync(filePath, line, { encoding: "utf8" });

 return { path: filePath, bytes: Buffer.byteLength(line, "utf8") };
}
