# AGENTS.md — `pi-harvest`

> Pattern: see `docs/AGENTS_MD_PATTERN.md` (mirrors the convention used by `c:/dev/audio-lessons/`).
> Source spec: `~/Downloads/Gemini-Hosting GGUF Models on Aliyun-20260921-1310.md` (the "plan").
> Working dir: `C:\dev\pi-harvest` on Windows Server 2019, Node ≥ 18, TypeScript → `dist/`.

`pi-harvest` is a **`pi.dev` extension** that implements a *Hierarchical Commander–Worker* trajectory-capture system. A cheap/fast **Worker** model (e.g. MiniMax-M3, Ollama llama-server, local Qwen2.5-Coder-32B-Q4) does the day-to-day coding. A frontier **Verifier/Commander** (Kimi K3 / DeepSeek Flash 4.1) is called out-of-band — *only when the worker is drifting* — to perform **Credit Assignment** (find the divergence turn), emit **Steering Instructions**, and append a high-signal **DPO training pair** to `.pi/harvest/trajectories.jsonl`.

The system is designed for **months of organic data capture** so the user can eventually fine-tune a local Qwen coder model on their real stack (Rust/Tauri, .NET C#, Flutter, Shopify Liquid/OS 2.0, TypeScript).

---

## 1. Repo map

| Path | What it owns |
|------|--------------|
| `src/` | Extension source. Phase 1 ships as a single `index.ts`; later phases will split into `verifier/`, `slice/`, `splice/`, `sink/`, `commands/` (see § 6 / [src/AGENTS.md](./src/AGENTS.md)). |
| `src/index.ts` | Extension entry — `pi.on("tool_result")` + `pi.on("turn_end")` lifecycle hooks. Owns local state (`turnCounter`, `compilerFailStreak`). |
| `dist/` | `tsc` build output. `main` in `package.json` points at `dist/index.js`. **Never edit by hand.** |
| `tests/` | Smoke tests for the compiled extension against a mock pi runtime. See [tests/AGENTS.md](./tests/AGENTS.md). |
| `package.json` | npm metadata, `build` / `prepublishOnly` scripts, `engines: node >= 18`. |
| `tsconfig.json` | `target: ES2022`, `module: CommonJS`, `outDir: dist`, `strict: true`. |
| `.pi/` | pi runtime state (settings, loops). **Gitignored**; this is where the harvest sink will live (Phase 4 → `.pi/harvest/trajectories.jsonl`). |
| `.gitignore` | Ignores `node_modules/`, `dist/`, `.pi/`, `.env`, IDE/OS junk. |
| `LICENSE` | MIT (© 2026 bramburn). |
| `README.md` | User-facing docs — install / dev loop / uninstall / detection signatures / roadmap. |

---

## 2. Build & run commands

All commands run from `C:\dev\pi-harvest` unless noted.

```bash
# Install deps
npm install

# Build (TypeScript → dist/)
npm run build

# Run the smoke test against the compiled extension
node tests/smoke.js

# Lint (optional — not yet wired)
# npx tsc --noEmit
```

### Local install into pi (dev loop)

```bash
pi install C:\dev\pi-harvest -l --approve
```

`pi install -l` reads from a local path instead of the npm registry. `--approve` skips the interactive y/N prompt that would hang a non-interactive agent shell.

### Publish to npm (release flow)

```bash
# pre-publish build runs automatically via prepublishOnly
npm version patch          # bump version
npm publish --access public
```

If npm prompts for a **2FA OTP**, **pause and ask the user** — do not guess or retry blindly.

---

## 3. Test commands

| Command | What it covers |
|---------|----------------|
| `npm run build` | TypeScript compile; must succeed with `strict: true`. |
| `node tests/smoke.js` | Drives a mock `pi` runtime through 7 scenarios (clean output, rust errors ×3, streak reset, non-bash tools ignored, case-insensitive scan, 30-turn interval). |
| `pi install C:\dev\pi-harvest -l --approve` | End-to-end install in a real pi session — `[Harvester] Turn: 0 \| Streak: 0` widget should appear in the status bar. |

CI is not yet configured. Tests are run locally before every `npm publish`.

---

## 4. Architectural rules (the "never do this" list)

These rules are **opinionated** and trace back to the plan. They exist to protect the user's 25–30 B tokens/month budget and to keep the harvested dataset high-signal.

### Token economy

- **One LLM call per audit.** The Neat Slice engine (§ 6) assembles the prompt, active-file state, and rejected completion **locally**, sends *one* POST to the verifier, and does the rest in-memory. Adding a second LLM call per audit is a budget violation.
- **No LLM calls for slicing.** Locating the inception prompt, reading active files, parsing compiler stderr — all local TypeScript array/string logic. The plan is explicit that K3 already does the cognitive work during its single audit; we piggyback `inferred_subtask` on that call instead of asking again.
- **Periodic audits are off by default in Phase 2+.** The plan pivoted away from `turn % 30 === 0` toward *event-driven* triggers (3× consecutive compiler failures). Periodic audits are kept as a safety valve but must be opt-in via env var.

### Data shape

- **The harvest sink is append-only JSONL.** No SQLite, no Parquet, no embedded DB. JSONL keeps the schema diff-able in git for a while and is trivially mappable to `trl` DPO format via `prepare_dpo_dataset.py` (see § 8).
- **Every harvested record has the DPO triplet:** `prompt` (sliced context), `chosen` (post-steer successful completion), `rejected` (pre-steer broken completion). A record missing any of the three is dropped, not stored half-formed.
- **Message tiers are tagged, not inferred.** The extension prefixes `[STEER:K3]` (or `[STEER:DEEPSEEK]`) on every synthetic steering message so downstream slicers can distinguish supervisor interventions from user prompts (Tier 3 vs. Tier 2 vs. Tier 1 — see § 6).

### Cross-area boundaries

| Tree | May do | May NOT do |
|------|--------|------------|
| `pi-harvest/` (the extension) | Inspect `pi.dev` lifecycle events, write to `.pi/harvest/*.jsonl`, call the verifier API | Touch the user's source files directly outside the steer — no `git reset`, no auto-revert. The extension *steers*; the worker *writes*. |
| `pi-harvest/` | Read environment variables (`VERIFIER_API_KEY`, `VERIFIER_BASE_URL`, `VERIFIER_MODEL`) | Hardcode API keys, base URLs, or model IDs in source. |
| `pi-harvest/` | Subscribe to `tool_result`, `turn_end` | Subscribe to events that fire mid-generation — we only act on completed turns and finished tool calls. |

---

## 5. Conventions

### Naming

- **Files:** `kebab-case.ts` for new modules (e.g. `verifier-client.ts`, `slice-engine.ts`, `dpo-sink.ts`). Single-word `index.ts` is allowed for the entry only.
- **Functions/variables:** `camelCase`.
- **Constants:** `SCREAMING_SNAKE_CASE` (e.g. `COMPILER_FAILURE_SIGNATURES`, `TURN_INTERVAL`).
- **Types/interfaces:** `PascalCase`, no `I` prefix (use `ExtensionAPI`, not `IExtensionAPI`).

### Module shape (target for Phase 2+)

```
src/
├── index.ts              # lifecycle wiring only; delegates everything
├── types.ts              # ExtensionAPI, PiContext, AuditResult, TieredMessage
├── signatures.ts         # COMPILER_FAILURE_SIGNATURES + regex builder
├── verifier/
│   ├── client.ts         # POST to K3 / DeepSeek, JSON schema enforcement
│   └── prompt.ts         # the audit system prompt + schema definition
├── slice/
│   ├── engine.ts         # Neat Slice — backward traversal, inception prompt
│   └── tiers.ts          # Tier 1 / Tier 2 / Tier 3 classification
├── splice/
│   └── engine.ts         # Context surgery — prune + steer inject
├── sink/
│   └── jsonl.ts          # Append-only .pi/harvest/trajectories.jsonl writer
└── commands/
    └── audit.ts          # /k3-audit slash command handler
```

Phase 1 keeps everything in `index.ts`. Phases 2–6 split into the structure above *only when each module exceeds ~150 lines*.

### Code style

- **Strict TypeScript.** No `any` outside `index.ts`'s event handler signatures (`event: unknown`). No `@ts-ignore`.
- **Lowercase before regex test** for every output scan. The plan's failure criterion is specifically "parser fails to lowercase the output, causing it to miss case-sensitive compiler errors." Always `[s, o, e].filter(...).join("\n").toLowerCase()` before `SIGNATURE_REGEX.test()`.
- **No `console.log` in production paths.** Use `ctx.ui.notify()` or `ctx.ui.setStatus()` for user-visible state; reserve `console.error` for fatal verifier-API failures.
- **Side-effect imports are forbidden.** Only `node:fs` / `node:path` / `node:crypto` are allowed; no npm deps until the first verifier client lands.

### Git rules

- **One focused commit per phase milestone.** Format: `feat(phase-N): <one-line>`.
- **`main` is the source of truth.** Tags: `v0.1.0` after first npm publish, then `vX.Y.Z` per release.
- **Never `git push --force`** to `main`. PRs are not yet required (solo project) but commit messages must reference the phase / plan section they implement.

---

## 6. Opinionated architecture

These are the deliberate trade-offs baked into the design — taken from the plan, not invented here.

### The Commander–Worker split

- **Worker is local + cheap.** Default assumption: MiniMax-M3 (per the plan) or whatever Ollama/llama-server model the user has running. The extension **does not** care which one; it just watches tool output and turn boundaries.
- **Commander is API + expensive.** Kimi K3 (default) or DeepSeek Flash 4.1 (fallback, set via `VERIFIER_PROVIDER=deepseek`). Called only when triggered.
- **Why this split:** 95% of routine coding is local; only ~5% needs frontier reasoning. The plan's cost analysis puts the API spend at 1–2 orders of magnitude below a frontier-routed loop.

### Hierarchical Commander–Worker with delayed policy steering

The plan's pattern (also known as "supervisor-worker with periodic trajectory audit") has three operational states:

1. **Routine Worker Loop** — `turn_end` increments counter, `tool_result` updates streak. Worker is uninterrupted.
2. **Diagnostic Interception** — when a trigger fires, the worker is paused, the verifier is called *once*, and the audit JSON is parsed.
3. **Context Splice & Dataset Sinks** — the broken turns are pruned from the in-memory chat, K3's `steering_instructions` are injected via `pi.sendMessage(..., { deliverAs: "steer", triggerTurn: true })`, and an async fork writes the DPO pair to disk.

### The Neat Slice Engine (causal-mismatch fix)

The plan explicitly calls out the *causal mismatch* problem: a high-level prompt like *"Build an image-processing API"* cannot be paired with a 15-line helper that fails 18 turns later. The fix:

1. **Backward-traverse** the session to find the *last user instruction* that initiated the current micro-task. Everything before that is dropped from the harvested pair.
2. **Snapshot active files** via `fs.readFileSync` on the paths the worker has been editing.
3. **Extract the flawed execution** (the rejected completion) and the compiler stderr from the same turn window.
4. **Single verifier call** with the bundled slice + a schema that asks K3 to return `inferred_subtask` *in the same response*.
5. **Capture the resolution** — the first successful worker generation after the steering directive.

The user's prompt in the harvested record is the **immediate task** (from K3's `inferred_subtask`), not the original epic. This is what makes the DPO pairs learnable.

