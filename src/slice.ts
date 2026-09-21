/**
 * "Neat Slice" extractor + token guardrails.
 *
 * extractNeatSlice() walks the active branch backward to find the
 * Inception Prompt (most recent user message), slices from there to
 * the end, and pulls out the last assistant code + the last compiler
 * error from the last two turns of the slice.
 *
 * clampCompilerOutput() enforces a hard cap on bash stderr length so
 * the verifier payload never balloons.
 *
 * enforcePayloadSize() guards against 64KB / 16k-token payloads.
 *
 * No LLM calls — pure structural extraction.
 */

import { extractModifiedPaths } from "./workspace.js";
import type {
 AgentMessage,
 SessionEntry,
 NeatSlice,
} from "./types.js";

function isUserEntry(e: SessionEntry): e is SessionEntry & { message: AgentMessage } {
 if (e.type !== "message") return false;
 const role = (e.message as AgentMessage).role;
 return role === "user";
}

function isAssistantEntry(e: SessionEntry): e is SessionEntry & { message: AgentMessage } {
 if (e.type !== "message") return false;
 const role = (e.message as AgentMessage).role;
 return role === "assistant";
}

function isToolResultEntry(e: SessionEntry): boolean {
 if (e.type !== "message") {
 return false;
 }
 const role = (e.message as AgentMessage).role;
 return role === "tool" || role === "toolResult";
}

/**
 * Extract a string view of an agent message's content.
 */
export function messageToText(message: AgentMessage): string {
 const c = message.content;
 if (typeof c === "string") return c;
 if (Array.isArray(c)) {
 return c
 .map((p) => {
 if (typeof p === "string") return p;
 if (typeof p === "object" && p !== null) {
 const obj = p as { text?: string; content?: string };
 if (typeof obj.text === "string") return obj.text;
 if (typeof obj.content === "string") return obj.content;
 }
 return "";
 })
 .filter(Boolean)
 .join("\n");
 }
 return "";
}

export function entryToText(entry: SessionEntry): string {
 if (entry.type === "message") {
 return messageToText((entry as { message: AgentMessage }).message);
 }
 if (entry.type === "custom_message") {
 const c = (entry as { content?: string | unknown[] }).content;
 if (typeof c === "string") return c;
 if (Array.isArray(c)) {
 return c
 .map((p) => {
 if (typeof p === "string") return p;
 const obj = p as { text?: string; content?: string };
 return obj.text ?? obj.content ?? "";
 })
 .filter(Boolean)
 .join("\n");
 }
 }
 return "";
}

function extractBashOutput(entry: SessionEntry): string {
 if (entry.type === "message") {
 const msg = (entry as { message: AgentMessage }).message;
 const toolName = (msg.toolName ?? "").toLowerCase();
 if (toolName && toolName !== "bash" && toolName !== "run_shell" && toolName !== "shell") {
 return "";
 }
 return messageToText(msg);
 }
 return entryToText(entry);
}

function pickFailedCode(sliceEntries: SessionEntry[], lookback: number): string {
 const tail = sliceEntries.slice(-Math.max(1, lookback));
 for (let i = tail.length - 1; i >= 0; i--) {
 const e = tail[i];
 if (isAssistantEntry(e)) {
 const text = messageToText(e.message);
 if (text.trim().length > 0) return text;
 }
 }
 return "";
}

const SIGNATURES = [
 "error[e",
 "build failed",
 "error cs",
 "failed to compile",
 "tsc: error",
 "compilation failed",
];

function pickCompilerError(sliceEntries: SessionEntry[], lookback: number): string {
 const tail = sliceEntries.slice(-Math.max(1, lookback));
 for (let i = tail.length - 1; i >= 0; i--) {
 const e = tail[i];
 if (!isToolResultEntry(e)) continue;
 const text = extractBashOutput(e);
 if (!text) continue;
 const lower = text.toLowerCase();
 if (SIGNATURES.some((s) => lower.includes(s))) {
 return text;
 }
 }
 return "";
}

