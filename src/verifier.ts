/**
 * Out-of-band Verifier HTTP call (Phase 3).
 *
 * Generic OpenAI-compatible `POST {baseUrl}/chat/completions` with
 * exponential backoff (1s -> 2s) on 429/5xx and network timeouts.
 *
 * Throws VerifierUnavailableError when all retries are exhausted —
 * callers should catch and reset state rather than crash.
 */

import type { NeatSlice, VerifierAudit, ActiveFile } from "./types.js";
import { VerifierUnavailableError } from "./types.js";
import { buildVerifierPayload } from "./slice.js";

const REQUIRED_FIELDS: (keyof VerifierAudit)[] = [
 "inferred_subtask",
 "divergence_detected",
 "flaw_category",
 "root_cause",
 "discard_advice",
 "steering_instructions",
 "domain_tags",
];

const SYSTEM_PROMPT = [
 "You are a strict trajectory auditor.",
 "Given a conversation slice where the worker model is stuck in a",
 "compile-failure loop, analyze it and return ONLY a JSON object",
 "with exactly these fields and no others:",
 "",
 JSON.stringify({
 inferred_subtask: "string — the high-level task the worker was asked to do, derived from the Inception Prompt",
 divergence_detected: "boolean — true if the worker has gone off-track from a sound initial plan",
 divergence_turn_entry_id: "string (optional) — the entry id of the slice entry where divergence began; omit if no divergence",
 divergence_turn: "number (optional, 1-based slice-relative) — legacy field, prefer divergence_turn_entry_id",
 flaw_category: "string — one of {logic_error, misunderstood_spec, missing_knowledge, environmental, off_topic, none}",
 root_cause: "string — a single-sentence explanation of WHY the worker diverged",
 discard_advice: "string — short instruction for what context to remove or summarize",
 steering_instructions: "string — concise directive (max 8 sentences) telling the worker exactly how to recover",
 domain_tags: "array of strings — canonical tags for the workspace (e.g. ['rust','tauri'], ['csharp','dotnet'], ['flutter'], ['shopify','liquid'], ['typescript']); empty array if unknown",
 }, null, 2),
 "",
 "Return JSON only. Do not wrap it in markdown fences. Do not add prose.",
].join("\n");

function readEnv(): { baseUrl: string; apiKey: string; model: string; timeoutMs: number; retries: number } {
 const baseUrl = process.env.VERIFIER_BASE_URL?.replace(/\/+$/, "") ?? "";
 const apiKey = process.env.VERIFIER_API_KEY ?? "";
 const model = process.env.VERIFIER_MODEL ?? "";
 const timeoutMs = Number(process.env.HARVEST_TIMEOUT_MS ?? "300000");
 const retries = Number(process.env.HARVEST_MAX_RETRIES ?? "2");
 if (!baseUrl) throw new Error("VERIFIER_BASE_URL is not set");
 if (!apiKey) throw new Error("VERIFIER_API_KEY is not set");
 if (!model) throw new Error("VERIFIER_MODEL is not set");
 if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
 throw new Error("HARVEST_TIMEOUT_MS must be a positive number");
 }
 if (!Number.isFinite(retries) || retries < 0) {
 throw new Error("HARVEST_MAX_RETRIES must be >= 0");
 }
 return { baseUrl, apiKey, model, timeoutMs, retries };
}

/**
 * Strip ```json ... ``` (or generic ``` ... ```) code fences.
 */
export function stripJsonFences(raw: string): string {
 let s = raw.trim();
 const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i;
 const m = s.match(fenceRe);
 if (m) s = m[1].trim();
 return s;
}

/**
 * Validate that an unknown JSON value conforms to the VerifierAudit
 * schema. Throws on mismatch.
 */
