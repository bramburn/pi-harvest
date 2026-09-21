/**
 * Out-of-band Verifier HTTP call (Phase 3).
 *
 * Generic OpenAI-compatible `POST {baseUrl}/chat/completions` with
 * exponential backoff (1s -> 2s) on 429/5xx and network timeouts.
 *
 * Throws VerifierUnavailableError when all retries are exhausted —
 * callers should catch and reset state rather than crash.
 */

import type { NeatSlice, VerifierAudit } from "./types.js";
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
 const timeoutMs = Number(process.env.HARVEST_TIMEOUT_MS ?? "30000");
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
