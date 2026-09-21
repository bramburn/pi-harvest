# AGENTS.md — `src/`

> Pattern: see `../AGENTS.md` (the top-level rules — these extend, never override, the parent).

This file owns **everything inside `src/`** — the extension entry, the (future) split modules, and the conventions for new code.

---

## 1. What this directory owns

`src/index.ts` is the **only** file in Phase 1. It:

1. Exports a default function `(pi: ExtensionAPI) => void` that registers the lifecycle hooks.
2. Owns the local mutable state (`turnCounter`, `compilerFailStreak`).
3. Knows about the compiler-failure signatures and trigger thresholds.

Starting in **Phase 2**, `src/` will split into focused modules per the structure below. Until then, **all code lives in `index.ts`** — do not preemptively create empty module directories.

---

## 2. Module split (target for Phase 2+)

```
src/
├── index.ts              # lifecycle wiring only — delegates to the modules
├── types.ts              # ExtensionAPI, PiContext, AuditResult, TieredMessage
├── signatures.ts         # COMPILER_FAILURE_SIGNATURES + case-insensitive regex
├── verifier/
│   ├── client.ts         # POST to K3 / DeepSeek; JSON schema enforcement
│   └── prompt.ts         # the audit system prompt + response schema
├── slice/
│   ├── engine.ts         # Neat Slice — backward traversal + active-file snapshot
│   └── tiers.ts          # Tier 1 / Tier 2 / Tier 3 classification
├── splice/
│   └── engine.ts         # Context surgery — prune + steer inject
├── sink/
│   └── jsonl.ts          # Append-only .pi/harvest/trajectories.jsonl writer
└── commands/
    └── audit.ts          # /k3-audit slash command handler
```

**Rule:** only split a module out of `index.ts` when the relevant section exceeds ~150 lines or has its own test concerns.

### Module responsibilities

| Module | Owns | Public surface |
|--------|------|----------------|
| `signatures.ts` | The `COMPILER_FAILURE_SIGNATURES` array + the `SIGNATURE_REGEX` it builds. Lowercasing lives here. | `isCompilerFailure(rawOutput: string): boolean` |
| `verifier/client.ts` | The single HTTP POST per audit. JSON-schema enforcement. Env-var resolution (`VERIFIER_API_KEY`, `VERIFIER_BASE_URL`, `VERIFIER_MODEL`). | `async function invokeVerifier(slicedContext: SlicedContext): Promise<AuditResult \| null>` |
| `verifier/prompt.ts` | The audit system prompt + the JSON schema the verifier must obey (includes `inferred_subtask`, `divergence_turn`, `flaw_category`, `root_cause`, `steering_instructions`). | `AUDIT_SYSTEM_PROMPT: string`, `AUDIT_RESPONSE_SCHEMA: object` |
| `slice/engine.ts` | Backward-traverse `ctx.sessionManager.getEntries()` to find the inception prompt. Read active files via `fs.readFileSync`. | `function sliceContext(entries, activeFilePaths): SlicedContext` |
| `slice/tiers.ts` | Tag each entry as Tier 1 / Tier 2 / Tier 3. The `[STEER:K3]` prefix is the Tier 3 marker. | `function classifyTier(entry): 1 \| 2 \| 3` |
| `splice/engine.ts` | Call `ctx.sessionManager.prune(divergenceTurn)`, then `pi.sendMessage(steeringSpec, { deliverAs: "steer", triggerTurn: true })`. | `async function performSplice(ctx, auditResult): Promise<void>` |
| `sink/jsonl.ts` | `fs.mkdirSync(.pi/harvest, { recursive: true })` + `fs.appendFileSync(trajectories.jsonl, JSON.stringify(record) + "\n")`. | `function appendTrajectory(record): void` |
| `commands/audit.ts` | `pi.registerCommand("k3-audit", ...)` — manually force an audit and inject the steering. | `function registerAuditCommand(pi, ctx): void` |

---

## 3. Key types

The local type declarations in `src/index.ts` are the **canonical** contract until Phase 2 introduces `src/types.ts`:

```typescript
interface UiHelpers {
  setStatus?: (key: string, content: unknown) => void;
  notify?: (message: string, level?: string) => void;
}

interface PiContext {
  ui: UiHelpers;
  // Additional fields (sessionManager, cwd, etc.) surface in later phases
  // and MUST be added here so consumers can `import` the canonical shape.
  [key: string]: unknown;
}

interface ExtensionAPI {
  on(event: "tool_result", handler: (event: unknown, ctx: PiContext) => void): void;
  on(event: "turn_end",     handler: (event: unknown, ctx: PiContext) => void): void;
  on(event: string,         handler: (...args: unknown[]) => void): void;
}
```

### Future types (Phase 2+, document before you write them)

```typescript
// verifier/prompt.ts → verifier/client.ts
interface AuditResult {
  divergence_detected: boolean;
  divergence_turn: number | null;
  inferred_subtask: string;          // ← critical for the Neat Slice
  flaw_category: string;
  root_cause: string;
  discard_advice: string;
  steering_instructions: string;
}

// slice/engine.ts
interface SlicedContext {
  immediate_prompt: string;          // K3's inferred_subtask + active-file snippet
  active_file_state: string;         // fs.readFileSync on edited files
  rejected_completion: string;       // worker's broken code
  compiler_stderr: string;           // the rustc / tsc / dotnet stderr
  user_constraints: string[];        // Tier 2 nudges collected during traversal
}

// slice/tiers.ts
type MessageTier = 1 | 2 | 3;        // Epic | UserNudge | SupervisorSteer

// sink/jsonl.ts
interface TrajectoryRecord {
  session_id: string;
  timestamp: string;                 // ISO-8601
  worker_model: string;              // e.g. "minimax-m3"
  verifier_model: string;            // e.g. "kimi-k3"
  trigger_reason: "compiler_streak" | "periodic_interval" | "manual_command";
  audit: AuditResult;
  dpo_pair: {
    prompt: string;                  // immediate task + active file state
    chosen: string;                  // post-steer successful completion
    rejected: string;                // pre-steer broken completion
  };
}
```

