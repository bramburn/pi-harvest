/**
 * pi-harvest — Phase 1 + Phase 2 + Phase 3 + Phase 4.
 *
 * Phase 1: telemetry hooks, TUI status widget, streak detection.
 * Phase 2: Neat Slice, verifier call, navigateTree+sendUserMessage splice,
 *          DPO sink write.
 * Phase 3: workspace capture, domain taxonomy, token clamps, verifier
 *          retries with backoff, full HarvestedTrajectoryRecord schema,
 *          /harvest status + /harvest audit slash commands.
 * Phase 4: monthly log rotation, git diff capture, native HF DPO
 *          exporter, telemetry aggregation (Top-N flaw categories).
 *
 * State machine (formalised):
 *   idle  --(threshold trips)-->  auditing
 *   auditing --(success)-->  awaiting_resolution
 *   auditing --(network failure / exception)-->  idle  (streak reset to 0)
 *   awaiting_resolution --(streak drops to 0)-->  idle  (DPO written)
 *
 * The state guard in turn_end (`if (state === "idle")`) prevents the
 * loop from re-triggering while a previous audit is still in flight
 * or waiting for resolution. Network failures fall through the catch
 * + finally blocks of runAudit() and reset state to idle so the user
 * is never permanently blocked by a flaky verifier endpoint.
 */

import { writeDpoEntry, getSinkStats, currentSinkPath } from "./sink.js";
import { extractNeatSlice, messageToText } from "./slice.js";
import { invokeVerifier, invokeDistiller, invokeReviewer } from "./verifier.js";
import { performSplice } from "./splice.js";
import { captureActiveFileStates, extractGitDiff, inferDomainTags } from "./workspace.js";
import { exportToHuggingFaceDPO } from "./exporter.js";
import { aggregateTelemetry, formatTelemetryForNotify } from "./telemetry.js";
import type {
 ActiveFile,
 NeatSlice,
 SessionEntry,
 VerifierAudit,
 VerifierUnavailableError,
} from "./types.js";

// ---------------------------------------------------------------------------
// Minimal runtime interfaces (declared locally so the package builds
// without depending on pi's typings).
// ---------------------------------------------------------------------------

interface UiHelpers {
 setStatus?(key: string, content: unknown): void;
 notify?(message: string, level?: string): void;
}

interface PiContext {
 ui: UiHelpers;
 cwd: string;
 model?: { id?: string; name?: string; provider?: string } | undefined;
 sessionManager: {
 getBranch(): SessionEntry[];
 getSessionId(): string;
 };
 [key: string]: unknown;
}

/**
 * Loose shape for the per-tool results bundled into a TurnEndEvent.
 * The full ToolResultMessage type lives in @earendil-works/pi-ai.
 */
interface LooseToolResult {
 toolName?: string;
 toolCallId?: string;
 details?: unknown;
 content?: Array<{ type?: string; text?: string }> | string;
 isError?: boolean;
}

interface ExtensionAPI {
 on(event: "tool_result", handler: (event: unknown, ctx: PiContext) => void | Promise<void>): void;
 on(event: "turn_end", handler: (event: unknown, ctx: PiContext) => void | Promise<void>): void;
 on(event: string, handler: (...args: unknown[]) => void | Promise<void>): void;

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

 registerCommand(
 name: string,
 options: {
 description?: string;
 handler: (args: string, ctx: PiContext) => Promise<void> | void;
 },
 ): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPILER_FAILURE_SIGNATURES: readonly string[] = [
 "error[e",
 "build failed",
 "error cs",
 "failed to compile",
 "tsc: error",
 "compilation failed",
];

const SIGNATURE_REGEX = new RegExp(
 COMPILER_FAILURE_SIGNATURES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
 "i",
);

const TURN_INTERVAL = Number(process.env.HARVEST_TURN_INTERVAL ?? "30");
const STREAK_THRESHOLD = Number(process.env.HARVEST_STREAK_THRESHOLD ?? "3");
const THRASHING_THRESHOLD = Number(process.env.HARVEST_THRASHING_THRESHOLD ?? "6");
const STATUS_KEY = "harvester";

type HarvesterState = "idle" | "auditing" | "awaiting_resolution";
type TriggerReason = "compiler_streak" | "periodic_turn" | "manual" | "thrashing_distillation" | "semantic_review";

// ---------------------------------------------------------------------------
// Extension entry
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
 let turnCounter = 0;
 let compilerFailStreak = 0;
 let harvestCount = 0;
 let state: HarvesterState = "idle";
 let lastTriggerReason: TriggerReason = "compiler_streak";
 let lastAuditedTurn = 0; // turn counter at the most recent audit trigger

