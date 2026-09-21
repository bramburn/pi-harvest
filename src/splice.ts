/**
 * Context Surgery: navigateTree (closest real analogue to "prune")
 * + sendUserMessage (the correct way to inject a steering string).
 */

import type { NeatSlice, VerifierAudit } from "./types.js";
import { entryIdForDivergenceTurn } from "./slice.js";

export interface SpliceResult {
 navigated: boolean;
 navigatedToEntryId: string | null;
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
}

export interface SpliceHost {
 sendUserMessage(
 content: string,
 options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
 ): void;
 navigateTree(
 targetId: string,
 options?: {
 summarize?: boolean;
 customInstructions?: string;
 replaceInstructions?: boolean;
 label?: string;
 },
 ): Promise<{ cancelled: boolean }>;
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
 pi: SpliceHost,
 _ctx: SpliceContext,
): Promise<SpliceResult> {
 const result: SpliceResult = {
 navigated: false,
 navigatedToEntryId: null,
 steeringInjected: false,
 };

 if (audit.divergence_detected) {
 const targetId = resolveDivergenceEntryId(audit, slice);
 if (targetId) {
 try {
 const nav = await pi.navigateTree(targetId, {
 summarize: true,
 customInstructions: audit.steering_instructions,
 });
 if (!nav.cancelled) {
 result.navigated = true;
 result.navigatedToEntryId = targetId;
 }
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 _ctx.ui?.notify?.("[Harvester] navigateTree failed: " + msg, "warn");
 }
 }
 }

 try {
 const body = buildSteeringBody(audit);
 pi.sendUserMessage(body, { deliverAs: "steer" });
 result.steeringInjected = true;
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 _ctx.ui?.notify?.("[Harvester] sendUserMessage failed: " + msg, "warn");
 }

 return result;
}