---

## 4. Hook signatures

### `pi.on("tool_result", handler)`

The handler runs **after** a tool call completes. Inspect:

```typescript
const event = _event as {
  toolName?: string;        // "bash" / "run_shell" / "shell" / "read" / "write" / ...
  output?: string;          // joined stdout+stderr (when the host concatenates)
  stdout?: string;
  stderr?: string;
};
```

**Rules from the plan's failure criteria:**

- **Lowercase before regex test.** Always: `[event.output, event.stdout, event.stderr].filter(...).join("\n").toLowerCase()` then `SIGNATURE_REGEX.test(haystack)`. Missing this step is a known Phase 1 regression risk.
- **Skip non-shell tools.** Only inspect when `toolName` is `bash`, `run_shell`, or `shell`. The smoke test (`tests/smoke.js`) explicitly verifies that a `read` tool with embedded `error[E0425]` text does **not** bump the streak.
- **Update the status widget on every event** — even when the tool isn't relevant, so the user sees the worker is being watched.

### `pi.on("turn_end", handler)`

Runs **after** each assistant turn finishes (post-streaming, post-tool-calls). The handler is the place to evaluate the trigger thresholds:

```typescript
const turnHit   = turnCounter % TURN_INTERVAL === 0;       // periodic safety valve
const streakHit = compilerFailStreak >= STREAK_THRESHOLD; // event-driven primary
```

**Rules:**

- **Increment `turnCounter` first**, then evaluate. Otherwise the first turn never sees `turnCounter === 30`.
- **Reset `compilerFailStreak` on trigger.** Otherwise one bad build can fire N consecutive notifications.
- **Do not block** — wrap the verifier call in `try/catch` and `console.error` the failure. The worker must keep running even if K3 is down.

---

## 5. Conventions (local)

### Imports

- **Only `node:` built-ins** for now (`node:fs`, `node:path`, `node:crypto`). No `lodash`, no `axios`, no `zod`. The first verifier call may need a tiny `fetch` wrapper but not a library.
- **Relative imports within `src/`.** No path aliases until Phase 2, when `tsconfig.json` adds `"baseUrl": "src"`.

### Side effects

- **Module-load side effects are forbidden** except for the `SIGNATURE_REGEX` constant. Don't `fs.mkdirSync` at the top level — defer to the first call.
- **No global state outside `index.ts`'s default export's closure.** The phase 1 single-file design uses closure-scoped `let turnCounter`. Once we split into modules, move that state into a `state.ts` singleton.

### Error handling

- **`try/catch` every I/O** (`fs`, `fetch`, JSON parse). Never let an exception escape into the pi host — it kills the worker thread.
- **Verifier failures degrade silently.** Log to `console.error`, set the status widget to `[Harvester] Verifier offline`, keep counting turns. The plan is explicit that the worker must keep running even if K3 is unreachable.

### Logging

- **`ctx.ui.notify(message, level)`** for user-visible events. `level` ∈ `"info"` | `"warn"` | `"error"`.
- **`ctx.ui.setStatus(key, content)`** for the persistent widget. Use the key `"harvester"` (Phase 1) or `"harvester:turn"` / `"harvester:streak"` (Phase 2 if we split).
- **`console.error`** for fatal-but-non-user-facing errors (verifier HTTP 500, JSON parse failure, etc.). Never `console.log` in production paths.

---

## 6. Definition of done (per module)

A module is **done** when:

1. ✅ It compiles under `tsc --strict` with zero `any` outside event-handler signatures.
2. ✅ It has at least one smoke-test scenario in `tests/smoke.js` (or its own `*.test.ts` if Phase 2+ adds a real test runner).
3. ✅ Its public surface is documented in this file (`§ 2 Module responsibilities`).
4. ✅ Its errors degrade silently — no uncaught exceptions reach the pi host.
5. ✅ Its status-widget key is registered in `index.ts` so the user can see it.

---

## 7. Forbidden here

- ❌ **No imports from `dist/`.** If you need a type from another module, lift it to `types.ts`.
- ❌ **No async work in module top level.** State initialization is synchronous; deferred I/O lives in the function body.
- ❌ **No `JSON.parse(string)` without `try/catch`.** The K3/DeepSeek response is *trusted but unverified* — a 500 error returns an HTML body that will throw.
- ❌ **No regex literals inline.** Add to `signatures.ts` (or the module's local equivalent) so the case-insensitive scan stays consistent.
- ❌ **No hardcoded URLs, model names, or API keys.** Everything env-driven. Even the default `kimi-k3` model ID lives in a `const DEFAULT_VERIFIER_MODEL = "kimi-k3"` constant *only* if it comes with a corresponding env-var override.

---

## 8. Cross-refs

- Top-level rules: [`../AGENTS.md`](../AGENTS.md)
- Test conventions (mock pi runtime shape, scenario catalogue): [`../tests/AGENTS.md`](../tests/AGENTS.md)
- Plan source: `~/Downloads/Gemini-Hosting GGUF Models on Aliyun-20260921-1310.md` — §"Phase 2–6 Implementation Action List", §"The Neat Slice Engine", §"Dataset Schema"