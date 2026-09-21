# pi-harvest

> Trajectory harvester for [`pi.dev`](https://pi.dev) — watches local worker runs, intercepts compile-failure loops, audits them with an out-of-band verifier model, splices out the poisoned context, and writes DPO training pairs to disk.

`pi-harvest` is a `pi.dev` extension with two phases:

- **Phase 1 — telemetry.** Tracks bash output for compiler-failure signatures, surfaces a TUI status widget, and emits warn-level notifications when thresholds trip.
- **Phase 2 — Neat Slice + audit + splice + DPO sink.** When a threshold trips, the extension extracts the *Neat Slice* (conversation back to the most recent user message), POSTs it to an OpenAI-compatible Verifier endpoint, navigates the session tree back to before the divergence, injects a `[STEER:K3]` directive via `pi.sendUserMessage(...)`, and — once the worker produces clean output — writes a flat DPO JSON line to `<cwd>/.pi/harvest/trajectories.jsonl`.

## TUI widget

```
[Harvester] Turn: 23 | Streak: 0 | Harvests: 4 | State: idle
```

- `Turn` — turn counter (increments on every `turn_end`).
- `Streak` — consecutive bash invocations that matched a compiler-failure signature; resets on clean output.
- `Harvests` — count of DPO entries written.
- `State` — `idle` | `auditing` | `awaiting_resolution`.

## Trigger thresholds

Two thresholds, both env-overridable:

| Variable | Default | Meaning |
|----------|---------|---------|
| `HARVEST_STREAK_THRESHOLD` | `3` | consecutive compile failures before emergency audit |
| `HARVEST_TURN_INTERVAL` | `30` | turns between periodic audits |

## Verifier configuration (Phase 2)

The Verifier is a generic OpenAI-compatible `chat/completions` endpoint. All three vars are required when an audit fires; missing vars produce a warn notification and the audit is retried on the next threshold trip.

| Variable | Required | Example |
|----------|----------|---------|
| `VERIFIER_BASE_URL` | yes | `https://api.moonshot.cn/v1` |
| `VERIFIER_API_KEY` | yes | `sk-...` |
| `VERIFIER_MODEL` | yes | `kimi-k2-0711-preview`, `deepseek-chat`, etc. |
| `HARVEST_TIMEOUT_MS` | no | `30000` (HTTP timeout, default 30s) |

The extension enforces a strict response schema on the Verifier reply:

```json
{
 "inferred_subtask": "string",
 "divergence_detected": "boolean",
 "divergence_turn": "number (1-based, slice-relative)",
 "flaw_category": "logic_error | misunderstood_spec | missing_knowledge | environmental | off_topic | none",
 "root_cause": "string",
 "discard_advice": "string",
 "steering_instructions": "string"
}
```

The extension strips ` ```json ` fences automatically before parsing.

## Detection signatures

The bash-output scanner matches these substrings case-insensitively:

| Pattern              | Source                            |
| -------------------- | --------------------------------- |
| `error[e`            | rustc / clippy                    |
| `build failed`       | npm / generic CI                  |
| `error cs`           | C# / .NET (`error CS1003`)        |
| `failed to compile`  | generic compilers                 |
| `tsc: error`         | TypeScript compiler               |
| `compilation failed` | generic                           |

## DPO data sink

Successful resolutions (audit triggered → worker fixed → clean compile) append a single JSON line to:

```
<cwd>/.pi/harvest/trajectories.jsonl
```

One line per resolved episode. Schema:

```json
{
 "session_id": "uuid-v7",
 "domain_tags": [],
 "k3_diagnosis": { /* the full VerifierAudit */ },
 "immediate_prompt": "the Inception Prompt text",
 "rejected_completion": "assistant text at audit time",
 "chosen_completion": "assistant text at resolution time",
 "ts": "ISO-8601"
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

Before Phase 2 audits will work, set the three `VERIFIER_*` env vars. Either:

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

Only one source (npm or local) can be active at a time.

## Development

```bash
git clone https://github.com/bramburn/pi-harvest
cd pi-harvest
npm install
npm test      # 25 unit tests (verifier, slice, sink)
npm run smoke # full Phase 2 integration test (mocked pi + mock verifier)
npm run build # tsc → dist/
```

## Architecture

```
src/
├── types.ts        SessionEntry / VerifierAudit / NeatSlice / DpoEntry
├── slice.ts        extractNeatSlice() + serializeSliceForVerifier() + entryIdForDivergenceTurn()
├── verifier.ts     invokeVerifier() — POST {BASE}/chat/completions, strict JSON, fence stripping
├── splice.ts       performSplice() — navigateTree (rewind) + sendUserMessage (steering)
├── sink.ts         writeDpoEntry() — appendFileSync to <cwd>/.pi/harvest/trajectories.jsonl
└── index.ts        Extension entry — hooks, state machine, TUI widget
tests/
├── verifier.test.js   8 tests (fence stripping, schema validation, mocked HTTP)
├── slice.test.js      9 tests (inception lookup, code/error extraction, turn→entry mapping)
├── sink.test.js       2 tests (mkdir, append, JSON schema)
└── smoke.js           1 integration test (full Phase 2 flow with mocked pi runtime)
```

## Roadmap

- **Phase 1** ✅ — scaffolding, hooks, status widget, publishing pipeline.
- **Phase 2** ✅ — Neat Slice, out-of-band Verifier call, splice, DPO sink.
- **Phase 3** — local verifier (offline mode), prompt-template expansion, periodic DPO upload.

## License

[MIT](./LICENSE)
