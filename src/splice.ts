/**
 * Context Surgery: navigateTree (only available in command-handler
 * contexts in real pi runtimes) + sendUserMessage (always available on
 * the extension API).
 *
 * NOTE on navigateTree availability: pi's ExtensionAPI (the `pi` object
 * passed to extensions) does NOT expose navigateTree. The method lives
 * on ExtensionCommandContextActions, which is only passed to slash
 * command handlers and to withSession() callbacks. Event handlers
 * (turn_end, tool_result) receive an ExtensionContext that does not
 * have it.
 *
 * SpliceHost therefore makes navigateTree OPTIONAL. Callers from
 * command handlers (runReview, runOpinion, /harvest audit) pass a
 * navigateTree function; callers from event handlers (the auto-audit
 * trigger in turn_end) pass null and the rewind is silently skipped.
 */

import type { NeatSlice, VerifierAudit } from "./types.js";
import { entryIdForDivergenceTurn, enforcePayloadSize } from "./slice.js";

/**
 * Extra context for the steering body that the verifier response does
 * not carry: the command that produced the compiler failure (so the
 * worker knows exactly how to verify its fix) and the slice's compiler
 * error / modified-paths.
 */
export interface SteeringContext {
 /** Bash command line that last produced a compiler failure, if known. */
 failedCommand?: string;
 /** Optional alert-type sub-label, e.g. "SEMANTIC REVIEW". */
 subLabel?: string;
}

/**
 * Resolve the Tier-3 steer provider tag from the environment.
 * VERIFIER_PROVIDER selects the commander (default k3, "deepseek" is
 * the documented fallback); the value is uppercased and sanitized so
 * the tag stays a single greppable token.
 */
export function steerProviderTag(): string {
 const raw = (process.env.VERIFIER_PROVIDER ?? "k3").trim().toUpperCase();
 const sanitized = raw.replace(/[^A-Z0-9_-]/g, "");
 return sanitized.length > 0 ? sanitized : "K3";
}

/**
 * The canonical Tier-3 prefix for every synthetic steering message:
 * [STEER:<PROVIDER>] with an optional [TYPE] sub-label, e.g.
 * [STEER:K3][SEMANTIC REVIEW]. Downstream slicers classify any message
 * starting with "[STEER:" as Tier 3 (supervisor), never a user prompt.
 */
export function steerPrefix(subLabel?: string): string {
 const sub = subLabel?.trim();
 return "[STEER:" + steerProviderTag() + "]" + (sub ? "[" + sub + "]" : "");
}

/**
 * Format the "Files:" line for a steering body. Returns null when there
 * is nothing worth telling the worker to rewrite.
 */
export function buildFilesLine(paths: readonly string[]): string | null {
 if (!paths || paths.length === 0) return null;
 const MAX = 5;
 if (paths.length <= MAX) return "Files: rewrite " + paths.join(", ");
 return "Files: rewrite " + paths.slice(0, MAX).join(", ") + " (+" + (paths.length - MAX) + " more)";
}

export interface SpliceResult {
 navigated: boolean;
 navigatedToEntryId: string | null;
 navigationSkippedReason: "no-navigateTree" | "no-divergence" | "no-target" | "cancelled" | null;
 steeringInjected: boolean;
}

export interface SpliceContext {
 sessionManager: {
 getSessionId(): string;
 };
 ui?: {
 notify?: (message: string, level?: string) => void;
 setStatus?: (key: string, content: unknown) => void;
 };
 // Permit extra fields (cwd, model, navigateTree, ...) so callers can
 // pass a real ExtensionContext / ExtensionCommandContext without casts.
 [key: string]: unknown;
}

export interface SpliceHost {
 sendUserMessage(
 content: string,
 options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
 ): void;
 /**
 * Optional navigateTree. Pass null when called from an event handler
 * (ExtensionContext does not include this method).
 */
 navigateTree?: (
 targetId: string,
 options?: {
 summarize?: boolean;
 customInstructions?: string;
 replaceInstructions?: boolean;
 label?: string;
 },
 ) => Promise<{ cancelled: boolean }>;
}