 let lastAudit: VerifierAudit | null = null;
 let lastReviewFeedback: string | null = null;
 let lastSlice: NeatSlice | null = null;
 let lastActiveFiles: ActiveFile[] = [];
 let lastRejected: string = "";
 let lastDivergenceEntryId: string | null = null;
 let lastGitDiffSummary: string | null = null;
 let auditInFlight: Promise<void> | null = null;

 // Phase 5: thrashing streak counter — number of consecutive turn_ends
 // where (a) toolResults.length >= THRASHING_THRESHOLD, (b) the final tool
 // result was a clean bash success, AND (c) at least one file was edited
 // 2+ times during the turn (rework signal — the mitigation for the
 // failing criterion about planned scaffolding). Resets when any of the
 // three conditions fail.
 let thrashingStreak = 0;
 // Captured text for the active thrash window — concatenated assistant
 // messages across the streak, used as `rejected_completion` in the
 // eventual distillation DPO record.
 let thrashingRejectedText = "";
 let distillationInFlight: Promise<void> | null = null;

 // -------------------------------------------------------------------------
 // Helpers
 // -------------------------------------------------------------------------

 function renderStatus(): string {
 return (
 "[Harvester] Turn: " +
 turnCounter +
 " | Streak: " +
 compilerFailStreak +
 " | Harvests: " +
 harvestCount +
 " | State: " +
 state +
 (lastAuditedTurn > 0 ? " | LastAudit: " + lastAuditedTurn : "")
 );
 }

 function paint(ctx: PiContext): void {
 ctx.ui?.setStatus?.(STATUS_KEY, renderStatus());
 }

 function notify(ctx: PiContext, message: string, level: string = "info"): void {
 ctx.ui?.notify?.("[Harvester] " + message, level);
 }

 function workerModelId(ctx: PiContext): string {
 if (!ctx.model) return "unknown";
 return (ctx.model.provider ?? "") + ":" + (ctx.model.id ?? ctx.model.name ?? "unknown");
 }

 function extractLatestAssistant(branch: SessionEntry[]): string {
 for (let i = branch.length - 1; i >= 0; i--) {
 const e = branch[i];
 if (e.type === "message") {
 const msg = e.message as { role?: string; content?: unknown };
 if (msg.role === "assistant") {
 return messageToText(msg as never);
 }
 }
 }
 return "";
 }

