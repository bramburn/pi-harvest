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
import { invokeVerifier } from "./verifier.js";
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
const STATUS_KEY = "harvester";

type HarvesterState = "idle" | "auditing" | "awaiting_resolution";
type TriggerReason = "compiler_streak" | "periodic_turn" | "manual";

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
 let lastSlice: NeatSlice | null = null;
 let lastActiveFiles: ActiveFile[] = [];
 let lastRejected: string = "";
 let lastDivergenceEntryId: string | null = null;
 let lastGitDiffSummary: string | null = null;
 let auditInFlight: Promise<void> | null = null;

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
 const trimmed = ((args ?? "").trim().toLowerCase());
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

 pi.on("turn_end", (_event, ctx) => {
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

 paint(c);
 });
}

// Re-exports for tests / external introspection.
export { VerifierUnavailableError } from "./types.js";
export { exportToHuggingFaceDPO, mapRecordToHfDpo } from "./exporter.js";
export { aggregateTelemetry, formatTelemetryForNotify } from "./telemetry.js";
export { extractGitDiff } from "./workspace.js";
export { currentSinkPath, listSinkFiles } from "./sink.js";
