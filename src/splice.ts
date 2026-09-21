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

/**
 * Minimal interface we depend on from the pi host. The full ExtensionAPI
 * union is large; only the methods we actually use are typed here.
 */
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
 /**
 * pi.sendUserMessage(string, { deliverAs: "steer" }) — injects a user
 * message into the running agent as a steering directive.
 */
 sendUserMessage(
 content: string,
 options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean },
 ): void;
 /**
 * pi.navigateTree(targetId, { summarize }) — rewind to a prior entry;
 * `summarize: true` collapses the discarded branch into a compaction
 * summary so context stays bounded.
 */
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
 lines.push(`Subtask: ${audit.inferred_subtask}`);
 if (audit.divergence_detected) {
 lines.push(`Flaw: ${audit.flaw_category} — ${audit.root_cause}`);
 lines.push(`Fix: ${audit.steering_instructions}`);
 if (audit.discard_advice) {
 lines.push(`Discard: ${audit.discard_advice}`);
 }
 } else {
 // No divergence detected — still acknowledge the audit so the worker
 // knows it was reviewed and continue without major rewrites.
 lines.push(`Status: no divergence detected by auditor`);
 lines.push(`Fix: ${audit.steering_instructions}`);
 }
 return lines.join("\n");
}

/**
 * Perform the splice:
 * 1. If divergence_detected: rewind via navigateTree to the entry just
 * before the divergence, collapsing the discarded branch into a summary.
 * 2. Inject the steering message via sendUserMessage.
 *
 * Safe to call when divergence_detected is false — the rewind is
 * skipped but steering is still injected.
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
 const targetId = entryIdForDivergenceTurn(slice, audit.divergence_turn);
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
 // Don't fail the whole splice on a navigation error — at least
 // inject the steering message so the worker can self-correct.
 const msg = (err as Error)?.message ?? String(err);
 _ctx.ui?.notify?.(`[Harvester] navigateTree failed: ${msg}`, "warn");
 }
 }
 }

 // Always inject the steering message. sendUserMessage with
 // deliverAs: "steer" is the supported way to push a directive into
 // a running agent without blocking its current stream.
 try {
 const body = buildSteeringBody(audit);
 pi.sendUserMessage(body, { deliverAs: "steer" });
 result.steeringInjected = true;
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 _ctx.ui?.notify?.(`[Harvester] sendUserMessage failed: ${msg}`, "warn");
 }

 return result;
}
