/**
 * Out-of-band Verifier HTTP call.
 *
 * Generic OpenAI-compatible `POST {baseUrl}/chat/completions`.
 * No hard-coded provider — `VERIFIER_BASE_URL`, `VERIFIER_API_KEY`,
 * `VERIFIER_MODEL` are all required env vars.
 *
 * Strict JSON response is enforced via a system prompt instruction +
 * the `response_format: { type: "json_object" }` hint where supported.
 */

import type { NeatSlice, VerifierAudit } from "./types.js";
import { serializeSliceForVerifier } from "./slice.js";

const REQUIRED_FIELDS: (keyof VerifierAudit)[] = [
 "inferred_subtask",
 "divergence_detected",
 "divergence_turn",
 "flaw_category",
 "root_cause",
 "discard_advice",
 "steering_instructions",
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
 divergence_turn: "integer (1-based) — the slice-relative turn number where the divergence began; 0 if no divergence",
 flaw_category: "string — one of {logic_error, misunderstood_spec, missing_knowledge, environmental, off_topic, none}",
 root_cause: "string — a single-sentence explanation of WHY the worker diverged",
 discard_advice: "string — short instruction for what context to remove or summarize",
 steering_instructions: "string — concise directive (max 8 sentences) telling the worker exactly how to recover",
 }, null, 2),
 "",
 "Return JSON only. Do not wrap it in markdown fences. Do not add prose.",
].join("\n");

function readEnv(): { baseUrl: string; apiKey: string; model: string; timeoutMs: number } {
 const baseUrl = process.env.VERIFIER_BASE_URL?.replace(/\/+$/, "") ?? "";
 const apiKey = process.env.VERIFIER_API_KEY ?? "";
 const model = process.env.VERIFIER_MODEL ?? "";
 const timeoutMs = Number(process.env.HARVEST_TIMEOUT_MS ?? "30000");
 if (!baseUrl) throw new Error("VERIFIER_BASE_URL is not set");
 if (!apiKey) throw new Error("VERIFIER_API_KEY is not set");
 if (!model) throw new Error("VERIFIER_MODEL is not set");
 if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
 throw new Error("HARVEST_TIMEOUT_MS must be a positive number");
 }
 return { baseUrl, apiKey, model, timeoutMs };
}

/**
 * Strip ```json ... ``` (or generic ``` ... ```) code fences that some
 * models wrap their JSON output in, even when instructed not to.
 */
export function stripJsonFences(raw: string): string {
 let s = raw.trim();
 // Match ```json ... ``` or ``` ... ```
 const fenceRe = /^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i;
 const m = s.match(fenceRe);
 if (m) s = m[1].trim();
 return s;
}

/**
 * Validate that an unknown JSON value conforms to the VerifierAudit
 * schema. Throws with a descriptive message on mismatch.
 */
export function validateAudit(value: unknown): VerifierAudit {
 if (!value || typeof value !== "object" || Array.isArray(value)) {
 throw new Error("Verifier response is not a JSON object");
 }
 const obj = value as Record<string, unknown>;
 for (const field of REQUIRED_FIELDS) {
 if (!(field in obj)) {
 throw new Error(`Verifier response missing required field: ${field}`);
 }
 }
 if (typeof obj.inferred_subtask !== "string") {
 throw new Error("Verifier response: inferred_subtask must be a string");
 }
 if (typeof obj.divergence_detected !== "boolean") {
 throw new Error("Verifier response: divergence_detected must be a boolean");
 }
 if (typeof obj.divergence_turn !== "number" || !Number.isFinite(obj.divergence_turn)) {
 throw new Error("Verifier response: divergence_turn must be a finite number");
 }
 for (const f of ["flaw_category", "root_cause", "discard_advice", "steering_instructions"] as const) {
 if (typeof obj[f] !== "string") {
 throw new Error(`Verifier response: ${f} must be a string`);
 }
 }
 return obj as unknown as VerifierAudit;
}

/**
 * Send the neat slice to the Verifier and parse the strict JSON response.
 */
export async function invokeVerifier(slice: NeatSlice): Promise<VerifierAudit> {
 const { baseUrl, apiKey, model, timeoutMs } = readEnv();
 const userContent = serializeSliceForVerifier(slice);

 const body = {
 model,
 messages: [
 { role: "system", content: SYSTEM_PROMPT },
 { role: "user", content: userContent },
 ],
 // Best-effort: providers that support it will honor JSON-mode strictly.
 response_format: { type: "json_object" },
 temperature: 0,
 };

 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), timeoutMs);

 let res: Response;
 try {
 res = await fetch(`${baseUrl}/chat/completions`, {
 method: "POST",
 headers: {
 "Content-Type": "application/json",
 Authorization: `Bearer ${apiKey}`,
 },
 body: JSON.stringify(body),
 signal: controller.signal,
 });
 } catch (err) {
 clearTimeout(timer);
 const e = err as Error;
 if (e.name === "AbortError") {
 throw new Error(`Verifier request timed out after ${timeoutMs}ms`);
 }
 throw new Error(`Verifier HTTP error: ${e.message}`);
 }
 clearTimeout(timer);

 if (!res.ok) {
 const text = await res.text().catch(() => "");
 throw new Error(`Verifier HTTP ${res.status}: ${text.slice(0, 500)}`);
 }

 const payload = (await res.json()) as {
 choices?: Array<{ message?: { content?: string } }>;
 };
 const content = payload?.choices?.[0]?.message?.content;
 if (typeof content !== "string" || content.length === 0) {
 throw new Error("Verifier response: empty content in choices[0].message.content");
 }

 const cleaned = stripJsonFences(content);
 let parsed: unknown;
 try {
 parsed = JSON.parse(cleaned);
 } catch (err) {
 throw new Error(
 `Verifier response: JSON.parse failed: ${(err as Error).message}; first 200 chars: ${cleaned.slice(0, 200)}`,
 );
 }

 return validateAudit(parsed);
}