export function validateAudit(value: unknown): VerifierAudit {
 if (!value || typeof value !== "object" || Array.isArray(value)) {
 throw new Error("Verifier response is not a JSON object");
 }
 const obj = value as Record<string, unknown>;
 for (const field of REQUIRED_FIELDS) {
 if (!(field in obj)) {
 throw new Error("Verifier response missing required field: " + field);
 }
 }
 if (typeof obj.inferred_subtask !== "string") {
 throw new Error("Verifier response: inferred_subtask must be a string");
 }
 if (typeof obj.divergence_detected !== "boolean") {
 throw new Error("Verifier response: divergence_detected must be a boolean");
 }
 if (
 "divergence_turn" in obj &&
 obj.divergence_turn !== undefined &&
 (typeof obj.divergence_turn !== "number" || !Number.isFinite(obj.divergence_turn))
 ) {
 throw new Error("Verifier response: divergence_turn must be a finite number when present");
 }
 if (
 "divergence_turn_entry_id" in obj &&
 obj.divergence_turn_entry_id !== undefined &&
 obj.divergence_turn_entry_id !== null &&
 typeof obj.divergence_turn_entry_id !== "string"
 ) {
 throw new Error("Verifier response: divergence_turn_entry_id must be a string when present");
 }
 for (const f of ["flaw_category", "root_cause", "discard_advice", "steering_instructions"] as const) {
 if (typeof obj[f] !== "string") {
 throw new Error("Verifier response: " + f + " must be a string");
 }
 }
 if (!Array.isArray(obj.domain_tags)) {
 throw new Error("Verifier response: domain_tags must be an array");
 }
 for (const t of obj.domain_tags) {
 if (typeof t !== "string") {
 throw new Error("Verifier response: domain_tags entries must be strings");
 }
 }
 return obj as unknown as VerifierAudit;
}

function sleep(ms: number): Promise<void> {
 return new Promise((r) => setTimeout(r, ms));
}

/**
 * Make a single verifier HTTP attempt. Throws on any failure (HTTP
 * error, timeout, parse error). The retry wrapper around this catches
 * and retries based on the kind of failure.
 */
async function attemptOnce(
 slice: NeatSlice,
 opts: { baseUrl: string; apiKey: string; model: string; timeoutMs: number },
 attempt: number,
): Promise<VerifierAudit> {
 const userContent = buildVerifierPayload(slice);
 const body = {
 model: opts.model,
 messages: [
 { role: "system", content: SYSTEM_PROMPT },
 { role: "user", content: userContent },
 ],
 response_format: { type: "json_object" },
 temperature: 0,
 };

 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

 let res: Response;
 try {
 res = await fetch(opts.baseUrl + "/chat/completions", {
 method: "POST",
 headers: {
 "Content-Type": "application/json",
 Authorization: "Bearer " + opts.apiKey,
 },
 body: JSON.stringify(body),
 signal: controller.signal,
 });
 } catch (err) {
 clearTimeout(timer);
 const e = err as Error;
 if (e.name === "AbortError") {
 throw new Error("attempt " + attempt + ": timed out after " + opts.timeoutMs + "ms");
 }
 throw new Error("attempt " + attempt + ": network error: " + e.message);
 }
 clearTimeout(timer);

 // Retryable HTTP statuses.
 if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
 throw new RetryableHttpError(res.status, res.statusText);
 }

 if (!res.ok) {
 const text = await res.text().catch(() => "");
 throw new Error("attempt " + attempt + ": HTTP " + res.status + ": " + text.slice(0, 500));
 }

 const payload = (await res.json()) as {
 choices?: Array<{ message?: { content?: string } }>;
 };
 const content = payload?.choices?.[0]?.message?.content;
 if (typeof content !== "string" || content.length === 0) {
 throw new Error("attempt " + attempt + ": empty content in choices[0].message.content");
 }

 const cleaned = stripJsonFences(content);
 let parsed: unknown;
 try {
 parsed = JSON.parse(cleaned);
 } catch (err) {
 throw new Error(
 "attempt " + attempt + ": JSON.parse failed: " + (err as Error).message + "; first 200 chars: " + cleaned.slice(0, 200),
 );
 }
 return validateAudit(parsed);
}

class RetryableHttpError extends Error {
 constructor(public readonly status: number, public override message: string) {
 super("HTTP " + status + ": " + message);
 this.name = "RetryableHttpError";
 }
}

// ============================================================================
// Distiller (Phase 5): compress multi-turn thrashing into optimal 1-turn
// response. Non-blocking; called from background promise.
// ============================================================================