 /**
 * Run the audit. Fire-and-forget from turn_end so we never block the
 * pi runtime on an HTTP call.
 */
 function runAudit(ctx: PiContext, triggerReason: TriggerReason): void {
 if (auditInFlight) return;
 auditInFlight = (async () => {
 state = "auditing";
 lastTriggerReason = triggerReason;
 lastAuditedTurn = turnCounter;
 paint(ctx);

 try {
 const branch = ctx.sessionManager.getBranch();
 const slice = extractNeatSlice(branch, ctx.cwd);
 const audit = await invokeVerifier(slice);

 // Capture active files + git diff at audit time.
 let activeFiles: ActiveFile[] = [];
 let gitDiff: string | null = null;
 try {
 activeFiles = await captureActiveFileStates(ctx.cwd, slice.modifiedPaths);
 } catch {
 activeFiles = [];
 }
 try {
 gitDiff = extractGitDiff(ctx.cwd);
 } catch {
 gitDiff = null;
 }

 lastAudit = audit;
 lastSlice = slice;
 lastActiveFiles = activeFiles;
 lastRejected = slice.failedCode || extractLatestAssistant(branch);
 lastDivergenceEntryId =
 typeof audit.divergence_turn_entry_id === "string" ? audit.divergence_turn_entry_id : null;
 lastGitDiffSummary = gitDiff;
 state = "awaiting_resolution";

 notify(
 ctx,
 "Audit complete — divergence: " +
 (audit.divergence_detected ? "yes" : "no") +
 "; flaw=" +
 audit.flaw_category +
 "; tags=[" +
 (audit.domain_tags || []).join(",") +
 "]",
 "info",
 );

 await performSplice(audit, slice, pi as never, ctx as never);
 } catch (err) {
 const isUnavailable = (err as { name?: string })?.name === "VerifierUnavailableError";
 if (isUnavailable) {
 notify(ctx, "Audit failed, unlocking state. Continuing unsteered.", "warning");
 // Reset the streak so we don't loop forever on a flaky endpoint.
 compilerFailStreak = 0;
 } else {
 const msg = (err as Error)?.message ?? String(err);
 notify(ctx, "Audit failed: " + msg + " (unlocking state)", "warn");
 }
 // The finally block below handles state + auditInFlight cleanup.
 } finally {
 auditInFlight = null;
 // Only set awaiting_resolution if the audit succeeded — otherwise
 // drop back to idle so the loop continues.
 if (state === "auditing") {
 state = "idle";
 lastAudit = null;
 lastSlice = null;
 lastActiveFiles = [];
 lastRejected = "";
 lastDivergenceEntryId = null;
 lastGitDiffSummary = null;
 }
 paint(ctx);
 }
 })();
 }

 /**
 * If a previous audit is awaiting resolution AND the streak just
 * dropped back to 0, the worker has fixed the issue — write a DPO
 * record and reset state to idle.
 */
 function maybeResolveAndHarvest(ctx: PiContext): boolean {
 if (state !== "awaiting_resolution") return false;
 if (!lastAudit || !lastSlice) return false;
 if (compilerFailStreak !== 0) return false;

 const branch = ctx.sessionManager.getBranch();
 const chosen = extractLatestAssistant(branch);

 const domainTags =
 lastAudit.domain_tags && lastAudit.domain_tags.length > 0
 ? lastAudit.domain_tags
 : inferDomainTags(lastSlice.modifiedPaths);

 try {
 const result = writeDpoEntry({
 audit: lastAudit,
 slice: lastSlice,
 chosenCompletion: chosen,
 rejectedCompletion: lastRejected,
 ctx: ctx as never,
 domainTags,
 workerModel: workerModelId(ctx),
 verifierModel: process.env.VERIFIER_MODEL ?? "unknown",
 triggerReason: lastTriggerReason,
 divergenceEntryId: lastDivergenceEntryId,
 activeFiles: lastActiveFiles,
 gitDiffSummary: lastGitDiffSummary,
 humanFeedback: lastReviewFeedback,
 });
 harvestCount += 1;
 notify(ctx, "Harvested DPO pair → " + result.path + " (" + result.bytes + " bytes)", "info");
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 notify(ctx, "DPO sink write failed: " + msg, "warn");
 }

 // CRITICAL: reset to idle and clear all cached audit state. Failing to
 // do this leaves the extension permanently stuck in awaiting_resolution
 // and blocks every future trigger.
 state = "idle";
 lastAudit = null;
 lastSlice = null;
 lastActiveFiles = [];
 lastRejected = "";
 lastDivergenceEntryId = null;
 lastGitDiffSummary = null;
 lastReviewFeedback = null;
 lastAuditedTurn = turnCounter;
 paint(ctx);
 return true;
 }

 // -------------------------------------------------------------------------
 // Slash command: /harvest status | /harvest audit | /harvest export dpo
 // -------------------------------------------------------------------------

