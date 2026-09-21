# pi-harvest

> Trajectory harvester for [`pi.dev`](https://pi.dev) — watches local worker runs, intercepts compile-failure loops, audits them with an out-of-band verifier, captures active-file context, ships monthly-rotated DPO/SFT records, and distills multi-turn thrashing into optimal 1-turn training pairs.

`pi-harvest` is a `pi.dev` extension with five phases:

- **Phase 1 — telemetry.** Bash-output compiler-failure scanning, TUI status widget, warn-level notifications when thresholds trip.
- **Phase 2 — Neat Slice + audit + splice + DPO sink.** Threshold trip → extract *Neat Slice* → POST to OpenAI-compatible Verifier → rewind via `navigateTree` → inject `[STEER:K3]` → write DPO JSONL on resolution.
- **Phase 3 — production hardening.** Active-file capture with 300-line / 12 KB clamps, domain taxonomy tagging, verifier retries with exponential backoff (1 s → 2 s), full `HarvestedTrajectoryRecord` schema, `/harvest status` + `/harvest audit` slash commands.
- **Phase 4 — data lifecycle + diff-awareness + native export.** Monthly sink rotation (`trajectories_YYYY_MM.jsonl`), `git diff --unified=3` capture (200-line clamp), `/harvest export dpo` slash command that streams every sink into a HuggingFace conversational DPO file under `.pi/harvest/exports/dpo_dataset_YYYY_MM_DD.jsonl`, top-3 flaw-category telemetry in `/harvest status`.
- **Phase 5 — Trajectory Distillation (Thrashing Detection).** When the worker spends 6+ tool calls in a single turn and repeatedly edits the same files before producing a clean compile, the extension fires a background distillation call (does NOT pause the user). K3 is asked to write the optimal single-turn response that achieves the same result; the rejected text (the messy multi-turn thrash) and the K3-distilled chosen text are saved as a DPO pair with `trigger_reason: "thrashing_distillation"`.
- **Phase 6 — Semantic Quality Audits.** `/harvest review <feedback>` slash command. The user types feedback (e.g. "you forgot to hoist the drawer state to ViewModel"); the extension captures slice + active files, sends them to the Verifier (Staff Engineer prompt mode) which returns a diagnosis + steering instructions, prunes the flawed turn via `navigateTree`, and injects a `[SEMANTIC REVIEW ALERTS]` steering message. On clean resolution, the DPO pair is written with `trigger_reason: "semantic_review"` and the original human feedback preserved in `human_feedback`.

## TUI widget

```
[Harvester] Turn: 23 | Streak: 0 | Harvests: 4 | State: idle | LastAudit: 22
```

- `Turn` — turn counter (every `turn_end`).
- `Streak` — consecutive bash invocations matching a compiler signature; resets on clean output.
- `Harvests` — count of DPO records written.
- `State` — `idle` | `auditing` | `awaiting_resolution`.
- `LastAudit` — turn counter at the most recent audit trigger (omitted until first audit).

## Slash commands

All commands are registered under the single `harvest` namespace; the extension parses subcommands from the trailing args.

### `/harvest status`

Multi-line telemetry dump:

```
[Harvester]
 Status: turn=N streak=M harvests=K state=... lastAudit=T
 Verifier: <VERIFIER_BASE_URL> model=<VERIFIER_MODEL>
 Sink: <cwd>/.pi/harvest/trajectories_YYYY_MM.jsonl records=K size=NB
 Worker: <provider>:<model-id>
[Harvest Telemetry] Active Sink: trajectories_YYYY_MM.jsonl (K records)
 Top Flaws:
  1. <flaw_category_1> (N)
  2. <flaw_category_2> (N)
  3. <flaw_category_3> (N)
```

### `/harvest audit`

Forces a manual audit immediately, ignoring streak and turn-interval thresholds. Manual audits are written with `trigger_reason: "manual"`.

### `/harvest export dpo`

Streams every `.pi/harvest/trajectories*.jsonl` file (line-by-line, no full-file loads) and writes a HuggingFace conversational DPO file to:

```
<cwd>/.pi/harvest/exports/dpo_dataset_YYYY_MM_DD.jsonl
```

Each output line is:

```json
{
 "prompt":   [{ "role": "user", "content": "=== TASK ===\n...\n=== GIT DIFF ===\n...\n=== ACTIVE FILES ===\n..." }],
 "chosen":   [{ "role": "assistant", "content": "<chosen_completion>" }],
 "rejected": [{ "role": "assistant", "content": "<rejected_completion>" }],
 "flaw_category": "<flaw_category>"
}
```

Directly consumable by `trl.DPOTrainer`.

## State machine

Formalised to prevent the "stuck in awaiting_resolution" deadlock that older ad-hoc implementations suffered from:

```
idle ──(threshold trips)──▶ auditing ──(success)──▶ awaiting_resolution
  ▲                            │                          │
  │                            │                          │
  │   ┌──(failure / network)───┘                          │
  │   ▼                                                   │
  └──────────(streak drops to 0, DPO written)─────────────┘
```

- **`state === "idle"` guard** in `turn_end` prevents re-triggering while a previous audit is in flight or waiting for resolution.
- **`finally` block** in `runAudit()` resets state to `idle` (and resets `compilerFailStreak = 0`) on any network failure so a flaky verifier endpoint never permanently blocks the user.
- **`awaiting_resolution → idle` reset** in `maybeResolveAndHarvest()` fires only after a successful DPO write — every cached audit field is cleared (`lastAudit`, `lastSlice`, `lastActiveFiles`, `lastRejected`, `lastDivergenceEntryId`, `lastGitDiffSummary`).

## Trigger thresholds

| Variable | Default | Meaning |
|----------|---------|---------|
| `HARVEST_STREAK_THRESHOLD` | `3` | consecutive compile failures before emergency audit |
| `HARVEST_TURN_INTERVAL` | `30` | turns between periodic audits |

## Verifier configuration

| Variable | Required | Example |
|----------|----------|---------|
| `VERIFIER_BASE_URL` | yes | `https://api.moonshot.cn/v1` |
| `VERIFIER_API_KEY` | yes | `sk-...` |
| `VERIFIER_MODEL` | yes | `kimi-k2-0711-preview`, `deepseek-chat`, etc. |
| `HARVEST_TIMEOUT_MS` | no | `30000` (per-attempt) |
| `HARVEST_MAX_RETRIES` | no | `2` (backoff `1s → 2s`) |

**Schema** (fence stripping automatic):

```json
{
 "inferred_subtask": "string",
 "divergence_detected": "boolean",
 "divergence_turn_entry_id": "string",
 "divergence_turn": "number (legacy)",
 "flaw_category": "logic_error | misunderstood_spec | missing_knowledge | environmental | off_topic | none",
 "root_cause": "string",
 "discard_advice": "string",
 "steering_instructions": "string",
 "domain_tags": ["rust", "tauri"]
}
```

If `domain_tags` is empty in the response, the extension infers tags locally from on-disk file extensions.

## Detection signatures

Case-insensitive substring scan of bash output:

| Pattern | Source |
|---|---|
| `error[e` | rustc / clippy |
| `build failed` | npm / CI |
| `error cs` | C# / .NET |
| `failed to compile` | generic |
| `tsc: error` | TypeScript |
| `compilation failed` | generic |

## Token guardrails

- Bash stderr: 50 lines (error/panic/exception + 1 line context, warnings stripped).
- Verifier user payload: 64 KB / 16 k tokens.
- Per-file snapshot: 300 lines / 12 KB with `/* ...[truncated for harvest]... */` marker.
- Git diff: 200 lines with `[... git diff clamped for harvest ...]` marker.

## Workspace capture

When an audit fires, `captureActiveFileStates()` snapshots every file the worker touched (`write`/`edit`/`read` tool calls + `bash` command args). ENOENT, binary (NUL-byte sniff), lockfiles, and hidden directories (`.git`, `.pi`, `node_modules`, `dist`, `target`) are silently skipped and recorded as `skipped: "<reason>"`.

`extractGitDiff(cwd)` runs `git diff --unified=3` with a 5 s timeout and returns `null` (never throws) when git is missing, the directory isn't a repo, or the command times out.

## DPO data sink (Phase 4 rotation)

Successful resolutions append one JSON line to:

```
<cwd>/.pi/harvest/trajectories_YYYY_MM.jsonl
```

The filename auto-rolls on month boundary — `getSinkStats()` and the exporter always read the current month. Legacy `trajectories.jsonl` (Phase 3 default) is still discovered by `listSinkFiles()` so the exporter reads both.

Schema (`HarvestedTrajectoryRecord`):

```json
{
 "session_id": "uuid-v7",
 "timestamp": "ISO-8601",
 "worker_model": "provider:model-id",
 "verifier_model": "kimi-k2",
 "trigger_reason": "compiler_streak | periodic_turn | manual",
 "domain_tags": ["rust", "tauri"],
 "immediate_prompt": "the Inception Prompt",
 "active_files": [{ "path": "src/main.rs", "content": "...", "truncated": false }],
 "compiler_error_summary": "clamped 50-line stderr",
 "git_diff_summary": "git diff --unified=3 (200-line clamp, null when no repo/git)",
 "k3_audit": { "divergence_entry_id": "t1", "flaw_category": "logic_error", "root_cause": "...", "steering_instructions": "..." },
 "rejected_completion": "assistant text at audit time",
 "chosen_completion": "assistant text at resolution time"
}
```

## Installation

```bash
# From npm
pi install npm:pi-harvest

# From a local checkout
pi install C:\dev\pi-harvest -l --approve
```

## Uninstallation

```bash
pi uninstall pi-harvest
```

## Development

```bash
git clone https://github.com/bramburn/pi-harvest
cd pi-harvest
npm install
npm test      # 78 unit tests across slice/workspace/sink/verifier/exporter/telemetry
npm run smoke # full Phase 2 + 3 + 4 integration test
npm run build # tsc → dist/
```

## Architecture

```
src/
├── types.ts        SessionEntry / VerifierAudit / NeatSlice / ActiveFile / HarvestedTrajectoryRecord / VerifierUnavailableError
├── slice.ts        extractNeatSlice() + clampCompilerOutput() + enforcePayloadSize() + buildVerifierPayload()
├── workspace.ts    extractModifiedPaths() + captureActiveFileStates() + extractGitDiff() + inferDomainTags()
├── verifier.ts     invokeVerifier() — POST chat/completions, retries on 429/5xx (1s→2s), strict JSON, fence stripping
├── splice.ts       performSplice() — navigateTree (rewind) + sendUserMessage (steering)
├── sink.ts         currentSinkPath() + listSinkFiles() + buildTrajectoryRecord() + writeTrajectoryRecord() + countRecords() + getSinkStats()
├── exporter.ts     (NEW) mapRecordToHfDpo() + exportToHuggingFaceDPO() — streaming line-by-line converter
├── telemetry.ts    (NEW) aggregateTelemetry() + formatTelemetryForNotify() — streaming top-N flaw counts
└── index.ts        Extension entry — hooks, state machine, /harvest command, TUI widget
test/
├── slice.test.ts       16 tests
├── workspace.test.ts   17 tests (incl. git-diff failure modes)
├── sink.test.ts        22 tests (incl. Phase 4 rotation + back-compat)
├── verifier.test.ts    11 tests
├── exporter.test.ts    7 tests
└── telemetry.test.ts   7 tests
tests/
└── smoke.js        Integration test — mocked pi runtime + mocked verifier HTTP, exercises audit/splice/resolve and /harvest status + /harvest audit + /harvest export dpo
```

## Roadmap

- **Phase 1** ✅ — scaffolding, hooks, status widget, publishing pipeline.
- **Phase 2** ✅ — Neat Slice, out-of-band Verifier call, splice, DPO sink.
- **Phase 3** ✅ — workspace capture, domain taxonomy, retry/backoff, full DPO/SFT schema, slash commands.
- **Phase 4** ✅ — monthly rotation, git diffs, HF DPO exporter, telemetry aggregation.
- **Phase 5** ✅ — trajectory distillation (thrashing detection).
- **Phase 6** ✅ — semantic review via `/harvest review <feedback>`.
- **Phase 7** — multi-verifier consensus, streaming upload to S3/OSS.

## Phase 6: `/harvest review <feedback>` in detail

When the code compiles cleanly but misses something the human cares about (business logic, a missing handler, an architectural concern), the user types:

```
/harvest review you forgot to hoist the drawer state to the ViewModel
```

The extension:

1. Captures the active slice + active files just like the Phase 3 auditor.
2. POSTs to the Verifier with the human's feedback string prominent at the top of the user payload.
3. The Verifier (Staff Engineer prompt mode) returns `{ flaw_category, diagnosis, steering_instructions }`.
4. `pi.navigateTree(...)` rewinds the session to the entry just before the flawed code (collapsing it into a compaction summary).
5. `pi.sendUserMessage("[SEMANTIC REVIEW ALERTS]\nHuman Feedback: ...\nDiagnosis: ...\nAction Required: ...", { deliverAs: "steer" })` injects the steering directive.
6. State transitions to `awaiting_resolution`. When the worker produces clean output on its next turn, `maybeResolveAndHarvest()` writes a DPO record with `trigger_reason: "semantic_review"` and the human's feedback preserved in `human_feedback`.

### Reviewer prompt mode

The Verifier system prompt instructs the model as a Staff Engineer conducting a code review. Strict response schema:

```json
{ "flaw_category": "string", "diagnosis": "string", "steering_instructions": "string" }
```

Same retry/backoff/fence-stripping/timeout policy as the other Verifier modes. Same env vars: `VERIFIER_BASE_URL`, `VERIFIER_API_KEY`, `VERIFIER_MODEL`.

## Phase 5: thrashing detection in detail

The Phase 3 audit only fires on **compile failures**. Phase 5 catches **inefficiency**: when the worker succeeds after a long sequence of edits to the same files, that's a high-value training signal — "the worker could have done this in one shot."

## Phase 5: thrashing detection in detail

The Phase 3 audit only fires on **compile failures**. Phase 5 catches **inefficiency**: when the worker succeeds after a long sequence of edits to the same files, that's a high-value training signal — "the worker could have done this in one shot."

### Trigger

In `turn_end`, when:
1. `toolResults.length >= HARVEST_THRASHING_THRESHOLD` (default `6`)
2. The final tool result was a clean bash (no compiler signature)
3. At least one file was edited 2+ times during the turn (rework signal — distinguishes planned scaffolding from thrashing)

### Behaviour

- Fire-and-forget. The user's interactive session is **never paused** — distillation runs in a background Promise.
- A `thrashingStreak` counter accumulates tool-call counts across consecutive thrashing turns, then resets when any of the three trigger conditions fail.
- `distillationInFlight` prevents stacking; only one distillation runs at a time.
- On any verifier error (including exhaustion), the streak is reset and a `warn` notification is emitted — the session continues.

### DPO record

```json
{
 "trigger_reason": "thrashing_distillation",
 "immediate_prompt": "the original user task that started the thrash",
 "rejected_completion": "concatenated assistant text across the thrashing turns",
 "chosen_completion": "the K3-distilled optimal single-turn response",
 "k3_audit": { "flaw_category": "thrashing", ... }
}
```

### Distiller prompt mode

`invokeDistiller({cwd, slice, activeFiles})` uses a different system prompt than the error auditor:

> You are a Principal Software Architect. The junior worker model took an inefficient, multi-turn trial-and-error path to arrive at the working code provided in the active files. Your task is Hindsight Relabeling. Write the optimal, single-turn assistant response that provides this exact solution directly and elegantly, as if it got it right on the first try.

The response schema is strict:

```json
{ "distilled_chosen_completion": "string" }
```

Same retry/backoff policy as the error auditor (`HARVEST_MAX_RETRIES`, 1 s → 2 s exponential backoff, `response_format: json_object`, markdown fence stripping).

## Roadmap

- **Phase 1** ✅ — scaffolding, hooks, status widget, publishing pipeline.
- **Phase 2** ✅ — Neat Slice, out-of-band Verifier call, splice, DPO sink.
- **Phase 3** ✅ — workspace capture, domain taxonomy, retry/backoff, full DPO/SFT schema, slash commands.
- **Phase 4** ✅ — monthly rotation, git diffs, HF DPO exporter, telemetry aggregation.
- **Phase 5** ✅ — trajectory distillation.
- **Phase 6** — multi-verifier consensus, streaming upload to S3/OSS.

## License

[MIT](./LICENSE)