const DISTILLER_SYSTEM_PROMPT = [
 "You are a Principal Software Architect.",
 "The junior worker model took an inefficient, multi-turn trial-and-error path to arrive at the working code provided in the active files.",
 "Your task is Hindsight Relabeling.",
 "Write the optimal, single-turn assistant response that provides this exact solution directly and elegantly, as if it got it right on the first try.",
 "",
 "Constraints:",
 "- The distilled response should be the code + a brief explanation, as a single assistant message.",
 "- Preserve correctness — the solution must be byte-equivalent in behavior to the working code.",
 "- Strip out false starts, debugging chatter, and intermediate edits.",
 "- Do NOT introduce new dependencies, APIs, or files that weren't in the working code.",
 "",
 "Return JSON only with this exact shape and no other keys:",
 JSON.stringify({
 distilled_chosen_completion: "string — the optimal single-turn assistant response (code + brief prose)",
 }, null, 2),
 "",
 "Return JSON only. Do not wrap it in markdown fences. Do not add prose.",
].join("\n");

/**
 * Strict schema for the distiller response.
 */
export interface DistillerResponse {
 distilled_chosen_completion: string;
}

/**
 * Validate a distiller response. Throws on mismatch.
 */
export function validateDistillerResponse(value: unknown): DistillerResponse {
 if (!value || typeof value !== "object" || Array.isArray(value)) {
 throw new Error("Distiller response is not a JSON object");
 }
 const obj = value as Record<string, unknown>;
 if (typeof obj.distilled_chosen_completion !== "string") {
 throw new Error("Distiller response: distilled_chosen_completion must be a string");
 }
 return obj as unknown as DistillerResponse;
}

/**
 * Build the user payload for the distiller. Unlike the error auditor,
 * this payload leads with the working active files (the ground truth)
 * followed by the thrash transcript for context.
 */
export function buildDistillerPayload(opts: { slice: NeatSlice; activeFiles: ActiveFile[] }): string {
 const parts: string[] = [];

 if (opts.activeFiles.length > 0) {
 parts.push("=== WORKING CODE (ground truth) ===");
 for (const f of opts.activeFiles) {
 if (!f || typeof f !== "object") continue;
 const path = typeof f.path === "string" ? f.path : "?";
 const skipped = typeof f.skipped === "string" ? f.skipped : undefined;
 if (skipped) {
 parts.push("--- " + path + " ---");
 parts.push("(skipped: " + skipped + ")");
 continue;
 }
 const content = typeof f.content === "string" ? f.content : "";
 parts.push("--- " + path + " ---");
 parts.push(content || "(empty)");
 }
 } else {
 parts.push("=== WORKING CODE ===");
 parts.push("(no active files captured)");
 }

 if (opts.slice.inceptionPrompt) {
 parts.push("\n=== ORIGINAL TASK ===");
 parts.push(opts.slice.inceptionPrompt);
 }

 if (opts.slice.sliceEntries.length > 0) {
 parts.push("\n=== THRASH TRANSCRIPT (for context — do not echo verbatim) ===");
 for (let i = 0; i < opts.slice.sliceEntries.length; i++) {
 const entry = opts.slice.sliceEntries[i];
 const role = entry.type === "message" ? (entry.message?.role ?? entry.type) : entry.type;
 const text = entryToTextForDistiller(entry);
 parts.push("=== TURN " + (i + 1) + " (" + role + ") ===");
 parts.push(text || "(empty)");
 }
 }

 const joined = parts.join("\n\n");
 return enforcePayloadSizeInternal(joined, 64 * 1024);
}

function entryToTextForDistiller(entry: any): string {
 if (!entry || typeof entry !== "object") return "";
 if (entry.type === "message") {
 return messageToTextInternal(entry.message);
 }
 if (entry.type === "custom_message") {
 const c = entry.content;
 if (typeof c === "string") return c;
 if (Array.isArray(c)) {
 return c.map((p) => (typeof p === "string" ? p : p?.text ?? p?.content ?? "")).filter(Boolean).join("\n");
 }
 }
 return "";
}

function messageToTextInternal(msg: any): string {
 if (!msg) return "";
 const c = msg.content;
 if (typeof c === "string") return c;
 if (Array.isArray(c)) {
 return c.map((p) => (typeof p === "string" ? p : (p && typeof p === "object" ? (p.text ?? p.content ?? "") : ""))).filter(Boolean).join("\n");
 }
 return "";
}

function enforcePayloadSizeInternal(payload: string, maxBytes: number): string {
 if (Buffer.byteLength(payload, "utf8") <= maxBytes) return payload;
 const buf = Buffer.from(payload, "utf8");
 const sliced = buf.subarray(0, maxBytes).toString("utf8");
 const lastNewline = sliced.lastIndexOf("\n");
 const cut = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
 return cut + "\n\n[... payload clamped to " + maxBytes + " bytes ...]";
}