 pi.registerCommand("harvest", {
 description: "pi-harvest controls. Subcommands: status, audit, export dpo",
 handler: async (args, ctx) => {
 const rawArgs = (args ?? "").trim();
 const trimmed = rawArgs.toLowerCase();
 const c = ctx as PiContext;

 // Subcommand routing.
 if (trimmed === "audit") {
 if (auditInFlight) {
 notify(c, "Audit already in flight", "warn");
 return;
 }
 notify(c, "Manual audit requested", "info");
 runAudit(c, "manual");
 return;
 }

 if (trimmed === "review" || trimmed.startsWith("review ")) {
 const feedback = rawArgs.replace(/^review\s*/i, "").trim();
 if (!feedback) {
 notify(c, "Usage: /harvest review <your feedback>", "warn");
 return;
 }
 if (auditInFlight) {
 notify(c, "Another audit is in flight; try again in a moment", "warn");
 return;
 }
 if (state === "auditing" || state === "awaiting_resolution") {
 notify(c, "Harvester busy (state=" + state + "); review skipped", "warn");
 return;
 }
 const preview = feedback.length > 60 ? feedback.slice(0, 57) + "..." : feedback;
 notify(c, "Semantic review requested: " + preview, "info");
 runReview(c, feedback);
 return;
 }

 if (trimmed === "export" || trimmed.startsWith("export ")) {
 try {
 const result = await exportToHuggingFaceDPO({ cwd: c.cwd });
 notify(
 c,
 "DPO export written: " + result.path + " (" + result.count + " records, " + result.bytes + " bytes)",
 "info",
 );
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 notify(c, "DPO export failed: " + msg, "warn");
 }
 return;
 }

 // Default + "status": print a summary.
 const stats = await getSinkStats(c.cwd);
 const telemetry = await aggregateTelemetry(c.cwd, 3);
 const line1 =
 "Status: turn=" +
 turnCounter +
 " streak=" +
 compilerFailStreak +
 " harvests=" +
 harvestCount +
 " state=" +
 state +
 (lastAuditedTurn > 0 ? " lastAudit=" + lastAuditedTurn : "");
 const line2 =
 "Verifier: " +
 (process.env.VERIFIER_BASE_URL || "<unset>") +
 " model=" +
 (process.env.VERIFIER_MODEL || "<unset>");
 const line3 =
 "Sink: " +
 stats.path +
 " records=" +
 stats.recordCount +
 " size=" +
 stats.sizeBytes +
 "B";
 const line4 = "Worker: " + workerModelId(c);
 const line5 = formatTelemetryForNotify(telemetry);
 c.ui?.notify?.("[Harvester]\n " + line1 + "\n " + line2 + "\n " + line3 + "\n " + line4 + "\n" + line5, "info");
 paint(c);
 },
 });

 // -------------------------------------------------------------------------
 // Phase 5: Thrashing detection + background distillation
 // -------------------------------------------------------------------------

 /**
 * Extract a file path from a ToolResult's details or text content.
 * Returns null if no path-like token is found.
 */
 function extractPathFromToolResult(tr: LooseToolResult): string | null {
 const details = tr.details as Record<string, unknown> | undefined;
 if (details && typeof details === "object") {
 const candidates = [details.path, (details as any).filePath, (details as any).file];
 for (const c of candidates) {
 if (typeof c === "string" && c.length > 0) return c;
 }
 }
 const content = tr.content;
 if (typeof content === "string") {
 const m = content.match(/([\w./\\-]+\.[a-zA-Z0-9]{1,5})/);
 if (m) return m[1];
 }
 if (Array.isArray(content)) {
 for (const part of content) {
 if (typeof part === "object" && part !== null) {
 const txt = (part as { text?: string }).text;
 if (typeof txt === "string") {
 const m = txt.match(/([\w./\\-]+\.[a-zA-Z0-9]{1,5})/);
 if (m) return m[1];
 }
 }
 }
 }
 return null;
 }

 /**
 * Was the given tool result a clean bash output (no compiler error signature)?
 */
 function isCleanBashResult(tr: LooseToolResult): boolean {
 const toolName = (tr.toolName ?? "").toLowerCase();
 if (toolName !== "bash" && toolName !== "run_shell" && toolName !== "shell") return false;
 if (tr.isError === true) return false;
 const content = tr.content;
 let haystack = "";
 if (typeof content === "string") haystack = content;
 else if (Array.isArray(content)) haystack = content.map((p) => p.text ?? "").join("\n");
 haystack = haystack.toLowerCase();
 if (!haystack) return false;
 return !SIGNATURE_REGEX.test(haystack);
 }

