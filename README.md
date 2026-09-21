# pi-harvest

> Trajectory harvester for [`pi.dev`](https://pi.dev) — monitors a local worker model's run and intercepts compilation failure loops.

`pi-harvest` is a Phase 1 `pi.dev` extension that watches tool output and turn boundaries, surfaces a live TUI status widget, and emits notifications when the worker has either (a) just completed every 30 turns or (b) hit a 3-in-a-row compiler-failure streak. Phase 2 will replace the notification with a real trajectory audit API call.

## Features

- **Live status widget** in the Pi TUI status bar — `[Harvester] Turn: N | Streak: M`.
- **Compiler failure detection** — case-insensitive scan of bash stdout/stderr for signatures from rustc, csc, tsc, npm, and generic CI output.
- **Streak tracking** — increments on every compiler failure, resets on clean output.
- **Two trigger thresholds**:
  - `turnCounter % 30 === 0` — periodic harvest.
  - `compilerFailStreak >= 3` — emergency audit on persistent compile failure.
- **Notifications** — emits a warn-level notification when a threshold is hit.

## Installation

```bash
pi install npm:pi-harvest
```

Once installed, the `[Harvester] Turn: 0 | Streak: 0` widget appears in the Pi status bar and updates live as the agent runs.

## Development

```bash
git clone https://github.com/bramburn/pi-harvest
cd pi-harvest
npm install
npm run build
```

Output lands in `dist/`. The package's `main` is `dist/index.js`, and `prepublishOnly` runs `tsc` before every publish.

## Detection signatures

The scanner matches any of the following substrings (case-insensitive) in tool output:

| Pattern              | Source                            |
| -------------------- | --------------------------------- |
| `error[e`            | rustc / clippy                    |
| `build failed`       | npm / generic CI                  |
| `error cs`           | C# / .NET (`error CS1003`)        |
| `failed to compile`  | generic compilers                 |
| `tsc: error`         | TypeScript compiler               |
| `compilation failed` | generic                           |

## Roadmap

- **Phase 1** ✅ — scaffolding, hooks, status widget, publishing pipeline.
- **Phase 2** — replace `notify()` harvest triggers with the external trajectory-audit API call.

## License

[MIT](./LICENSE)