async function distillerAttemptOnce(
 opts: { baseUrl: string; apiKey: string; model: string; timeoutMs: number },
 payload: { slice: NeatSlice; activeFiles: ActiveFile[] },
 attempt: number,
): Promise<DistillerResponse> {
 const userContent = buildDistillerPayload(payload);
 const body = {
 model: opts.model,
 messages: [
 { role: "system", content: DISTILLER_SYSTEM_PROMPT },
 { role: "user", content: userContent },
 ],
 response_format: { type: "json_object" },
 temperature: 0,
 };

 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

 let res: Response;
 try {
 res = await fetch(opts.baseUrl + "/chat/completions", {
 method: "POST",
 headers: {
 "Content-Type": "application/json",
 Authorization: "Bearer " + opts.apiKey,
 },
 body: JSON.stringify(body),
 signal: controller.signal,
 });
 } catch (err) {
 clearTimeout(timer);
 const e = err as Error;
 if (e.name === "AbortError") {
 throw new Error("attempt " + attempt + ": timed out after " + opts.timeoutMs + "ms");
 }
 throw new Error("attempt " + attempt + ": network error: " + e.message);
 }
 clearTimeout(timer);

 if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
 throw new RetryableHttpError(res.status, res.statusText);
 }
 if (!res.ok) {
 const text = await res.text().catch(() => "");
 throw new Error("attempt " + attempt + ": HTTP " + res.status + ": " + text.slice(0, 500));
 }

 const parsed = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
 const content = parsed?.choices?.[0]?.message?.content;
 if (typeof content !== "string" || content.length === 0) {
 throw new Error("attempt " + attempt + ": empty content");
 }

 const cleaned = stripJsonFences(content);
 let json: unknown;
 try {
 json = JSON.parse(cleaned);
 } catch (err) {
 throw new Error("attempt " + attempt + ": JSON.parse failed: " + (err as Error).message);
 }
 return validateDistillerResponse(json);
}

/**
 * Background distillation call (Phase 5). Same retry/backoff policy as
 * the error auditor; throws VerifierUnavailableError when all retries
 * fail (caller should swallow — distillation is non-blocking).
 */
export async function invokeDistiller(opts: {
 cwd: string;
 slice: NeatSlice;
 activeFiles: ActiveFile[];
}): Promise<DistillerResponse> {
 const env = readEnv();
 const envOpts = { baseUrl: env.baseUrl, apiKey: env.apiKey, model: env.model, timeoutMs: env.timeoutMs };
 const backoffMs = [1000, 2000];
 let lastError: unknown = null;

 for (let attempt = 0; attempt <= env.retries; attempt++) {
 try {
 return await distillerAttemptOnce(envOpts, opts, attempt + 1);
 } catch (err) {
 lastError = err;
 const isRetryable =
 err instanceof RetryableHttpError ||
 (err instanceof Error && /timed out|network error|JSON\.parse failed/.test(err.message));
 if (!isRetryable || attempt >= env.retries) break;
 const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)];
 await sleep(delay);
 }
 }
 throw new VerifierUnavailableError(env.retries + 1, lastError);
}

/**
 * Send the neat slice to the Verifier and parse the strict JSON response,
 * with exponential backoff on retryable failures.
 */
export async function invokeVerifier(slice: NeatSlice): Promise<VerifierAudit> {
 const env = readEnv();
 const opts = { baseUrl: env.baseUrl, apiKey: env.apiKey, model: env.model, timeoutMs: env.timeoutMs };
 const backoffMs = [1000, 2000];
 let lastError: unknown = null;

 for (let attempt = 0; attempt <= env.retries; attempt++) {
 try {
 return await attemptOnce(slice, opts, attempt + 1);
 } catch (err) {
 lastError = err;
 const isRetryable =
 err instanceof RetryableHttpError ||
 (err instanceof Error && /timed out|network error|JSON\.parse failed/.test(err.message));
 if (!isRetryable || attempt >= env.retries) {
 break;
 }
 const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)];
 await sleep(delay);
 }
 }
 throw new VerifierUnavailableError(env.retries + 1, lastError);
}
// ============================================================================
// Reviewer (Phase 6): semantic / business-logic review triggered manually
// via /harvest review <feedback>. The code compiled, but the human flagged
// a missing piece of business logic. Same retry/backoff policy as the
// error auditor.
// ============================================================================

