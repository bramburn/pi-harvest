/**
 * pi-harvest — Phase 1 + Phase 2 + Phase 3.
 *
 * Phase 1:
 * - tool_result hook: case-insensitive compiler-failure scan; tracks a
 * streak count.
 * - turn_end hook: periodic and emergency triggers.
 * - TUI status widget.
 *
 * Phase 2:
 * - extractNeatSlice(): backward walk to the Inception Prompt.
 * - invokeVerifier(): OpenAI-compatible POST with strict JSON schema.
 * - performSplice(): navigateTree (rewind) + sendUserMessage (steering).
 * - writeDpoEntry(): append DPO record to .pi/harvest/trajectories.jsonl.
 *
 * Phase 3 additions:
 * - captureActiveFileStates(): workspace capture with 300-line / 12KB clamp.
 * - inferDomainTags(): local fallback for the new domain_tags schema field.
 * - invokeVerifier() retries with exponential backoff (1s -> 2s) on 429/5xx.
 * - VerifierUnavailableError resets compilerFailStreak on exhaustion so we
 * never block the user's interactive session on a flaky endpoint.
 * - /harvest status and /harvest audit slash commands.
 * - Expanded TUI widget with explicit State indicator.
 * - Full HarvestedTrajectoryRecord schema (active_files, compiler_error_summary,
 * worker_model, verifier_model, trigger_reason, nested k3_audit).
 */

import { writeDpoEntry, getSinkStats, countHarvestedRecords } from "./sink.js";
import { extractNeatSlice, messageToText } from "./slice.js";
import { invokeVerifier } from "./verifier.js";
import { performSplice } from "./splice.js";
import { captureActiveFileStates, inferDomainTags } from "./workspace.js";
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

 let lastAudit: VerifierAudit | null = null;
 let lastSlice: NeatSlice | null = null;
 let lastActiveFiles: ActiveFile[] = [];
 let lastRejected: string = "";
 let lastDivergenceEntryId: string | null = null;
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
 state
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
 paint(ctx);

 try {
 const branch = ctx.sessionManager.getBranch();
 const slice = extractNeatSlice(branch, ctx.cwd);
 const audit = await invokeVerifier(slice);

 // Capture active files at audit time.
 let activeFiles: ActiveFile[] = [];
 try {
 activeFiles = await captureActiveFileStates(ctx.cwd, slice.modifiedPaths);
 } catch {
 activeFiles = [];
 }

 lastAudit = audit;
 lastSlice = slice;
 lastActiveFiles = activeFiles;
 lastRejected = slice.failedCode || extractLatestAssistant(branch);
 lastDivergenceEntryId =
 typeof audit.divergence_turn_entry_id === "string" ? audit.divergence_turn_entry_id : null;
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
 notify(ctx, "Verifier endpoint unavailable. Continuing unsteered.", "warning");
 // Reset the streak so we don't loop forever on a flaky endpoint.
 compilerFailStreak = 0;
 } else {
 const msg = (err as Error)?.message ?? String(err);
 notify(ctx, "Audit failed: " + msg, "warn");
 }
 state = "idle";
 lastAudit = null;
 lastSlice = null;
 lastActiveFiles = [];
 lastRejected = "";
 lastDivergenceEntryId = null;
 } finally {
 auditInFlight = null;
 paint(ctx);
 }
 })();
 }

 /**
 * If a previous audit is awaiting resolution AND the streak just
 * dropped back to 0, the worker has fixed the issue — write a DPO
 * record and clear the awaiting flag.
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
 });
 harvestCount += 1;
 notify(ctx, "Harvested DPO pair → " + result.path + " (" + result.bytes + " bytes)", "info");
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 notify(ctx, "DPO sink write failed: " + msg, "warn");
 }

 state = "idle";
 lastAudit = null;
 lastSlice = null;
 lastActiveFiles = [];
 lastRejected = "";
 lastDivergenceEntryId = null;
 paint(ctx);
 return true;
 }

 // -------------------------------------------------------------------------
 // Slash command: /harvest status | /harvest audit
 // -------------------------------------------------------------------------

 pi.registerCommand("harvest", {
 description: "pi-harvest controls: status shows telemetry + sink stats; audit forces a manual harvest",
 handler: async (args, ctx) => {
 const trimmed = (args ?? "").trim().toLowerCase();
 const c = ctx as PiContext;

 if (trimmed === "audit") {
 if (auditInFlight) {
 notify(c, "Audit already in flight", "warn");
 return;
 }
 notify(c, "Manual audit requested", "info");
 runAudit(c, "manual");
 return;
 }

 // Default + "status": print a summary.
 const stats = getSinkStats(c.cwd);
 const line1 =
 "Status: turn=" +
 turnCounter +
 " streak=" +
 compilerFailStreak +
 " harvests=" +
 harvestCount +
 " state=" +
 state;
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
 // Emit as a single multi-line notify.
 c.ui?.notify?.("[Harvester]\n " + line1 + "\n " + line2 + "\n " + line3 + "\n " + line4, "info");
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

 if (maybeResolveAndHarvest(c)) {
 // already painted inside
 } else if (state === "idle") {
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

// Re-export so consumers/tests can grab the error class.
export { VerifierUnavailableError } from "./types.js";
// countHarvestedRecords is useful for tests / external introspection.
export { countHarvestedRecords } from "./sink.js";
