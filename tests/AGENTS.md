# AGENTS.md — `tests/`

> Pattern: see `../AGENTS.md` (top-level rules) and [`../src/AGENTS.md`](../src/AGENTS.md) (the module under test).
> This file owns the **smoke-test runtime** — the mock `pi` host used to validate the compiled extension without spinning up a real pi session.

---

## 1. What this directory owns

| File | Purpose |
|------|---------|
| `tests/smoke.js` | End-to-end flow test against a mock `pi` runtime: 3-failure streak → auto-audit → self-dispatched rewind → steer → gated resolution → thrashing distillation → manual audit → export. Run with `node tests/smoke.js`. **Not** shipped with the npm package — `package.json`'s `files` whitelist excludes `tests/`. |

The directory exists **only** to hold manual / scripted smoke tests for the compiled extension. Phase 2+ may add per-module unit tests here (e.g. `verifier-client.test.js`) but no formal test runner is wired yet.

---

## 2. The mock-pi runtime

`tests/smoke.js` ships a minimal `pi` host that satisfies the extension's expectations without needing a real pi session. The shape is canonical — copy it for any new test file:

```javascript
const extension = require("../dist/index.js").default;

const calls = [];
const pi = {
  on(event, handler) {
    pi._handlers = pi._handlers || {};
    pi._handlers[event] = handler;
  },
  _fire(event, eventObj, ctx) {
    if (pi._handlers && pi._handlers[event]) {
      pi._handlers[event](eventObj, ctx);
    }
  },
};

const ctx = {
  ui: {
    setStatus(key, content) {
      calls.push(["setStatus", key, String(content)]);
    },
    notify(msg, level) {
      calls.push(["notify", msg, level]);
    },
  },
};

extension(pi);
```

### Why this shape

- `pi.on(event, handler)` registers handlers under the event name in `pi._handlers`.
- `pi._fire(event, eventObj, ctx)` invokes the registered handler synchronously with a synthetic event and a `ctx` that exposes `ui.setStatus` / `ui.notify` exactly the way the real host does.
- `calls` is a flat array of `[method, ...args]` tuples — easy to grep, easy to assert against.

### Adding new scenarios

The pattern is:

```javascript
console.log("--- Test N: <one-line description> ---");
pi._fire("tool_result" | "turn_end", eventObj, ctx);
// then either:
//   - assert on `calls`
//   - or print the captured calls to stdout for visual review
```

Each scenario should be **independent** — the streak / counter should be either predictable from the preceding scenario or reset by an explicit clean output. Do not rely on hidden state.

---

## 3. Scenario catalogue (Phase 1)

These are the scenarios `tests/smoke.js` already covers. **Every new feature must extend this catalogue** with at least one scenario that exercises the new code, otherwise the smoke test is incomplete.

| # | Scenario | What it proves |
|---|----------|----------------|
| 1 | Clean bash output (`Finished dev profile [unoptimized]`) | `tool_result` for bash does **not** bump the streak. |
| 2 | `error[E0425]: cannot find value x` | Rust compiler signature detected. |
| 3 | Same again — `error[E0423]` | Streak increments to 2. |
| 4 | Third failure + `turn_end` | Streak hits 3, triggers `notify()` on the next `turn_end`. |
| 5 | Clean output (`Build succeeded.`) | Streak resets to 0. |
| 6 | `read` tool with embedded `error[E0425]` | Non-bash tools ignored — streak does **not** increment. |
| 7 | `FAILED TO COMPILE` (uppercase) | Case-insensitive scan still catches it. |
| 8 | 28 `turn_end` fires then one more | `turnCounter % 30 === 0` triggers periodic `notify()`. |

---

## 4. Steering-hardening scenarios (current smoke flow)

`tests/smoke.js` now runs as one sequential flow. Each numbered section below **must keep passing**; the script exits non-zero on the first failure.

| # | Scenario | What it proves |
|---|----------|----------------|
| 1 | 3× `cargo build` failures (with `input.command`) + `turn_end` | Auto-audit fires **exactly once** (one verifier HTTP call). The event-handler ctx has no `navigateTree`, so the extension self-dispatches `/harvest rewind` via `sendUserMessage(content, { expandPromptTemplates: true })`; the mock executes it with a fresh command ctx and the rewind lands (`navigateTree` called with `targetId: "t1"`, `summarize: true`). The `[STEER:K3]` steer is sent **after** the navigation, with `deliverAs: "steer"`. No "Rewind skipped" fallback notify. |
| 2 | Clean `ls -la` + `turn_end`, then clean `cargo build` + `turn_end` | **Resolution gate**: the bare `ls` does NOT resolve the audit (no JSONL after 300 ms); the build-shaped command satisfies `HARVEST_RESOLUTION_VERIFICATIONS` and the DPO record is written. |
| 3 | `/harvest status` | Status widget text: counters, verifier model, sink stats, telemetry (`logic_error (1)`), `state=idle`. |
| 4 | `turn_end` with 4 toolResults (bash + 2× edit on same file + clean bash), `HARVEST_THRASHING_THRESHOLD=3` | Thrashing detected → distiller called exactly once → distillation DPO record (`trigger_reason: "thrashing_distillation"`) AND a live-worker steer containing `[STEER:K3]`, the distilled completion, and `deliverAs: "steer"`. |
| 5 | `/harvest audit` with a command ctx that has `navigateTree` | Manual audit uses the ctx's `navigateTree` **directly** (no self-dispatch); second navigation recorded; status shows `state=awaiting_resolution`. |
| 6 | Clean `cargo build` + `turn_end` → `/harvest export dpo` | Manual audit resolves through the gate; export file exists with 3 HF-format DPO records. |
| 7 | Sink filename | `trajectories_YYYY_MM.jsonl` monthly rotation. |