 /**
 * Detect thrashing in the current turn and trigger background distillation.
 *
 * Signal:
 * - toolResults.length >= THRASHING_THRESHOLD
 * - last tool result was a clean bash (success)
 * - at least one file was edited 2+ times during the turn (rework signal)
 *
 * Non-blocking — runs the distiller in a fire-and-forget Promise so the
 * user's interactive session is never paused.
 */
 function maybeDetectThrashing(ctx: PiContext, event: any): void {
 if (distillationInFlight) return; // already running

 const toolResults: LooseToolResult[] = Array.isArray(event?.toolResults) ? event.toolResults : [];

 // Reset by default; only re-evaluate below.
 const prevStreak = thrashingStreak;
 const prevText = thrashingRejectedText;
 thrashingStreak = 0;
 thrashingRejectedText = "";

 if (THRASHING_THRESHOLD <= 0) return;
 if (toolResults.length < THRASHING_THRESHOLD) return;

 const lastResult = toolResults[toolResults.length - 1];
 if (!isCleanBashResult(lastResult)) return;

 // Count file-edit occurrences across this turn's tool calls.
 const pathCounts = new Map<string, number>();
 for (const tr of toolResults) {
 const toolName = (tr.toolName ?? "").toLowerCase();
 if (toolName !== "write" && toolName !== "edit" && toolName !== "patch") continue;
 const p = extractPathFromToolResult(tr);
 if (!p) continue;
 pathCounts.set(p, (pathCounts.get(p) ?? 0) + 1);
 }
 const reworked = Array.from(pathCounts.entries()).filter(([, c]) => c >= 2);
 if (reworked.length === 0) return; // planned scaffolding, not thrashing

 // We have a thrashing turn. The streak accumulates the tool-call count
 // across consecutive thrashing turns so a single 7-tool-call thrash
 // immediately trips the 6-tool threshold (rather than needing 6
 // separate turns).
 thrashingStreak = prevStreak + toolResults.length;

 // Append assistant messages from this turn to the rejected text window.
 try {
 const branch = ctx.sessionManager.getBranch();
 for (const entry of branch) {
 if (entry.type === "message" && (entry.message as { role?: string }).role === "assistant") {
 thrashingRejectedText += messageToText(entry.message as never) + "\n\n";
 }
 }
 } catch {
 // Defensive: if branch inspection fails, just use the previous text.
 thrashingRejectedText = prevText + "\n\n";
 }

 notify(
 ctx,
 "Thrashing detected: " + thrashingStreak + " turn(s) with " + reworked.length + " reworked file(s)",
 "info",
 );

 if (thrashingStreak >= THRASHING_THRESHOLD) {
 triggerDistillation(ctx);
 }
 }

 /**
 * Fire-and-forget distillation. Does NOT block turn_end; errors are
 * caught and reported via notify so a flaky verifier never crashes the
 * session.
 */
// =========================================================================-
 // Phase 6: Semantic review run. Triggered by /harvest review <feedback>.
 // Calls invokeReviewer with the current slice + active files + the human
 // feedback string. On success: navigateTree to the entry just before the
 // flawed code was generated, then sendUserMessage a [SEMANTIC REVIEW ALERTS]
 // block, and transition state to awaiting_resolution so the existing
 // maybeResolveAndHarvest() path picks up the resolution.
 // =========================================================================-

