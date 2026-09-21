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

### From npm (recommended for users)

```bash
pi install npm:pi-harvest
```

Once installed, the `[Harvester] Turn: 0 | Streak: 0` widget appears in the Pi status bar and updates live as the agent runs.

### From a local checkout (development loop)

When iterating on the extension before it has been published — or when testing changes that haven't been released yet — install directly from the source directory:

```bash
pi install C:\dev\pi-harvest -l --approve
```

Flags:

- `-l` — install from a **local** path (a directory containing `package.json`), instead of fetching from the npm registry.
- `--approve` — skip the interactive approval prompt. Required when running in a non-interactive shell (CI, scripts, or agent sessions like this one), since `pi` would otherwise wait for a `[y/N]` reply that never arrives.

The local install links the source directory into pi's extension store, so any rebuild is picked up after restarting pi:

```bash
# dev loop
cd C:\dev\pi-harvest
# ... edit src/index.ts ...
npm run build             # rebuilds dist/
# restart pi to reload the extension
```

Use this when you want a tighter edit → test cycle than `npm publish` → `pi install npm:pi-harvest` allows. A local install **shadows** the registry version until you uninstall it with `pi uninstall pi-harvest`.

## Development

```bash
git clone https://github.com/bramburn/pi-harvest
cd pi-harvest
npm install
npm run build
```

Output lands in `dist/`. The package's `main` is `dist/index.js`, and `prepublishOnly` runs `tsc` before every publish.

## Uninstallation

```bash
pi uninstall pi-harvest
```

Use this to remove a local install before re-installing the published `npm:` version, or vice versa — only one source can be active at a time.

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
