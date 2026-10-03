/**
 * Harvest path resolution (user-home relocation).
 *
 * Historically the sink wrote to `<cwd>/.pi/harvest/` — i.e. per-repo.
 * That scattered training data across every project checkout and made
 * it easy to lose when a repo was deleted or re-cloned. This module
 * relocates the sink to the *user* pi directory:
 *
 * - Windows: `%USERPROFILE%\.pi\harvest` (falls back to `os.homedir()`)
 * - POSIX:   `$HOME/.pi/harvest`
 *
 * Tests can pin the root via `PI_HARVEST_ROOT` so they never touch the
 * real user directory. The env var is read at call time (not module
 * load) so a single test process can repoint the root between cases.
 *
 * `migrateLegacyHarvest()` copies any pre-existing `<cwd>/.pi/harvest/*.jsonl`
 * files into the user-home root without deleting the originals, so an
 * existing repo's data is preserved on first run after upgrade.
 */

import {
 existsSync,
 mkdirSync,
 readdirSync,
 readFileSync,
 writeFileSync,
 statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolve the harvest root directory.
 *
 * Precedence:
 * 1. `PI_HARVEST_ROOT` env var (explicit override, used by tests).
 * 2. On Windows: `USERPROFILE` env var, falling back to `os.homedir()`.
 * 3. On POSIX: `HOME` env var, falling back to `os.homedir()`.
 *
 * Returns the absolute path to the `harvest` directory itself (not its
 * parent `.pi` directory).
 */
export function resolveHarvestRoot(): string {
 const override = process.env.PI_HARVEST_ROOT;
 if (typeof override === "string" && override.trim().length > 0) {
 return override.trim();
 }
 const isWindows = process.platform === "win32";
 const home = isWindows
 ? (process.env.USERPROFILE || homedir())
 : (process.env.HOME || homedir());
 return join(home, ".pi", "harvest");
}

/**
 * Ensure the harvest root exists. Safe to call repeatedly.
 */
export function ensureHarvestRoot(): string {
 const root = resolveHarvestRoot();
 if (!existsSync(root)) {
 mkdirSync(root, { recursive: true });
 }
 return root;
}

export interface MigrationResult {
 /** Absolute paths of files copied into the user-home root. */
 migrated: string[];
 /** Basenames of files skipped (already present at destination). */
 skipped: string[];
 /** Absolute path of the user-home root that received the copies. */
 targetRoot: string;
 /** Absolute path of the legacy source directory scanned (or null if absent). */
 sourceDir: string | null;
}

/**
 * Copy legacy `<cwd>/.pi/harvest/*.jsonl` files into the user-home root.
 *
 * The originals are NOT deleted — they remain in the repo's local
 * `.pi/harvest/` for inspection. If a file with the same basename
 * already exists at the destination, the source is skipped (no merge,
 * no clobber) and reported in `skipped`.
 *
 * Intended to be called exactly once at extension startup.
 */
export function migrateLegacyHarvest(cwd: string): MigrationResult {
 const sourceDir = join(cwd, ".pi", "harvest");
 const targetRoot = ensureHarvestRoot();

 const result: MigrationResult = {
 migrated: [],
 skipped: [],
 targetRoot,
 sourceDir: existsSync(sourceDir) ? sourceDir : null,
 };

 if (!result.sourceDir) return result;

 let entries: string[];
 try {
 entries = readdirSync(sourceDir);
 } catch {
 return result;
 }

 for (const name of entries) {
 if (!name.endsWith(".jsonl")) continue;
 const srcPath = join(sourceDir, name);
 const destPath = join(targetRoot, name);
 try {
 const st = statSync(srcPath);
 if (!st.isFile()) continue;
 if (existsSync(destPath)) {
 result.skipped.push(name);
 continue;
 }
 const content = readFileSync(srcPath, "utf8");
 writeFileSync(destPath, content, "utf8");
 result.migrated.push(destPath);
 } catch {
 // Swallow per-file errors — a single unreadable legacy file must
 // not block the extension from starting.
 }
 }

 return result;
}