const REVIEWER_SYSTEM_PROMPT = [
 "You are a Staff Engineer conducting a code review.",
 "The junior worker model generated code that compiles successfully, but the human user has flagged a semantic, logical, or architectural omission.",
 "Review the active files against the human feedback.",
 "Identify exactly what the model missed, and provide concrete steering instructions to implement the missing logic.",
 "",
 "Output strictly in JSON with exactly these fields and no others:",
 JSON.stringify({
 flaw_category: "string - canonical category (e.g. SemanticLogicError, MissingStateHoisting, BusinessLogicOmission)",
 diagnosis: "string - what business logic or architecture the worker missed",
 steering_instructions: "string - concrete instructions to satisfy the human review",
 }, null, 2),
 "",
 "Return JSON only. Do not wrap it in markdown fences. Do not add prose.",
].join("\n");

export interface ReviewerResponse {
 flaw_category: string;
 diagnosis: string;
 steering_instructions: string;
}

export function validateReviewerResponse(value: unknown): ReviewerResponse {
 if (!value || typeof value !== "object" || Array.isArray(value)) {
 throw new Error("Reviewer response is not a JSON object");
 }
 const obj = value as Record<string, unknown>;
 if (typeof obj.diagnosis !== "string") {
 throw new Error("Reviewer response: diagnosis must be a string");
 }
 if (typeof obj.steering_instructions !== "string") {
 throw new Error("Reviewer response: steering_instructions must be a string");
 }
 if ("flaw_category" in obj && obj.flaw_category !== undefined && typeof obj.flaw_category !== "string") {
 throw new Error("Reviewer response: flaw_category must be a string when present");
 }
 return {
 flaw_category: typeof obj.flaw_category === "string" ? obj.flaw_category : "SemanticLogicError",
 diagnosis: obj.diagnosis,
 steering_instructions: obj.steering_instructions,
 };
}

export function buildReviewerPayload(opts: {
 slice: NeatSlice;
 activeFiles: ActiveFile[];
 humanFeedback: string;
}): string {
 const parts: string[] = [];
 parts.push("=== HUMAN FEEDBACK ===");
 parts.push(opts.humanFeedback || "(no feedback provided)");

 if (opts.activeFiles.length > 0) parts.push("\n=== ACTIVE FILES (under review) ===");
 for (const f of opts.activeFiles) {
 if (!f || typeof f !== "object") continue;
 const path = typeof f.path === "string" ? f.path : "?";
 const skipped = typeof f.skipped === "string" ? f.skipped : undefined;
 if (skipped) {
 parts.push("--- " + path + " ---");
 parts.push("(skipped: " + skipped + ")");
 continue;
 }
 const content = typeof f.content === "string" ? f.content : "";
 parts.push("--- " + path + " ---");
 parts.push(content || "(empty)");
 }
 if (opts.activeFiles.length === 0) parts.push("\n=== ACTIVE FILES ===\n(no active files captured)");

 if (opts.slice.inceptionPrompt) {
 parts.push("\n=== ORIGINAL TASK ===");
 parts.push(opts.slice.inceptionPrompt);
 }
 if (opts.slice.compilerError) {
 parts.push("\n=== RECENT COMPILER / TOOL OUTPUT (clamped) ===");
 parts.push(opts.slice.compilerError);
 }

 return enforcePayloadSizeInternal(parts.join("\n\n"), 64 * 1024);
}

async function reviewerAttemptOnce(
 opts: { baseUrl: string; apiKey: string; model: string; timeoutMs: number },
 payload: { slice: NeatSlice; activeFiles: ActiveFile[]; humanFeedback: string },
 attempt: number,
): Promise<ReviewerResponse> {
 const userContent = buildReviewerPayload(payload);
 const body = {
 model: opts.model,
 messages: [
 { role: "system", content: REVIEWER_SYSTEM_PROMPT },
 { role: "user", content: userContent },
 ],
 response_format: { type: "json_object" },
 temperature: 0,
 };

 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

 let res: Response;
 try {
 res = await fetch(opts.baseUrl + "/chat/completions", {
 method: "POST",
 headers: { "Content-Type": "application/json", Authorization: "Bearer " + opts.apiKey },
 body: JSON.stringify(body),
 signal: controller.signal,
 });
 } catch (err) {
 clearTimeout(timer);
 const e = err as Error;
 throw new Error(
 "attempt " + attempt + ": " + (e.name === "AbortError" ? "timed out after " + opts.timeoutMs + "ms" : "network error: " + e.message),
 );
 }
 clearTimeout(timer);

 if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
 throw new RetryableHttpError(res.status, res.statusText);
 }
 if (!res.ok) {
 const text = await res.text().catch(() => "");
 throw new Error("attempt " + attempt + ": HTTP " + res.status + ": " + text.slice(0, 500));
 }

 const parsed = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
 const content = parsed?.choices?.[0]?.message?.content;
 if (typeof content !== "string" || content.length === 0) {
 throw new Error("attempt " + attempt + ": empty content");
 }
 const cleaned = stripJsonFences(content);
 let json: unknown;
 try {
 json = JSON.parse(cleaned);
 } catch (err) {
 throw new Error("attempt " + attempt + ": JSON.parse failed: " + (err as Error).message);
 }
 return validateReviewerResponse(json);
}