Mock notes:

- `sendUserMessage` emulates real pi's `prompt()`: when `expandPromptTemplates: true` and the content starts with `/`, the registered command's handler runs immediately with a fresh command ctx (including `navigateTree`) — this is what makes scenario 1 possible. Command-handler errors land in `calls.commandErrors` and must stay empty.
- The mock verifier routes on the request's system prompt: `/Hindsight Relabeling/` → distiller response, otherwise audit response.

---

## 5. Scenarios to add for future phases

When the verifier client lands, extend the catalogue with:

| # | Scenario | What it would prove |
|---|----------|---------------------|
| 9 | `tool_result` with 3 rust errors → `turn_end` | `verifier/client.ts` is invoked **exactly once**, not 3 times. |
| 10 | Mock K3 returning `divergence_detected: true` at turn 14 | `pi.sendMessage` is called once with the steer payload. The streak resets to 0. |
| 11 | Mock K3 returning `divergence_detected: false` | No `pi.sendMessage` call. Worker loop continues uninterrupted. |
| 12 | Mock K3 returning malformed JSON | `console.error` fires; worker keeps running; no exception escapes. |
| 13 | Mock K3 returning HTTP 500 | Same as #12 — graceful degradation. |

When the slice engine lands:

| # | Scenario | What it would prove |
|---|----------|---------------------|
| 14 | Session with 5 entries + an inception prompt at index 2 | `sliceContext()` returns indices 2–4 only. |
| 15 | Entry prefixed with `[STEER:K3]` | `classifyTier()` returns `3`. |
| 16 | User message under 20 words | `classifyTier()` returns `2`. |
| 17 | First user message in the session | `classifyTier()` returns `1`. |

When the sink lands:

| # | Scenario | What it would prove |
|---|----------|---------------------|
| 18 | One successful audit cycle | `.pi/harvest/trajectories.jsonl` exists, has exactly 1 line, JSON parses, DPO triplet is complete. |
| 19 | Audit where the next worker pass also fails | No JSONL append (we only log resolutions). |
| 20 | `.pi/harvest/` doesn't exist | `appendTrajectory()` creates it. |

---

## 5. How to run

```bash
# from C:\dev\pi-harvest
npm run build      # rebuild dist/ first if src/ changed
node tests/smoke.js
```

### Expected output

A single `Steering-hardening smoke test PASSED` line followed by a summary block (DPO path, record count, audit/distiller call counts, rewind navigations). The final status widget should read `[Harvester] Turn: N | Streak: 0 | ... | State: idle`.

### What "green" means for a phase

- ✅ All existing scenarios still pass after the phase change.
- ✅ Each new scenario in the § 4 catalogue above exists and prints sensible output.
- ✅ No uncaught exception reaches `pi._fire` — any exception inside a handler would crash the smoke script with a non-zero exit code.

A phase is **not** done until both `npm run build` and `node tests/smoke.js` exit 0.

---

## 6. Conventions

- **No test framework.** The smoke test is a plain Node script using `console.log` + a `calls` array. Adding `jest` / `vitest` is a Phase 7+ concern — the smoke test stays minimal so it can run without any dev-time dependencies beyond Node itself.
- **Scenarios are append-only.** Never renumber — downstream humans grep for `--- Test 7:`. If a scenario becomes obsolete, comment it out with `// DISABLED: <reason>` instead of deleting it.
- **Mocks live in `tests/`** — never in `src/`. The compiled extension has no idea it's being tested; the test rig provides a faithful-enough `pi` host.
- **API keys never enter the test.** The mock verifier returns canned responses. The Phase 2 real verifier client must be designed so it can be swapped for a mock in tests (e.g. an `invokeVerifier` factory that takes the `fetch` implementation as a dependency).

---

## 7. Definition of done (for the test rig)

A test scenario is **done** when:

1. ✅ It's documented in § 3 (existing) or § 4 (new) above.
2. ✅ It runs in <100ms with no network I/O.
3. ✅ It either asserts on `calls` or prints a `===` block a human can eyeball.
4. ✅ Its expected output is described in § 5 ("Expected output").
5. ✅ Running it after the corresponding code change does not produce silent regressions — the test must fail loudly if a behavior broke.

---

## 8. Forbidden here

- ❌ **No real network calls.** The test rig is offline. If a future phase needs to verify the verifier integration, use a local mock server (e.g. `node:http`) — never hit `api.moonshot.cn` from a test.
- ❌ **No real `fs` writes outside `os.tmpdir()`.** The sink tests will need a temp dir; never write to `.pi/harvest/` in tests (that path belongs to production).
- ❌ **No `process.exit()`** inside a scenario — the rig must run all scenarios even if one fails. Failures bubble as uncaught exceptions, not controlled exits.
- ❌ **No shared mutable state across scenarios** other than `pi._handlers`, `calls`, and the extension's own internal counters. If you find yourself needing globals, restructure.

---

## 9. Cross-refs

- Top-level rules: [`../AGENTS.md`](../AGENTS.md) — §3 Test commands
- Source under test: [`../src/AGENTS.md`](../src/AGENTS.md) — §3 Key types, §4 Hook signatures
- Mock-pi runtime shape comes from the plan's `pi.sendMessage` / `ctx.ui.setStatus` examples in `~/Downloads/Gemini-Hosting GGUF Models on Aliyun-20260921-1310.md` §"Extension Implementation"