 function runReview(ctx: PiContext, humanFeedback: string): void {
 if (auditInFlight) return;
 const c = ctx as PiContext;
 auditInFlight = (async () => {
 state = "auditing";
 lastTriggerReason = "semantic_review";
 lastAuditedTurn = turnCounter;
 paint(c);

 try {
 const branch = ctx.sessionManager.getBranch();
 const slice = extractNeatSlice(branch, c.cwd);
 let activeFiles: ActiveFile[] = [];
 try {
 activeFiles = await captureActiveFileStates(c.cwd, slice.modifiedPaths);
 } catch {
 activeFiles = [];
 }

 const review = await invokeReviewer({ cwd: c.cwd, slice, activeFiles, humanFeedback });

 // Stage the audit so the existing maybeResolveAndHarvest() can pick it up.
 lastAudit = {
 inferred_subtask: slice.inceptionPrompt || "(no inception prompt)",
 divergence_detected: true,
 flaw_category: review.flaw_category || "SemanticLogicError",
 root_cause: review.diagnosis,
 discard_advice: "",
 steering_instructions: review.steering_instructions,
 domain_tags: inferDomainTags(slice.modifiedPaths),
 };
 lastSlice = slice;
 lastActiveFiles = activeFiles;
 lastRejected = slice.failedCode || extractLatestAssistant(branch);
 lastDivergenceEntryId = null;
 lastGitDiffSummary = extractGitDiff(c.cwd);
 lastReviewFeedback = humanFeedback;
 state = "awaiting_resolution";

 notify(
 c,
 "Review complete - flaw=" + review.flaw_category + "; steering worker to implement feedback",
 "info",
 );

 // Context surgery: navigateTree to the entry just before the flawed code,
 // then inject the steering message. If navigateTree fails (or no target
 // can be found), we still inject the steering message - the spec's
 // explicit contract is that the steering message lands.
 const targetId = entryIdBeforeMostRecentAssistant(slice);
 if (targetId) {
 try {
 const nav = await (pi as ExtensionAPI).navigateTree(targetId, {
 summarize: true,
 customInstructions: review.steering_instructions,
 });
 if (nav.cancelled) {
 notify(c, "Review splice cancelled by user", "warn");
 }
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 notify(c, "Review navigateTree failed: " + msg, "warn");
 }
 }

 const steeringBody =
 "[SEMANTIC REVIEW ALERTS]\n" +
 "Human Feedback: " + humanFeedback + "\n" +
 "Diagnosis: " + review.diagnosis + "\n" +
 "Action Required: " + review.steering_instructions;
 try {
 (pi as ExtensionAPI).sendUserMessage(steeringBody, { deliverAs: "steer" });
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 notify(c, "Review sendUserMessage failed: " + msg, "warn");
 }
 } catch (err) {
 const isUnavailable = (err as { name?: string })?.name === "VerifierUnavailableError";
 if (isUnavailable) {
 notify(c, "Review aborted - verifier unavailable; unlocking state", "warning");
 } else {
 const msg = (err as Error)?.message ?? String(err);
 notify(c, "Review failed: " + msg + " (unlocking state)", "warn");
 }
 state = "idle";
 lastAudit = null;
 lastSlice = null;
 lastActiveFiles = [];
 lastRejected = "";
 lastDivergenceEntryId = null;
 lastGitDiffSummary = null;
 lastReviewFeedback = null;
 } finally {
 auditInFlight = null;
 paint(c);
 }
 })();
 }

