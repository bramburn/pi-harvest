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
import { entryIdForDivergenceTurn } from "./slice.js";

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
 * Build the steering message body. Keeps the spec's exact format so the
 * worker can grep for `[STEER:K3]` in its own output.
 */
function buildSteeringBody(audit: VerifierAudit): string {
 const lines: string[] = [];
 lines.push("[STEER:K3]");
 lines.push("Subtask: " + audit.inferred_subtask);
 if (audit.divergence_detected) {
 lines.push("Flaw: " + audit.flaw_category + " — " + audit.root_cause);
 lines.push("Fix: " + audit.steering_instructions);
 if (audit.discard_advice) {
 lines.push("Discard: " + audit.discard_advice);
 }
 } else {
 lines.push("Status: no divergence detected by auditor");
 lines.push("Fix: " + audit.steering_instructions);
 }
 if (audit.domain_tags && audit.domain_tags.length > 0) {
 lines.push("Domain: " + audit.domain_tags.join(", "));
 }
 return lines.join("\n");
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
 const body = buildSteeringBody(audit);
 host.sendUserMessage(body, { deliverAs: "steer" });
 result.steeringInjected = true;
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 ctx.ui?.notify?.("[Harvester] sendUserMessage failed: " + msg, "warn");
 }

 return result;
}