export async function invokeReviewer(opts: {
 cwd: string;
 slice: NeatSlice;
 activeFiles: ActiveFile[];
 humanFeedback: string;
}): Promise<ReviewerResponse> {
 const env = readEnv();
 const envOpts = { baseUrl: env.baseUrl, apiKey: env.apiKey, model: env.model, timeoutMs: env.timeoutMs };
 const backoffMs = [1000, 2000];
 let lastError: unknown = null;

 for (let attempt = 0; attempt <= env.retries; attempt++) {
 try {
 return await reviewerAttemptOnce(envOpts, opts, attempt + 1);
 } catch (err) {
 lastError = err;
 const isRetryable =
 err instanceof RetryableHttpError ||
 (err instanceof Error && /timed out|network error|JSON\.parse failed/.test(err.message));
 if (!isRetryable || attempt >= env.retries) break;
 const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)];
 await sleep(delay);
 }
 }
 throw new VerifierUnavailableError(env.retries + 1, lastError);
}
// ============================================================================
// Opinion (Phase 8): proactive architectural review of WORKING code.
// Triggered manually via /harvest opinion [optional query]. Unlike an
// audit (which prunes the broken turn), an opinion is a forward-looking
// advisory steer — the trajectory is preserved because the working code
// is the "rejected" baseline we want to compare the refactor against.
// ============================================================================

const OPINION_SYSTEM_PROMPT = [
 "You are a Principal Software Architect proactively reviewing working code.",
 "The code compiles and the tests pass — but the human user has requested an architectural opinion, optimization, security review, or general improvement suggestions.",
 "Analyze the active files and trajectory. Provide concrete, actionable refactoring advice that elevates the working code to expert-grade.",
 "",
 "Output strictly in JSON with exactly these fields and no others:",
 JSON.stringify({
 opinion_summary: "string - 2-4 sentence diagnosis of the architectural smell or improvement opportunity",
 refactor_instructions: "string - concrete refactor steps the worker should apply (code shapes, library choices, patterns)",
 flaw_category: "string - one of {SuboptimalArchitecture, PerformanceBottleneck, SecurityRisk, ThreadingHazard, ErrorHandlingGap, ApiMisuse, TypeErosion, NamingConventionViolation, IdiomaticStructureViolation, MissingObservability}",
 }, null, 2),
 "",
 "Return JSON only. Do not wrap it in markdown fences. Do not add prose.",
].join("\n");

export interface OpinionResponse {
 opinion_summary: string;
 refactor_instructions: string;
 flaw_category: string;
}

export function validateOpinionResponse(value: unknown): OpinionResponse {
 if (!value || typeof value !== "object" || Array.isArray(value)) {
 throw new Error("Opinion response is not a JSON object");
 }
 const obj = value as Record<string, unknown>;
 if (typeof obj.opinion_summary !== "string") {
 throw new Error("Opinion response: opinion_summary must be a string");
 }
 if (typeof obj.refactor_instructions !== "string") {
 throw new Error("Opinion response: refactor_instructions must be a string");
 }
 if (typeof obj.flaw_category !== "string" || obj.flaw_category.length === 0) {
 throw new Error("Opinion response: flaw_category must be a non-empty string");
 }
 return {
 opinion_summary: obj.opinion_summary,
 refactor_instructions: obj.refactor_instructions,
 flaw_category: obj.flaw_category,
 };
}