 /**
 * Find the entry just before the most recent assistant message in the
 * slice. Used as the navigateTree target for semantic reviews when the
 * reviewer doesn't supply a divergence id directly.
 */
 function entryIdBeforeMostRecentAssistant(slice: NeatSlice): string | null {
 for (let i = slice.sliceEntries.length - 1; i >= 1; i--) {
 const e = slice.sliceEntries[i];
 if (e.type === "message" && (e.message as { role?: string }).role === "assistant") {
 return slice.sliceEntries[i - 1].id ?? null;
 }
 }
 return null;
 }
 function triggerDistillation(ctx: PiContext): void {
 const c = ctx as PiContext;
 const branch = ctx.sessionManager.getBranch();
 const slice = extractNeatSlice(branch, c.cwd);
 const rejectedText = thrashingRejectedText || slice.failedCode || "";

 notify(
 c,
 "Distilling " + thrashingStreak + "+ turn thrash into an optimal DPO pair...",
 "info",
 );

 distillationInFlight = (async () => {
 try {
 const activeFiles = await captureActiveFileStates(c.cwd, slice.modifiedPaths);
 const distilled = await invokeDistiller({ cwd: c.cwd, slice, activeFiles });
 writeDpoEntry({
 audit: {
 inferred_subtask: "thrashing_distillation",
 divergence_detected: false,
 flaw_category: "thrashing",
 root_cause: "",
 discard_advice: "",
 steering_instructions: "",
 domain_tags: inferDomainTags(slice.modifiedPaths),
 },
 slice,
 chosenCompletion: distilled.distilled_chosen_completion,
 rejectedCompletion: rejectedText,
 ctx: c as never,
 domainTags: inferDomainTags(slice.modifiedPaths),
 workerModel: workerModelId(c),
 verifierModel: process.env.VERIFIER_MODEL ?? "unknown",
 triggerReason: "thrashing_distillation",
 divergenceEntryId: null,
 activeFiles,
 gitDiffSummary: extractGitDiff(c.cwd),
 });
 harvestCount += 1;
 notify(c, "Distilled DPO pair saved (" + distilled.distilled_chosen_completion.length + " chars chosen)", "info");
 } catch (err) {
 const isUnavailable = (err as { name?: string })?.name === "VerifierUnavailableError";
 const msg = (err as Error)?.message ?? String(err);
 notify(
 c,
 isUnavailable
 ? "Distillation skipped — verifier unavailable (continuing unblocked)"
 : "Distillation failed: " + msg,
 "warn",
 );
 } finally {
 distillationInFlight = null;
 // Reset the thrashing window so we don't immediately retrigger.
 thrashingStreak = 0;
 thrashingRejectedText = "";
 paint(c);
 }
 })();
 }

 // -------------------------------------------------------------------------
 // Hooks
 // -------------------------------------------------------------------------

 pi.on("tool_result", (event, ctx) => {
 const c = ctx as PiContext;
 const e = event as { toolName?: string; output?: string; stdout?: string; stderr?: string };

 const toolName = (e.toolName ?? "").toLowerCase();
 if (toolName && toolName !== "bash" && toolName !== "run_shell" && toolName !== "shell") {
 paint(c);
 return;
 }

 const raw =
 [e.output, e.stdout, e.stderr].filter((s): s is string => typeof s === "string").join("\n") || "";
 const haystack = raw.toLowerCase();

 if (haystack && SIGNATURE_REGEX.test(haystack)) {
 compilerFailStreak += 1;
 } else {
 if (raw.length > 0) compilerFailStreak = 0;
 }

 paint(c);
 });

 pi.on("turn_end", (event, ctx) => {
 const c = ctx as PiContext;
 turnCounter += 1;

 // 1) If a previous audit is awaiting resolution AND the worker just
 // produced clean bash output, write the DPO record.
 if (maybeResolveAndHarvest(c)) {
 // already painted inside
 } else if (state === "idle") {
 // 2) Otherwise, evaluate trigger thresholds. The `state === "idle"`
 // guard prevents re-firing while an audit is in flight or waiting
 // for resolution — that's the deadlock guard.
 const turnHit = TURN_INTERVAL > 0 && turnCounter % TURN_INTERVAL === 0;
 const streakHit = STREAK_THRESHOLD > 0 && compilerFailStreak >= STREAK_THRESHOLD;
 if (turnHit || streakHit) {
 const reason = streakHit
 ? "compiler failure streak " + compilerFailStreak + " >= " + STREAK_THRESHOLD
 : "turn interval reached (every " + TURN_INTERVAL + ")";
 notify(c, "Trajectory audit required — " + reason, "warn");
 runAudit(c, streakHit ? "compiler_streak" : "periodic_turn");
 }
 }

 // 3) Phase 5: thrashing detection. Runs after the audit/splice logic
 // so it never competes with state transitions. Non-blocking.
 maybeDetectThrashing(c, event);

 paint(c);
 });
}

// Re-exports for tests / external introspection.
export { VerifierUnavailableError } from "./types.js";
export { exportToHuggingFaceDPO, mapRecordToHfDpo } from "./exporter.js";
export { aggregateTelemetry, formatTelemetryForNotify } from "./telemetry.js";
export { extractGitDiff } from "./workspace.js";
export { currentSinkPath, listSinkFiles } from "./sink.js";