/**
 * Clamp compiler stderr to a verifier-friendly size.
 *
 * Strategy:
 * 1. Strip warning lines (noisy, low-signal).
 * 2. Keep lines that match error/panic/exception patterns, plus
 * surrounding context lines.
 * 3. Hard cap to `maxLines` total.
 * 4. Append a marker so the verifier knows it was truncated.
 */
export function clampCompilerOutput(rawStderr: string, maxLines: number = 50): string {
 if (!rawStderr) return "";
 const allLines = rawStderr.split(/\r?\n/);
 // Drop pure warning lines to keep signal high.
 const filtered = allLines.filter((l) => {
 const lower = l.toLowerCase();
 if (lower.includes("warning:") || lower.includes("warning[")) return false;
 // Drop very short noise lines (single char, etc.)
 if (l.trim().length === 0) return false;
 return true;
 });
 // Prefer error-ish lines plus 1 line of context above each.
 const errorishRe = /(error\b|error\[|failed to compile|exception|panic|traceback|fatal|\^)/i;
 const kept: string[] = [];
 let i = 0;
 while (i < filtered.length && kept.length < maxLines) {
 const line = filtered[i];
 if (errorishRe.test(line)) {
 if (kept.length > 0 && kept[kept.length - 1] !== filtered[i - 1]) {
 kept.push(filtered[i - 1]);
 }
 kept.push(line);
 if (i + 1 < filtered.length) {
 kept.push(filtered[i + 1]);
 }
 }
 i++;
 }
 let result = kept.join("\n");
 if (rawStderr.trim().length > 0 && (result.length < filtered.length || kept.length >= maxLines || result.length === 0)) {
 if (result.length > 0 && !result.endsWith("\n")) result += "\n";
 result += "[... compiler output clamped for harvest ...]";
 }
 return result;
}

/**
 * Enforce a hard byte cap on the verifier payload. Returns the
 * original string if within budget, or a clamped copy with a marker.
 */
export function enforcePayloadSize(payload: string, maxBytes: number = 64 * 1024): string {
 if (Buffer.byteLength(payload, "utf8") <= maxBytes) return payload;
 // Clamp by bytes (chop at the last newline before the limit).
 const buf = Buffer.from(payload, "utf8");
 const sliced = buf.subarray(0, maxBytes).toString("utf8");
 const lastNewline = sliced.lastIndexOf("\n");
 const cut = lastNewline > 0 ? sliced.slice(0, lastNewline) : sliced;
 return cut + "\n\n[... payload clamped to " + maxBytes + " bytes for harvest ...]";
}

/**
 * Extract the neat slice from the active branch.
 *
 * @param branchEntries - sessionManager.getBranch() output (oldest -> newest).
 * @param cwd - current working directory; used to collect modified paths.
 */
export function extractNeatSlice(branchEntries: SessionEntry[], cwd: string = ""): NeatSlice {
 if (!Array.isArray(branchEntries) || branchEntries.length === 0) {
 return {
 inceptionIndex: -1,
 branchEntries: branchEntries ?? [],
 sliceEntries: [],
 failedCode: "",
 compilerError: "",
 compilerErrorRaw: "",
 inceptionPrompt: "",
 modifiedPaths: [],
 divergenceEntryId: null,
 };
 }

 let inceptionIndex = -1;
 for (let i = branchEntries.length - 1; i >= 0; i--) {
 if (isUserEntry(branchEntries[i])) {
 inceptionIndex = i;
 break;
 }
 }

 const sliceEntries =
 inceptionIndex < 0 ? [...branchEntries] : branchEntries.slice(inceptionIndex);
 const inceptionPrompt = inceptionIndex >= 0 ? entryToText(branchEntries[inceptionIndex]) : "";

 const failedCode = pickFailedCode(sliceEntries, 2);
 const compilerErrorRaw = pickCompilerError(sliceEntries, 2);
 const compilerError = clampCompilerOutput(compilerErrorRaw, 50);

 const modifiedPaths = cwd ? extractModifiedPaths(sliceEntries, cwd) : [];

 return {
 inceptionIndex,
 branchEntries,
 sliceEntries,
 failedCode,
 compilerError,
 compilerErrorRaw,
 inceptionPrompt,
 modifiedPaths,
 divergenceEntryId: null,
 };
}

/**
 * Serialize a slice into a numbered transcript for the Verifier LLM.
 * Each entry is prefixed with `=== TURN <n> (type) ===` so the verifier
 * can identify which entry to flag as the divergence point.
 */
export function serializeSliceForVerifier(slice: NeatSlice): string {
 const lines: string[] = [];
 for (let i = 0; i < slice.sliceEntries.length; i++) {
 const entry = slice.sliceEntries[i];
 const role =
 entry.type === "message"
 ? ((entry as { message: AgentMessage }).message.role ?? entry.type)
 : entry.type;
 const text = entryToText(entry);
 // Each entry's text is already content; we don't apply clampCompilerOutput
 // here — the slice.compilerError is the curated version we send if needed.
 lines.push("=== TURN " + (i + 1) + " (" + role + ") ===");
 lines.push(text || "(empty)");
 lines.push("");
 }
 return lines.join("\n");
}

/**
 * Build the full user payload (transcript + summary) and apply the
 * 64KB clamp. Returns the final string ready to send to the verifier.
 */
export function buildVerifierPayload(slice: NeatSlice): string {
 const parts: string[] = [];
 if (slice.inceptionPrompt) {
 parts.push("=== INCEPTION PROMPT ===\n" + slice.inceptionPrompt);
 }
 if (slice.compilerError) {
 parts.push("=== COMPILER ERROR (clamped) ===\n" + slice.compilerError);
 }
 if (slice.failedCode) {
 parts.push("=== LAST ASSISTANT CODE ===\n" + slice.failedCode);
 }
 if (slice.modifiedPaths.length > 0) {
 parts.push("=== ACTIVE FILES ===\n" + slice.modifiedPaths.join("\n"));
 }
 parts.push("=== TRANSCRIPT ===\n" + serializeSliceForVerifier(slice));
 const joined = parts.join("\n\n");
 return enforcePayloadSize(joined, 64 * 1024);
}

/**
 * Map a slice-relative 1-based turn number from the verifier audit to an
 * entry id in the active branch. Returns null if out of range.
 *
 * Phase 3 prefers `divergence_turn_entry_id` returned directly by the
 * verifier; this helper is kept for the Phase 2 fallback path.
 */
export function entryIdForDivergenceTurn(
 slice: NeatSlice,
 divergenceTurn: number,
): string | null {
 if (!Number.isFinite(divergenceTurn) || divergenceTurn < 1) return null;
 const idx = Math.min(divergenceTurn - 1, slice.sliceEntries.length - 1);
 const entry = slice.sliceEntries[idx];
 return entry?.id ?? null;
}

/**
 * Extract the raw text output from a pi ToolResultEvent.
 *
 * Real pi's ToolResultEvent carries the bash output in
 * `content: Array<TextContent | ImageContent>` where each text part
 * has `.text`. Earlier versions of pi (and many tests) used a
 * legacy `{ output, stdout, stderr }` shape on the top level. This
 * helper accepts both so the tool_result handler can stay
 * forward-compatible with real pi while still working with the
 * existing test mock.
 *
 * Returns an empty string when no recognisable text can be extracted.
 */
export function extractToolResultText(event: unknown): string {
 if (!event || typeof event !== "object") return "";
 const e = event as {
 content?: unknown;
 output?: unknown;
 stdout?: unknown;
 stderr?: unknown;
 };
 const content = e.content;
 if (typeof content === "string") return content;
 if (Array.isArray(content)) {
 return content
 .map((p) => {
 if (typeof p === "string") return p;
 if (p && typeof p === "object") {
 const t = (p as { text?: unknown }).text;
 if (typeof t === "string") return t;
 }
 return "";
 })
 .filter((s) => s.length > 0)
 .join("\n");
 }
 const legacy = [e.output, e.stdout, e.stderr]
 .filter((s): s is string => typeof s === "string")
 .join("\n");
 return legacy;
}