export function buildOpinionPayload(opts: {
 slice: NeatSlice;
 activeFiles: ActiveFile[];
 optionalQuery: string;
}): string {
 const parts: string[] = [];
 parts.push("=== REVIEW REQUEST ===");
 if (opts.optionalQuery && opts.optionalQuery.trim().length > 0) {
 parts.push("The human user specifically asks: " + opts.optionalQuery);
 } else {
 parts.push("The human user has requested a general architectural / optimization review.");
 }

 if (opts.activeFiles.length > 0) parts.push("\n=== ACTIVE FILES (under review) ===");
 for (const f of opts.activeFiles) {
 if (!f || typeof f !== "object") continue;
 const path = typeof f.path === "string" ? f.path : "?";
 const skipped = typeof f.skipped === "string" ? f.skipped : undefined;
 if (skipped) {
 parts.push("--- " + path + " ---");
 parts.push("(skipped: " + skipped + ")");
 continue;
 }
 const content = typeof f.content === "string" ? f.content : "";
 parts.push("--- " + path + " ---");
 parts.push(content || "(empty)");
 }
 if (opts.activeFiles.length === 0) parts.push("\n=== ACTIVE FILES ===\n(no active files captured)");

 if (opts.slice.inceptionPrompt) {
 parts.push("\n=== ORIGINAL TASK ===");
 parts.push(opts.slice.inceptionPrompt);
 }
 if (opts.slice.failedCode) {
 parts.push("\n=== CURRENT CODE (under review) ===");
 parts.push(opts.slice.failedCode);
 }

 return enforcePayloadSizeInternal(parts.join("\n\n"), 64 * 1024);
}

async function opinionAttemptOnce(
 opts: { baseUrl: string; apiKey: string; model: string; timeoutMs: number },
 payload: { slice: NeatSlice; activeFiles: ActiveFile[]; optionalQuery: string },
 attempt: number,
): Promise<OpinionResponse> {
 const userContent = buildOpinionPayload(payload);
 const body = {
 model: opts.model,
 messages: [
 { role: "system", content: OPINION_SYSTEM_PROMPT },
 { role: "user", content: userContent },
 ],
 response_format: { type: "json_object" },
 temperature: 0,
 };

 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

 let res: Response;
 try {
 res = await fetch(opts.baseUrl + "/chat/completions", {
 method: "POST",
 headers: { "Content-Type": "application/json", Authorization: "Bearer " + opts.apiKey },
 body: JSON.stringify(body),
 signal: controller.signal,
 });
 } catch (err) {
 clearTimeout(timer);
 const e = err as Error;
 throw new Error(
 "attempt " + attempt + ": " + (e.name === "AbortError" ? "timed out after " + opts.timeoutMs + "ms" : "network error: " + e.message),
 );
 }
 clearTimeout(timer);

 if (res.status === 429 || res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
 throw new RetryableHttpError(res.status, res.statusText);
 }
 if (!res.ok) {
 const text = await res.text().catch(() => "");
 throw new Error("attempt " + attempt + ": HTTP " + res.status + ": " + text.slice(0, 500));
 }

 const parsed = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
 const content = parsed?.choices?.[0]?.message?.content;
 if (typeof content !== "string" || content.length === 0) {
 throw new Error("attempt " + attempt + ": empty content");
 }
 const cleaned = stripJsonFences(content);
 let json: unknown;
 try {
 json = JSON.parse(cleaned);
 } catch (err) {
 throw new Error("attempt " + attempt + ": JSON.parse failed: " + (err as Error).message);
 }
 return validateOpinionResponse(json);
}

export async function invokeOpinion(opts: {
 cwd: string;
 slice: NeatSlice;
 activeFiles: ActiveFile[];
 optionalQuery: string;
}): Promise<OpinionResponse> {
 const env = readEnv();
 const envOpts = { baseUrl: env.baseUrl, apiKey: env.apiKey, model: env.model, timeoutMs: env.timeoutMs };
 const backoffMs = [1000, 2000];
 let lastError: unknown = null;

 for (let attempt = 0; attempt <= env.retries; attempt++) {
 try {
 return await opinionAttemptOnce(envOpts, opts, attempt + 1);
 } catch (err) {
 lastError = err;
 const isRetryable =
 err instanceof RetryableHttpError ||
 (err instanceof Error && /timed out|network error|JSON\.parse failed/.test(err.message));
 if (!isRetryable || attempt >= env.retries) break;
 const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)];
 await sleep(delay);
 }
 }
 throw new VerifierUnavailableError(env.retries + 1, lastError);
}
