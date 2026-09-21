# pi-harvest

> Trajectory harvester for [`pi.dev`](https://pi.dev) — watches local worker runs, intercepts compile-failure loops, audits them with an out-of-band verifier, captures active-file context, and writes production-grade DPO/SFT records to disk.

`pi-harvest` is a `pi.dev` extension with three phases:

- **Phase 1 — telemetry.** Tracks bash output for compiler-failure signatures, surfaces a TUI status widget, and emits warn-level notifications when thresholds trip.
- **Phase 2 — Neat Slice + audit + splice + DPO sink.** When a threshold trips, the extension extracts the *Neat Slice*, POSTs it to an OpenAI-compatible Verifier endpoint, navigates the session tree back to before the divergence, injects a `[STEER:K3]` directive, and writes a DPO JSON line when the worker resolves.
- **Phase 3 — production hardening.** Active-file state capture with 300-line / 12 KB clamps, domain taxonomy tagging (rust/tauri, csharp/dotnet, flutter, shopify/liquid, typescript), verifier retries with exponential backoff (1 s → 2 s) on 429/5xx, full HarvestedTrajectoryRecord schema (active_files, worker_model, verifier_model, trigger_reason, nested k3_audit), and `/harvest status` + `/harvest audit` slash commands.

## TUI widget

```
[Harvester] Turn: 23 | Streak: 0 | Harvests: 4 | State: idle
```

- `Turn` — turn counter (increments on every `turn_end`).
- `Streak` — consecutive bash invocations matching a compiler-failure signature; resets on clean output.
- `Harvests` — count of DPO records written.
- `State` — `idle` | `auditing` | `awaiting_resolution`.

## Slash commands

### `/harvest status`

Prints a multi-line telemetry summary to the TUI notification channel:

```
[Harvester]
 Status: turn=N streak=M harvests=K state=...
 Verifier: <VERIFIER_BASE_URL> model=<VERIFIER_MODEL>
 Sink: <cwd>/.pi/harvest/trajectories.jsonl records=K size=NB
 Worker: <provider>:<model-id>
```

### `/harvest audit`

Forces a manual audit immediately, ignoring streak and turn-interval thresholds. Sets `trigger_reason: "manual"` on the resulting record (if it resolves cleanly).

## Trigger thresholds

Both env-overridable:

| Variable | Default | Meaning |
|----------|---------|---------|
| `HARVEST_STREAK_THRESHOLD` | `3` | consecutive compile failures before emergency audit |
| `HARVEST_TURN_INTERVAL` | `30` | turns between periodic audits |

## Verifier configuration

Generic OpenAI-compatible `chat/completions`. All three required when an audit fires; missing vars produce a warn notification and the audit is retried on the next threshold trip.

| Variable | Required | Example |
|----------|----------|---------|
| `VERIFIER_BASE_URL` | yes | `https://api.moonshot.cn/v1` |
| `VERIFIER_API_KEY` | yes | `sk-...` |
| `VERIFIER_MODEL` | yes | `kimi-k2-0711-preview`, `deepseek-chat`, etc. |
| `HARVEST_TIMEOUT_MS` | no | `30000` (per-attempt timeout, default 30 s) |
| `HARVEST_MAX_RETRIES` | no | `2` (total attempts = retries + 1; backoff `1s → 2s`) |

**Resilience:** on HTTP 429 / 500 / 502 / 503 / 504 or network timeout, the extension retries with exponential backoff (1 s → 2 s). When all retries fail it emits `Verifier endpoint unavailable. Continuing unsteered.` and resets `compilerFailStreak = 0` so a flaky endpoint never stalls the user's interactive session.

**Strict response schema** (the extension strips ` ```json ` fences automatically):

```json
{
 "inferred_subtask": "string",
 "divergence_detected": "boolean",
 "divergence_turn_entry_id": "string (entry id where divergence began; preferred)",
 "divergence_turn": "number (1-based slice-relative; legacy fallback)",
 "flaw_category": "logic_error | misunderstood_spec | missing_knowledge | environmental | off_topic | none",
 "root_cause": "string",
 "discard_advice": "string",
 "steering_instructions": "string",
 "domain_tags": ["rust", "tauri", ...]
}
```

If `domain_tags` is empty in the response, the extension infers tags locally from file paths on disk.

## Detection signatures

Bash-output scanner matches these substrings case-insensitively:

| Pattern              | Source                            |
| -------------------- | --------------------------------- |
| `error[e`            | rustc / clippy                    |
| `build failed`       | npm / generic CI                  |
| `error cs`           | C# / .NET (`error CS1003`)        |
| `failed to compile`  | generic compilers                 |
| `tsc: error`         | TypeScript compiler               |
| `compilation failed` | generic                           |

## Token guardrails

Compiler stderr is clamped to 50 lines (error/panic/exception lines + 1 line context, warnings stripped) before being sent to the verifier. The full user payload is clamped to **64 KB / 16 k tokens** before the HTTP POST.

## Workspace capture

When an audit fires, `captureActiveFileStates()` snapshots every file the worker touched during the failing sequence (detected from `write`/`edit`/`read` tool calls and `bash` command arguments). Each snapshot is clamped to **300 lines / 12 KB** with a `/* ...[truncated for harvest]... */` marker. ENOENT, binary files (NUL-byte sniff), lockfiles (`Cargo.lock`, `package-lock.json`, …), and hidden directories (`.git`, `.pi`, `node_modules`, `dist`, `target`) are silently skipped — recorded as `skipped: "<reason>"` on the `ActiveFile` record.

## DPO data sink

Successful resolutions append one JSON line to:

```
<cwd>/.pi/harvest/trajectories.jsonl
```

Phase 3 `HarvestedTrajectoryRecord` schema:

```json
{
 "session_id": "uuid-v7",
 "timestamp": "ISO-8601",
 "worker_model": "provider:model-id",
 "verifier_model": "kimi-k2-0711-preview",
 "trigger_reason": "compiler_streak | periodic_turn | manual",
 "domain_tags": ["rust", "tauri"],
 "immediate_prompt": "the Inception Prompt text",
 "active_files": [
 { "path": "src/main.rs", "content": "...", "truncated": false,
 "skipped": "missing | binary | lockfile | hidden | too_large | read_error" }
 ],
 "compiler_error_summary": "clamped first-50-lines compiler stderr",
 "k3_audit": {
 "divergence_entry_id": "t1",
 "flaw_category": "logic_error",
 "root_cause": "...",
 "steering_instructions": "..."
 },
 "rejected_completion": "assistant text at audit time",
 "chosen_completion": "assistant text at resolution time"
}
```

The directory is auto-created (`mkdirSync` with `recursive: true`) on first write.

## Installation

### From npm (recommended for users)

```bash
pi install npm:pi-harvest
```

### From a local checkout (development loop)

```bash
pi install C:\dev\pi-harvest -l --approve
```

- `-l` — install from a local path instead of the registry.
- `--approve` — skip the interactive approval prompt (required in non-interactive shells).

After editing source or rebuilding, restart pi for changes to take effect.

### Set the verifier env vars

```bash
# Windows (PowerShell)
$env:VERIFIER_BASE_URL = "https://api.moonshot.cn/v1"
$env:VERIFIER_API_KEY = "sk-..."
$env:VERIFIER_MODEL = "kimi-k2-0711-preview"

# bash / WSL
export VERIFIER_BASE_URL="https://api.moonshot.cn/v1"
export VERIFIER_API_KEY="sk-..."
export VERIFIER_MODEL="kimi-k2-0711-preview"
```

Or copy `.env.example` to `.env` and load it before starting pi.

## Uninstallation

```bash
pi uninstall pi-harvest
```

## Development

```bash
git clone https://github.com/bramburn/pi-harvest
cd pi-harvest
npm install
npm test      # 52 unit tests (slice/workspace/sink/verifier) via node --experimental-strip-types
npm run smoke # full Phase 2 + Phase 3 integration test (mocked pi + mock verifier)
npm run build # tsc → dist/
```

## Architecture

```
src/
├── types.ts        SessionEntry / VerifierAudit / NeatSlice / ActiveFile / HarvestedTrajectoryRecord / VerifierUnavailableError
├── slice.ts        extractNeatSlice() + serializeSliceForVerifier() + clampCompilerOutput() + enforcePayloadSize() + buildVerifierPayload()
├── workspace.ts    extractModifiedPaths() + captureActiveFileStates() + clampFileContent() + shouldSkipPath() + inferDomainTags()
├── verifier.ts     invokeVerifier() — POST {BASE}/chat/completions, retries on 429/5xx (1s→2s), strict JSON, fence stripping
├── splice.ts       performSplice() — navigateTree (rewind) + sendUserMessage (steering)
├── sink.ts         buildTrajectoryRecord() + writeTrajectoryRecord() + getSinkStats() + writeDpoEntry() (Phase 2 compat)
└── index.ts        Extension entry — hooks, state machine, /harvest command, TUI widget
test/
├── slice.test.ts       16 tests (inception lookup, code/error extraction, clamp, payload guard, payload assembly)
├── workspace.test.ts   14 tests (skip rules, path extraction, line truncation, binary detection, ENOENT, domain inference)
├── sink.test.ts        7 tests (record construction, append, count, stats, Phase 2 compat)
└── verifier.test.ts    11 tests (fence stripping, schema validation, env guard, retry semantics, exhaustion)
tests/
└── smoke.js        Integration test — mocked pi runtime + mocked verifier HTTP, exercises audit/splice/resolve and /harvest status + /harvest audit
```

## Roadmap

- **Phase 1** ✅ — scaffolding, hooks, status widget, publishing pipeline.
- **Phase 2** ✅ — Neat Slice, out-of-band Verifier call, splice, DPO sink.
- **Phase 3** ✅ — workspace capture, domain taxonomy, token clamps, retry/backoff, full DPO/SFT schema, slash commands.
- **Phase 4** — auto-DPO upload + prepare_dpo_dataset.py shim, multi-verifier consensus.

## License

[MIT](./LICENSE)
