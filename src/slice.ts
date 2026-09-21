/**
 * "Neat Slice" extractor.
 *
 * Walks the active branch backward to find the most recent user message
 * (the Inception Prompt), slices from there to the end, and pulls out
 * the last assistant code + the last compiler error from the last two
 * turns of the slice.
 *
 * No LLM calls — pure structural extraction.
 */

import type {
 AgentMessage,
 SessionEntry,
 NeatSlice,
} from "./types.js";

/**
 * Detect a user-authored entry. pi represents all chat messages with
 * `type: "message"`; user vs assistant is on the inner `message.role`.
 */
function isUserEntry(e: SessionEntry): e is SessionEntry & { message: AgentMessage } {
 if (e.type !== "message") return false;
 const role = (e.message as AgentMessage).role;
 return role === "user";
}

/**
 * Detect an assistant-authored entry.
 */
function isAssistantEntry(e: SessionEntry): e is SessionEntry & { message: AgentMessage } {
 if (e.type !== "message") return false;
 const role = (e.message as AgentMessage).role;
 return role === "assistant";
}

/**
 * Detect a tool-result entry (compiler error output lives here).
 * pi uses `type: "message"` with `role: "tool"` or `role: "toolResult"`,
 * and `custom_message` entries for some flows.
 */
function isToolResultEntry(e: SessionEntry): boolean {
 if (e.type === "message") {
 const role = (e.message as AgentMessage).role;
 return role === "tool" || role === "toolResult";
 }
 // custom_message entries can also carry tool-like payloads but we
 // treat only role-tagged tool results as compiler-error sources.
 return false;
}

/**
 * Extract a string view of an agent message's content. Handles both
 * the simple-string form and the content-parts array form.
 */
export function messageToText(message: AgentMessage): string {
 const c = message.content;
 if (typeof c === "string") return c;
 if (Array.isArray(c)) {
 return c
 .map((p) => {
 if (typeof p === "string") return p;
 if (typeof p?.text === "string") return p.text;
 if (typeof p?.content === "string") return p.content;
 return "";
 })
 .filter(Boolean)
 .join("\n");
 }
 return "";
}

/**
 * Extract a string view of an entry's payload (handles custom_message entries too).
 */
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

/**
 * Find the bash tool result content from a tool-result entry.
 */
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

/**
 * Find the assistant message with the most code content in the last
 * `lookback` entries of the slice. Falls back to the most recent
 * assistant message if none has obviously "code-y" content.
 */
function pickFailedCode(sliceEntries: SessionEntry[], lookback: number): string {
 const tail = sliceEntries.slice(-Math.max(1, lookback));
 // Walk tail backward to find an assistant message
 for (let i = tail.length - 1; i >= 0; i--) {
 const e = tail[i];
 if (isAssistantEntry(e)) {
 const text = messageToText(e.message);
 if (text.trim().length > 0) return text;
 }
 }
 return "";
}

/**
 * Find the last bash tool result in the tail of the slice that matches
 * a compiler-failure signature.
 */
function pickCompilerError(sliceEntries: SessionEntry[], lookback: number): string {
 // Reuse the Phase-1 signature set for consistency.
 const SIGNATURES = [
 "error[e",
 "build failed",
 "error cs",
 "failed to compile",
 "tsc: error",
 "compilation failed",
 ];
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
 * Extract the neat slice from the active branch.
 *
 * @param branchEntries - sessionManager.getBranch() output (oldest -> newest).
 */
export function extractNeatSlice(branchEntries: SessionEntry[]): NeatSlice {
 if (!Array.isArray(branchEntries) || branchEntries.length === 0) {
 return {
 inceptionIndex: -1,
 branchEntries: branchEntries ?? [],
 sliceEntries: [],
 failedCode: "",
 compilerError: "",
 inceptionPrompt: "",
 divergenceEntryId: null,
 };
 }

 // Walk BACKWARD to find the most recent user entry.
 let inceptionIndex = -1;
 for (let i = branchEntries.length - 1; i >= 0; i--) {
 if (isUserEntry(branchEntries[i])) {
 inceptionIndex = i;
 break;
 }
 }

 if (inceptionIndex < 0) {
 // No user message in the branch at all — degenerate session.
 return {
 inceptionIndex: -1,
 branchEntries,
 sliceEntries: [...branchEntries],
 failedCode: pickFailedCode(branchEntries, 2),
 compilerError: pickCompilerError(branchEntries, 2),
 inceptionPrompt: "",
 divergenceEntryId: null,
 };
 }

 const sliceEntries = branchEntries.slice(inceptionIndex);
 const inceptionPrompt = entryToText(branchEntries[inceptionIndex]);

 return {
 inceptionIndex,
 branchEntries,
 sliceEntries,
 failedCode: pickFailedCode(sliceEntries, 2),
 compilerError: pickCompilerError(sliceEntries, 2),
 inceptionPrompt,
 divergenceEntryId: null, // populated by splice.ts once we have the audit
 };
}

/**
 * Serialize a slice into a numbered transcript for the Verifier LLM.
 * Each entry is prefixed with `=== TURN <n> (type) ===` so the verifier
 * can identify which entry to flag as the divergence point.
 *
 * @returns a multi-line string the verifier can read.
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
 lines.push(`=== TURN ${i + 1} (${role}) ===`);
 lines.push(text || "(empty)");
 lines.push("");
 }
 return lines.join("\n");
}

/**
 * Map a slice-relative 1-based turn number from the verifier audit to an
 * entry id in the active branch. Returns null if out of range.
 *
 * The verifier's `divergence_turn` is 1-based and relative to the slice
 * (turn 1 = sliceEntries[0], which is the inception prompt).
 *
 * For navigateTree, we want the entry JUST BEFORE the divergence, so
 * divergence_turn=1 means "no preceding entry" and we navigate to
 * sliceEntries[0].id (the inception prompt itself).
 */
export function entryIdForDivergenceTurn(
 slice: NeatSlice,
 divergenceTurn: number,
): string | null {
 if (!Number.isFinite(divergenceTurn) || divergenceTurn < 1) return null;
 // We want to navigate to the entry just before divergence, i.e.
 // sliceEntries[divergenceTurn - 1] (the bad entry itself) so it
 // becomes a sibling of the new branch. The verifier-relative
 // turn count starts at 1 for the inception prompt.
 const idx = Math.min(divergenceTurn - 1, slice.sliceEntries.length - 1);
 const entry = slice.sliceEntries[idx];
 return entry?.id ?? null;
}
