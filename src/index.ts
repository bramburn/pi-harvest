/**
 * pi-harvest — Phase 1 + Phase 2.
 *
 * Phase 1:
 * - tool_result hook: case-insensitive compiler-failure scan; tracks a
 * streak count.
 * - turn_end hook: periodic (every TURN_INTERVAL turns) and emergency
 * (streak >= STREAK_THRESHOLD) triggers.
 * - TUI status widget: [Harvester] Turn: N | Streak: M | Harvests: H | State: ...
 *
 * Phase 2:
 * - extractNeatSlice(): backward walk to the Inception Prompt, slice
 * from there to the current end, extract failed code + compiler error.
 * - invokeVerifier(): OpenAI-compatible POST to the Verifier env-config
 * endpoint; strict JSON schema validation; markdown-fence stripping.
 * - performSplice(): on divergence, navigateTree(...) to the last clean
 * entry (collapsing the discarded branch into a summary), then
 * sendUserMessage(...) to inject a [STEER:K3] directive.
 * - writeDpoEntry(): when the worker resolves (streak drops back to 0
 * after an audit), append a flat DPO record to
 * `<cwd>/.pi/harvest/trajectories.jsonl`.
 *
 * The runtime is supplied by pi.dev when it loads this module
 * (via `pi install npm:pi-harvest`). The interfaces below are the
 * minimal surface we use, kept local so the package builds without
 * depending on pi's typings.
 */

import { writeDpoEntry } from "./sink.js";
import { extractNeatSlice, messageToText } from "./slice.js";
import { invokeVerifier } from "./verifier.js";
import { performSplice } from "./splice.js";
import type {
 SessionEntry,
 NeatSlice,
 VerifierAudit,
} from "./types.js";

// ---------------------------------------------------------------------------
// Minimal runtime interfaces — declared locally so the package builds
// without depending on pi's typings.
// ---------------------------------------------------------------------------

interface UiHelpers {
 setStatus?(key: string, content: unknown): void;
 notify?(message: string, level?: string): void;
}

interface PiContext {
 ui: UiHelpers;
 cwd: string;
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
}

// ---------------------------------------------------------------------------
// Phase 1 constants
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