### Causal boundaries: Tier 1 / Tier 2 / Tier 3

The plan classifies every message in the session into three tiers. The extension **must** honor these:

- **Tier 1 — Root Epic:** the first substantive user message. Goes into the `system` slot of the harvested prompt.
- **Tier 2 — User Nudges:** short mid-stream corrections (e.g. *"actually, use port 8080"*). Appended to the prompt as active constraints.
- **Tier 3 — Supervisor Steer:** anything the extension itself injects. Prefixed with `[STEER:K3]` or `[STEER:DEEPSEEK]`. **Never** treated as a user prompt.

The `[STEER:K3]` prefix is load-bearing — without it, downstream slicers cannot distinguish a synthetic supervisor message from a real user instruction, and the DPO pair becomes useless.

### Code correction vs. code rollback

When the verifier flags a divergence at turn 14 and the worker is currently at turn 22, the extension:

- **Does** prune turns 14–22 from the *in-memory chat* (so the worker doesn't attend across its own hallucinations).
- **Does NOT** run `git checkout`, `git reset`, or revert any files on disk. The plan is explicit: this would clobber any manual edits the user made.
- **Does** inject K3's `steering_instructions` as a high-priority `deliverAs: "steer"` message that tells the worker to *overwrite* the broken files with the corrected code.

The worker writes the fix; the extension just sets the stage.

### One audit = one API call (the budget rule)

The plan's most-cited constraint: *"For every automated course correction, there is exactly **one** API call made to the expensive frontier model. Everything else is just local string manipulation and file reading."*

If a future refactor needs a second LLM call (e.g. to summarize the K3 response, or to validate the corrected code), **that's a Phase 7+ problem**, not a Phase 2–6 assumption. Phase 2–6 stays at exactly one verifier call per audit.

### Interaction with `@tintinweb/pi-subagents`

When the parent session dispatches a subagent via `@tintinweb/pi-subagents` (or any extension that spawns child `AgentSession` instances via `createAgentSession`), pi-harvest **continues to work** without any code changes — but with these deliberate behavioral caveats:

- **Hooks fire per-session, not globally.** Each subagent runs in its own `AgentSession` with its own `ExtensionRunner`. pi-harvest's `pi.on("tool_result")` and `pi.on("turn_end")` registrations land on the subagent's runner, so a 3-streak compiler failure inside a subagent triggers an audit *in that subagent's session*, not the parent's. This is the right behavior: the verifier should audit the worker that's drifting.
- **State is per-subagent.** `compilerFailStreak` and `turnCounter` are module-locals in `src/index.ts`. Each subagent gets its own counter pair. The parent's UI shows only the parent's counters; subagent counters live in each subagent's UI context (`ctx.ui` is session-scoped).
- **Status widget split.** `[Harvester] Turn: N | Streak: M` renders in whichever session currently owns the UI. Subagent sessions show their own widget; the parent won't see subagent streaks unless bridged via `pi.events` (`subagents:created/started/completed/failed/steered/compacted`).
- **Shared sink, concurrent writers.** `.pi/harvest/trajectories.jsonl` is filesystem-shared. Parent + N subagents all append to the same JSONL. Append-only design tolerates it; the DPO pipeline downstream must accept multi-session provenance per file. A `sessionId` field on each record is deferred to Phase 5.
- **`isolated: true` opts out by design.** Any subagent marked `isolated: true` in its agent config gets `extensions: false` per pi-subagents' isolation semantics — pi-harvest is silently skipped there. This matches pi-subagents' intent and is not a bug.
- **Default load.** All built-in pi-subagents agents (`general-purpose`, `Explore`, `Plan`, `statusline-setup`) declare `extensions: true` — meaning all parent-session extensions (including pi-harvest) load into the subagent by default. No opt-in needed for the common case.
- **`/harvest` command availability.** The slash command registers per-session. It works inside any subagent session that has pi-harvest loaded; the resulting audit + splice operate on that subagent's own chat context.

If subagent-aware aggregation is ever needed (parent UI shows aggregate streak across all children), it lives in Phase 7+ and goes through `pi.events` — never by sharing module-local state across sessions.

---

## 7. Phased roadmap

| Phase | Status | What ships |
|-------|--------|------------|
| **Phase 1** ✅ | Done | Scaffold, hooks, TUI status widget, `npm publish` pipeline, smoke test. `turn_end` + `tool_result` fire `ctx.ui.notify()` on trigger. |
| **Phase 2** | Next | `verifier/client.ts` — POST to K3/DeepSeek, parse JSON schema. Replace `notify()` with a real audit call. |
| **Phase 3** | Planned | `slice/engine.ts` — backward-traverse session, find inception prompt, snapshot active files. |
| **Phase 4** | Planned | `splice/engine.ts` — `ctx.sessionManager.prune(...)` + `pi.sendMessage(..., {deliverAs: "steer"})`. |
| **Phase 5** | Planned | `sink/jsonl.ts` — append `.pi/harvest/trajectories.jsonl`. Pair `chosen` (next-pass worker) with `rejected` (pre-steer). |
| **Phase 6** | Planned | `commands/audit.ts` — manual `/k3-audit` slash command. Status widget polish. |
| **Phase 7+** | Out of scope | Periodic audit opt-in, multi-verifier consensus, auto-DPO conversion script. |

After Phase 5: `prepare_dpo_dataset.py` (per the plan's offline parser) converts `trajectories.jsonl` into the Hugging Face conversational DPO format for downstream Unsloth fine-tuning of Qwen2.5-Coder-32B.

---

## 8. Agent workflow pointers

### Read the plan first

The full architectural intent lives in `~/Downloads/Gemini-Hosting GGUF Models on Aliyun-20260921-1310.md`. Sections referenced by this AGENTS.md:

- §"Hierarchical Commander-Worker" → §6 here
- §"The Neat Slice Engine" → §6 / [src/AGENTS.md](./src/AGENTS.md) §"Slice module"
- §"Dataset Schema" → §4 / [src/AGENTS.md](./src/AGENTS.md) §"Sink module"
- §"Implementation Action List for the LLM" → §7 roadmap
- §"Tokenizer math" → never exceed 4–8k tokens per sliced context

### Status vocabulary (when reporting progress)

- ✅ **Phase X done** — `npm run build` clean, smoke test green, extension loads in pi with status widget visible.
- ⚠️ **Phase X partial** — wired but one branch untested. Call out which branch.
- ❌ **Phase X blocked** — dependency missing or plan ambiguity. Stop and ask.

### Evidence requirement

Every status update must include:

1. The command run (`npm run build`, `node tests/smoke.js`, etc.)
2. The relevant exit code or output snippet
3. The file(s) changed (path only — the diff speaks for itself)

### Escalation rule

If a phase requires a **foundational** decision (e.g. "should we add SQLite alongside JSONL?", "should the verifier default to K3 or DeepSeek?"), **stop and ask the user**. Use the `ask_user_question` tool with concrete options. The plan's audit-trigger logic in particular should not be changed without explicit user sign-off — every token audit costs money.

---

## 9. Safety boundaries

### No-touch zones

- ❌ **`dist/`** — generated by `tsc`. Never hand-edit. If `dist/` is dirty, `rm -rf dist && npm run build`.
- ❌ **`.pi/`** — pi runtime state + (eventually) the harvest sink. Never commit; never clean without asking the user (the harvested trajectories are the whole point of this extension).
- ❌ **`.env`** — gitignored. If you need to verify env vars are set, ask the user to confirm; never echo them back into logs.

### Forbidden operations

- ❌ **Never log API keys.** Even in `console.error` for a failed verifier call. Redact as `<redacted>` in any debug output.
- ❌ **Never run `npm publish` without explicit user authorization.** The 2FA prompt is a feature, not a bug — the user wants to know before publishing.
- ❌ **Never auto-revert user code.** The extension steers; the worker writes. `git reset` / `git checkout -- <file>` are forbidden from inside the extension.
- ❌ **Never bypass the Neat Slice.** If you're tempted to send the full session transcript to the verifier because "the inception prompt is hard to find," that's a sign the slice engine is broken, not a sign that bypassing it is OK.

### Sensitive data

- The harvested JSONL contains **the user's actual code, prompts, compiler errors, and API call timestamps**. It is gitignored by design. When the user eventually wants to upload it for fine-tuning, route it through the user's own OSS / S3 / object store — never a third-party service without their explicit OK.
- Verifier API calls contain the user's active file contents. Treat the K3/DeepSeek endpoint the same way you would treat a shared pastebin.

---

## 10. Child files index

| Path | Purpose |
|------|---------|
| [src/AGENTS.md](./src/AGENTS.md) | Source code conventions, module split, key types, hook signatures. |
| [tests/AGENTS.md](./tests/AGENTS.md) | Smoke test scenarios, mock-pi runtime shape, what "green" means for a phase. |

When Phase 2 lands, add:

- `src/verifier/AGENTS.md`
- `src/slice/AGENTS.md`
- `src/splice/AGENTS.md`
- `src/sink/AGENTS.md`
- `src/commands/AGENTS.md`