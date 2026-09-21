/**
 * pi-harvest
 *
 * Phase 1 trajectory harvester extension for pi.dev.
 * - Hooks `tool_result` to detect compiler failure streaks from bash output.
 * - Hooks `turn_end` to evaluate harvest-trigger thresholds.
 * - Renders a TUI status widget via `ctx.ui.setStatus()`.
 *
 * Phase 2 will wire the harvest trigger to an external API.
 *
 * The runtime is supplied by the pi.dev host when it loads this module
 * (via `pi install npm:pi-harvest`). `ExtensionAPI` is declared locally
 * so the package builds without depending on the host's typings.
 */

interface UiHelpers {
  setStatus?: (key: string, content: unknown) => void;
  notify?: (message: string, level?: string) => void;
}

interface PiContext {
  ui: UiHelpers;
  [key: string]: unknown;
}

interface ExtensionAPI {
  on(event: "tool_result", handler: (event: unknown, ctx: PiContext) => void): void;
  on(event: "turn_end", handler: (event: unknown, ctx: PiContext) => void): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
}

/**
 * Compiler-failure signatures to scan bash stdout/stderr for.
 * Lower-cased once at module load for case-insensitive matching.
 */
const COMPILER_FAILURE_SIGNATURES: readonly string[] = [
  "error[e",          // rustc / clippy (e.g. error[E0425])
  "build failed",     // generic CI / npm
  "error cs",         // c# / .NET (e.g. error CS1003)
  "failed to compile",// generic
  "tsc: error",       // typescript
  "compilation failed",// generic
];

const SIGNATURE_REGEX = new RegExp(
  COMPILER_FAILURE_SIGNATURES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);

const TURN_INTERVAL = 30;
const STREAK_THRESHOLD = 3;
const STATUS_KEY = "harvester";

export default function (pi: ExtensionAPI): void {
  let turnCounter = 0;
  let compilerFailStreak = 0;

  function renderStatus(): string {
    return `[Harvester] Turn: ${turnCounter} | Streak: ${compilerFailStreak}`;
  }

  pi.on("tool_result", (_event, ctx) => {
    const c = ctx as PiContext;
    const event = _event as { toolName?: string; output?: string; stdout?: string; stderr?: string };

    // Only inspect bash tool output.
    const toolName = (event.toolName ?? "").toLowerCase();
    if (toolName && toolName !== "bash" && toolName !== "run_shell" && toolName !== "shell") {
      if (c.ui?.setStatus) c.ui.setStatus(STATUS_KEY, renderStatus());
      return;
    }

    // Concatenate any available output streams; lowercase before testing
    // so the parser never misses case-sensitive compiler errors.
    const raw =
      [event.output, event.stdout, event.stderr]
        .filter((s): s is string => typeof s === "string")
        .join("\n") || "";
    const haystack = raw.toLowerCase();

    if (haystack && SIGNATURE_REGEX.test(haystack)) {
      compilerFailStreak += 1;
    } else {
      compilerFailStreak = 0;
    }

    if (c.ui?.setStatus) c.ui.setStatus(STATUS_KEY, renderStatus());
  });

  pi.on("turn_end", (_event, ctx) => {
    const c = ctx as PiContext;
    turnCounter += 1;

    const turnHit = turnCounter % TURN_INTERVAL === 0;
    const streakHit = compilerFailStreak >= STREAK_THRESHOLD;

    if (turnHit || streakHit) {
      const reason = turnHit
        ? `turn interval reached (every ${TURN_INTERVAL})`
        : `compiler failure streak ${compilerFailStreak} >= ${STREAK_THRESHOLD}`;
      const message = `[Harvester] Trajectory audit required — ${reason}. (Phase 2 API call pending.)`;
      if (c.ui?.notify) c.ui.notify(message, "warn");

      // Reset streak after a harvest trigger to avoid runaway notifications;
      // turnCounter keeps advancing on its own schedule.
      compilerFailStreak = 0;
    }

    if (c.ui?.setStatus) c.ui.setStatus(STATUS_KEY, renderStatus());
  });
}