/**
 * Build the steering message body. The first line is always the
 * canonical Tier-3 prefix (see steerPrefix) so the worker — and any
 * downstream slicer — can grep for `[STEER:` to recognize a supervisor
 * intervention.
 *
 * Enriched beyond the bare audit fields (steering-quality hardening):
 * - Error: the clamped compiler stderr, so the worker connects the fix
 *   to the failure without re-running the build first.
 * - Verify: the exact command to run to confirm the fix, when the
 *   failing command line was captured from tool_result events.
 * - Files: the files the worker has been editing, so it rewrites the
 *   right ones instead of patching across stale context.
 * The final body is hard-clamped to 16 KB.
 */
/**
 * Build the steering message body. Exported for unit tests; production
 * callers go through performSplice().
 */
export function buildSteeringBody(audit: VerifierAudit, slice: NeatSlice, steerCtx?: SteeringContext): string {
 const lines: string[] = [];
 lines.push(steerPrefix(steerCtx?.subLabel));
 lines.push("Subtask: " + audit.inferred_subtask);
 if (audit.divergence_detected) {
 lines.push("Flaw: " + audit.flaw_category + " — " + audit.root_cause);
 if (slice.compilerError) {
 // Indent continuation lines so the error block stays readable.
 lines.push("Error: " + slice.compilerError.split("\n").join("\n  "));
 }
 lines.push("Fix: " + audit.steering_instructions);
 if (audit.discard_advice) {
 lines.push("Discard: " + audit.discard_advice);
 }
 } else {
 lines.push("Status: no divergence detected by auditor");
 lines.push("Fix: " + audit.steering_instructions);
 }
 const failedCommand = steerCtx?.failedCommand?.trim();
 if (failedCommand) {
 lines.push("Verify: run `" + failedCommand + "` and confirm it exits clean.");
 }
 const filesLine = buildFilesLine(slice.modifiedPaths);
 if (filesLine) {
 lines.push(filesLine);
 }
 if (audit.domain_tags && audit.domain_tags.length > 0) {
 lines.push("Domain: " + audit.domain_tags.join(", "));
 }
 return enforcePayloadSize(lines.join("\n"), 16 * 1024);
}

/**
 * Resolve the target entry id for navigateTree from the audit response.
 *
 * Phase 3 prefers `divergence_turn_entry_id` (returned by the verifier
 * directly). Falls back to computing from `divergence_turn` for any
 * v0.2.0 auditors still in circulation.
 */
function resolveDivergenceEntryId(audit: VerifierAudit, slice: NeatSlice): string | null {
 if (typeof audit.divergence_turn_entry_id === "string" && audit.divergence_turn_entry_id.length > 0) {
 return audit.divergence_turn_entry_id;
 }
 if (typeof audit.divergence_turn === "number") {
 return entryIdForDivergenceTurn(slice, audit.divergence_turn);
 }
 return null;
}

/**
 * Perform the splice.
 */
export async function performSplice(
 audit: VerifierAudit,
 slice: NeatSlice,
 host: SpliceHost,
 ctx: SpliceContext,
 steerCtx?: SteeringContext,
): Promise<SpliceResult> {
 const result: SpliceResult = {
 navigated: false,
 navigatedToEntryId: null,
 navigationSkippedReason: null,
 steeringInjected: false,
 };

 if (!audit.divergence_detected) {
 result.navigationSkippedReason = "no-divergence";
 } else {
 const targetId = resolveDivergenceEntryId(audit, slice);
 if (!targetId) {
 result.navigationSkippedReason = "no-target";
 } else if (!host.navigateTree) {
 // Event handlers (turn_end, tool_result) don't expose navigateTree on
 // the ExtensionContext. Skip the rewind gracefully — the steering
 // message will still land via sendUserMessage below.
 result.navigationSkippedReason = "no-navigateTree";
 ctx.ui?.notify?.(
 "[Harvester] Rewind skipped: navigateTree only available in command-handler contexts; proceeding with steer-only splice.",
 "info",
 );
 } else {
 try {
 const nav = await host.navigateTree(targetId, {
 summarize: true,
 customInstructions: audit.steering_instructions,
 });
 if (nav.cancelled) {
 result.navigationSkippedReason = "cancelled";
 } else {
 result.navigated = true;
 result.navigatedToEntryId = targetId;
 }
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 ctx.ui?.notify?.("[Harvester] navigateTree failed: " + msg, "warn");
 }
 }
 }

 try {
 const body = buildSteeringBody(audit, slice, steerCtx);
 host.sendUserMessage(body, { deliverAs: "steer" });
 result.steeringInjected = true;
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 ctx.ui?.notify?.("[Harvester] sendUserMessage failed: " + msg, "warn");
 }

 return result;
}