// ---------------------------------------------------------------------------
// Phase 2 entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
 let turnCounter = 0;
 let compilerFailStreak = 0;
 let harvestCount = 0;
 let state: HarvesterState = "idle";

 // State cached for resolution handling.
 let lastAudit: VerifierAudit | null = null;
 let lastSlice: NeatSlice | null = null;
 let lastRejected: string = "";
 let auditInFlight: Promise<void> | null = null;

 function renderStatus(): string {
 return `[Harvester] Turn: ${turnCounter} | Streak: ${compilerFailStreak} | Harvests: ${harvestCount} | State: ${state}`;
 }

 function paint(ctx: PiContext): void {
 ctx.ui?.setStatus?.(STATUS_KEY, renderStatus());
 }

 function notify(ctx: PiContext, message: string, level: string = "info"): void {
 ctx.ui?.notify?.(`[Harvester] ${message}`, level);
 }

 /**
 * Pull the most recent assistant text from the active branch — this
 * becomes the "chosen completion" once the worker resolves.
 */
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
 * pi runtime on an HTTP call; the promise is tracked so we don't
 * double-fire.
 */
 function runAudit(ctx: PiContext): void {
 if (auditInFlight) return;

 auditInFlight = (async () => {
 state = "auditing";
 paint(ctx);

 try {
 const branch = ctx.sessionManager.getBranch();
 const slice = extractNeatSlice(branch);
 const audit = await invokeVerifier(slice);

 // Cache everything we need for the eventual DPO write.
 lastAudit = audit;
 lastSlice = slice;
 lastRejected = slice.failedCode || extractLatestAssistant(branch);
 state = "awaiting_resolution";

 notify(
 ctx,
 `Audit complete — divergence: ${audit.divergence_detected ? "yes" : "no"}${audit.divergence_detected ? ` at turn ${audit.divergence_turn}` : ""}; flaw=${audit.flaw_category}`,
 "info",
 );

 // Splice (navigateTree + steering).
 await performSplice(audit, slice, pi as never, ctx as never);
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 notify(ctx, `Audit failed: ${msg}`, "warn");
 // Stay in idle so the next turn can retry; don't poison state.
 state = "idle";
 lastAudit = null;
 lastSlice = null;
 lastRejected = "";
 } finally {
 auditInFlight = null;
 paint(ctx);
 }
 })();
 }

 /**
 * If a previous audit is awaiting resolution AND the streak just
 * dropped back to 0, the worker has fixed the issue — write a DPO
 * entry and clear the awaiting flag.
 */
 function maybeResolveAndHarvest(ctx: PiContext): boolean {
 if (state !== "awaiting_resolution") return false;
 if (!lastAudit || !lastSlice) return false;
 if (compilerFailStreak !== 0) return false;

 const branch = ctx.sessionManager.getBranch();
 const chosen = extractLatestAssistant(branch);

 try {
 const result = writeDpoEntry({
 audit: lastAudit,
 slice: lastSlice,
 chosenCompletion: chosen,
 rejectedCompletion: lastRejected,
 ctx: ctx as never,
 domainTags: [],
 });
 harvestCount += 1;
 notify(
 ctx,
 `Harvested DPO pair → ${result.path} (${result.bytes} bytes); session=${result.path}`,
 "info",
 );
 } catch (err) {
 const msg = (err as Error)?.message ?? String(err);
 notify(ctx, `DPO sink write failed: ${msg}`, "warn");
 }

 // Reset state for the next episode.
 state = "idle";
 lastAudit = null;
 lastSlice = null;
 lastRejected = "";
 paint(ctx);
 return true;
 }

 // -------------------------------------------------------------------------
 // Hooks
 // -------------------------------------------------------------------------

 pi.on("tool_result", (event, ctx) => {
 const e = event as { toolName?: string; output?: string; stdout?: string; stderr?: string };

 // Only inspect bash tool output.
 const toolName = (e.toolName ?? "").toLowerCase();
 if (toolName && toolName !== "bash" && toolName !== "run_shell" && toolName !== "shell") {
 paint(ctx as PiContext);
 return;
 }

 // Concatenate any available output streams; lowercase before testing
 // so the parser never misses case-sensitive compiler errors.
 const raw =
 [e.output, e.stdout, e.stderr].filter((s): s is string => typeof s === "string").join("\n") || "";
 const haystack = raw.toLowerCase();

 if (haystack && SIGNATURE_REGEX.test(haystack)) {
 compilerFailStreak += 1;
 } else {
 // Only reset the streak on actual clean bash output, not on empty
 // payloads (empty could mean no output, not a successful build).
 if (raw.length > 0) {
 compilerFailStreak = 0;
 }
 }

 paint(ctx as PiContext);
 });

 pi.on("turn_end", (_event, ctx) => {
 const c = ctx as PiContext;
 turnCounter += 1;

 // 1) If a previous audit is awaiting resolution AND the worker just
 // produced clean bash output, write the DPO entry.
 if (maybeResolveAndHarvest(c)) {
 // already painted inside
 } else if (state === "idle") {
 // 2) Otherwise, evaluate trigger thresholds.
 const turnHit = TURN_INTERVAL > 0 && turnCounter % TURN_INTERVAL === 0;
 const streakHit = STREAK_THRESHOLD > 0 && compilerFailStreak >= STREAK_THRESHOLD;
 if (turnHit || streakHit) {
 const reason = streakHit
 ? `compiler failure streak ${compilerFailStreak} >= ${STREAK_THRESHOLD}`
 : `turn interval reached (every ${TURN_INTERVAL})`;
 notify(c, `Trajectory audit required — ${reason}`, "warn");
 runAudit(c);
 }
 }

 paint(c);
 });
}
