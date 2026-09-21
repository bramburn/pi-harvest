/**
 * Shared types for pi-harvest Phase 2.
 *
 * The SessionEntry shapes are kept loose because pi's exact entry-shape
 * unions are large; we narrow with small helper type-guards inside the
 * modules that consume them.
 */

export interface AgentMessagePart {
 type?: string;
 text?: string;
 content?: string | AgentMessagePart[];
 // Tool-call parts
 name?: string;
 input?: unknown;
}

export interface AgentMessage {
 role?: "user" | "assistant" | "tool" | "toolResult" | string;
 content?: string | AgentMessagePart[];
 toolName?: string;
 toolCallId?: string;
 // Anything else pi may attach
 [k: string]: unknown;
}

export interface SessionEntryBase {
 id: string;
 parentId: string | null;
 timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
 type: "message";
 message: AgentMessage;
}

export interface SessionCustomMessageEntry extends SessionEntryBase {
 type: "custom_message";
 customType: string;
 content: string | AgentMessagePart[];
 display?: boolean;
 details?: unknown;
}

export type SessionEntry = SessionMessageEntry | SessionCustomMessageEntry;

/**
 * Strict schema returned by the Verifier model.
 * Matches the spec — every field is required.
 */
export interface VerifierAudit {
 inferred_subtask: string;
 divergence_detected: boolean;
 divergence_turn: number;
 flaw_category: string;
 root_cause: string;
 discard_advice: string;
 steering_instructions: string;
}

/**
 * Result of extractNeatSlice.
 * - inceptionIndex: index into the active branch where the most recent
 * user message was found (the Inception Prompt).
 * - branchEntries: the active branch (oldest -> newest), same reference
 * passed in.
 * - sliceEntries: branchEntries.slice(inceptionIndex).
 * - failedCode: text of the most recent assistant message in the slice
 * (the worker's last code attempt before the audit was triggered).
 * - compilerError: text of the most recent bash tool result that matched
 * a compiler-failure signature.
 * - inceptionPrompt: text of the inception prompt (for DPO `immediate_prompt`).
 * - divergenceEntryId: id of the entry just before the divergence (for
 * navigateTree). null if no divergence / can't determine.
 */
export interface NeatSlice {
 inceptionIndex: number;
 branchEntries: SessionEntry[];
 sliceEntries: SessionEntry[];
 failedCode: string;
 compilerError: string;
 inceptionPrompt: string;
 divergenceEntryId: string | null;
}

/**
 * Flat DPO entry written to .pi/harvest/trajectories.jsonl.
 */
export interface DpoEntry {
 session_id: string;
 domain_tags: string[];
 k3_diagnosis: VerifierAudit;
 immediate_prompt: string;
 rejected_completion: string;
 chosen_completion: string;
 ts: string;
}
