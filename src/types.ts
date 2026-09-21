/**
 * Shared types for pi-harvest Phase 3.
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
 // Tool results
 toolName?: string;
 toolCallId?: string;
 // ToolCall shape from @earendil-works/pi-ai
 arguments?: Record<string, unknown>;
 id?: string;
 // Anything else pi may attach
 [k: string]: unknown;
}

export interface AgentMessage {
 role?: "user" | "assistant" | "tool" | "toolResult" | string;
 content?: string | AgentMessagePart[];
 toolName?: string;
 toolCallId?: string;
 // pi's AssistantMessage has provider/model
 provider?: string;
 model?: string;
 modelId?: string;
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
 * Strict schema returned by the Verifier model (Phase 3).
 *
 * `domain_tags` is new in Phase 3 — the verifier is asked to return
 * canonical tags (rust, typescript, shopify, etc.). When empty, we
 * infer them locally from file extensions on disk.
 *
 * `divergence_turn_entry_id` replaces Phase 2's `divergence_turn`
 * — the verifier returns the actual entry id directly so we no longer
 * need the turn→id mapping step on our side.
 *
 * `divergence_turn` is still tolerated for backward compat with any
 * v0.2.0 auditors; if absent we rely on `divergence_turn_entry_id`.
 */
export interface VerifierAudit {
 inferred_subtask: string;
 divergence_detected: boolean;
 divergence_turn?: number;
 divergence_turn_entry_id?: string;
 flaw_category: string;
 root_cause: string;
 discard_advice: string;
 steering_instructions: string;
 domain_tags: string[];
}

/**
 * Result of extractNeatSlice.
 */
export interface NeatSlice {
 inceptionIndex: number;
 branchEntries: SessionEntry[];
 sliceEntries: SessionEntry[];
 failedCode: string;
 compilerError: string;
 compilerErrorRaw: string;
 inceptionPrompt: string;
 modifiedPaths: string[];
 divergenceEntryId: string | null;
}

/**
 * A snapshot of an active file at harvest time. `truncated` signals
 * to downstream consumers that `content` was clamped.
 */
export interface ActiveFile {
 path: string;
 content: string;
 truncated: boolean;
 skipped?: "missing" | "binary" | "lockfile" | "hidden" | "too_large" | "read_error";
 skipReason?: string;
}

/**
 * Flat DPO/SFT record written to .pi/harvest/trajectories.jsonl.
 * Phase 3 schema — supersedes the Phase 2 DpoEntry.
 */
export interface HarvestedTrajectoryRecord {
 session_id: string;
 timestamp: string;
 worker_model: string;
 verifier_model: string;
 trigger_reason: "compiler_streak" | "periodic_turn" | "manual" | "thrashing_distillation" | "semantic_review" | "architectural_opinion";
 domain_tags: string[];
 immediate_prompt: string;
 active_files: ActiveFile[];
 compiler_error_summary: string;
 git_diff_summary: string | null;
 k3_audit: {
 divergence_entry_id: string | null;
 flaw_category: string;
 root_cause: string;
 steering_instructions: string;
 };
 rejected_completion: string;
 chosen_completion: string;
 human_feedback: string | null;
}

/**
 * SFT Golden Record (Phase 7): passively captured when the worker
 * completes a task in 1 or 2 turns with no compile failures or audit
 * in flight. No Verifier call; local extraction only.
 *
 * Distinct from HarvestedTrajectoryRecord in that there is no
 * `rejected_completion` (nothing was rejected), no `k3_audit`, and no
 * `compiler_error_summary` (nothing failed). It is the *positive*
 * training signal.
 */
export interface GoldenSFTRecord {
 session_id: string;
 timestamp: string;
 worker_model: string;
 domain_tags: string[];
 immediate_prompt: string;
 active_files: Array<{ path: string; content: string }>;
 git_diff_summary: string | null;
 chosen_completion: string;
}

/**
 * Thrown by invokeVerifier() when all retry attempts are exhausted.
 * Callers should catch this and reset their streak rather than
 * crashing or re-throwing.
 */
export class VerifierUnavailableError extends Error {
 constructor(
 public readonly attempts: number,
 public readonly cause: unknown,
 ) {
 super(`Verifier unavailable after ${attempts} attempts: ${(cause as Error)?.message ?? String(cause)}`);
 this.name = "VerifierUnavailableError";
 }
}
