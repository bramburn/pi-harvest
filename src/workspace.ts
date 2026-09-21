/**
 * Active File State & Diff Isolation.
 *
 * Scans the sliced conversation entries for tool calls that touch files
 * (pi's built-in `write`, `edit`, `read`, and bash commands that mention
 * file paths), then reads the current contents from disk with strict
 * token guardrails.
 *
 * Failures are SILENT — ENOENT, binary detection, lockfile skip, etc.
 * never throw; they're recorded as `skipped` on the ActiveFile record
 * so downstream consumers can decide what to do.
 */

import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, sep, normalize } from "node:path";

import type { ActiveFile, SessionEntry, AgentMessage, AgentMessagePart } from "./types.js";

/** Maximum lines captured per file (text content). */
export const MAX_FILE_LINES = 300;

/** Maximum byte size captured per file (~12 KB). */
export const MAX_FILE_BYTES = 12 * 1024;

/** File extensions we always skip (binary). */
const BINARY_EXTENSIONS = new Set([
 ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico",
 ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
 ".mp3", ".mp4", ".mov", ".wav", ".ogg", ".flac",
 ".ttf", ".otf", ".woff", ".woff2",
 ".so", ".dll", ".dylib", ".bin", ".exe",
 ".class", ".jar", ".pyc", ".o",
]);

/** Lockfiles we never capture. */
const LOCKFILE_BASENAMES = new Set([
 "Cargo.lock",
 "package-lock.json",
 "yarn.lock",
 "pnpm-lock.yaml",
 "bun.lockb",
 "composer.lock",
 "Gemfile.lock",
 "poetry.lock",
 "Pipfile.lock",
]);

/** Path prefixes we never descend into. */
const HIDDEN_PATH_PREFIXES = [".git/", ".pi/", "node_modules/", "dist/", "target/", "build/", ".venv/", "__pycache__/"];

const TRUNCATION_MARKER = "\n/* ...[truncated for harvest]... */\n";

/**
 * Heuristic: detect binary files by looking for NUL bytes in the first
 * 8 KB. Cheap and catches the common cases (images, compiled assets).
 */
function looksBinary(buffer: Buffer): boolean {
 const limit = Math.min(buffer.length, 8192);
 for (let i = 0; i < limit; i++) {
 if (buffer[i] === 0) return true;
 }
 return false;
}

/**
 * Should this path be skipped at capture time? Returns a string code
 * for the skip reason, or null if the path is acceptable.
 */
export function shouldSkipPath(relPath: string): ActiveFile["skipped"] | null {
 const normalized = relPath.replace(/\\/g, "/");
 // Hidden directories
 for (const prefix of HIDDEN_PATH_PREFIXES) {
 if (normalized.startsWith(prefix)) return "hidden";
 }
 // Lockfiles
 const basename = normalized.split("/").pop() ?? "";
 if (LOCKFILE_BASENAMES.has(basename)) return "lockfile";
 // Binary extension
 const ext = "." + (basename.split(".").pop() ?? "").toLowerCase();
 if (BINARY_EXTENSIONS.has(ext)) return "binary";
 return null;
}

/**
 * Extract file paths from a bash command string. Naive but covers the
 * common shapes: `cargo build src/foo.rs`, `npm run build > out.log`,
 * `tee output.txt`, and absolute or relative path args.
 *
 * Returns paths that LOOK like file references — downstream code still
 * runs shouldSkipPath() to filter.
 */
export function pathsFromBashCommand(command: string): string[] {
 const out: string[] = [];
 const tokens = command.split(/\s+/);
 for (const t of tokens) {
 // Skip pure flags and obvious redirects
 if (!t || t.startsWith("-")) continue;
 // Strip leading ./ and trailing :line:col from compiler output
 const stripped = t.replace(/^\.\//, "").replace(/:\d+(:\d+)?$/, "");
 // Must contain a slash OR a file-like extension
 if (/[\\/]/.test(stripped) || /\.[a-zA-Z0-9]{1,5}$/.test(stripped)) {
 // Skip redirects to /dev/null etc.
 if (/^\/dev\//.test(stripped)) continue;
 out.push(stripped);
 }
 }
 return out;
}

/**
 * Walk the branch/slice entries and collect unique relative file
 * paths that the worker touched.
 *
 * Recognizes pi's built-in tools:
 * - `write` / `edit` / `read`: arguments.path
 * - `bash`: arguments.command (parsed heuristically)
 *
 * Returns paths relative to `cwd` when possible.
 */
export function extractModifiedPaths(branchEntries: SessionEntry[], cwd: string): string[] {
 const seen = new Set<string>();
 const out: string[] = [];

 function add(path: string): void {
 if (!path) return;
 let rel: string;
 if (isAbsolute(path)) {
 try {
 rel = relative(cwd, normalize(path));
 } catch {
 rel = path;
 }
 } else {
 rel = path;
 }
 rel = rel.replace(/\\/g, "/");
 if (rel.startsWith("..") || isAbsolute(rel)) return; // outside cwd
 if (seen.has(rel)) return;
 seen.add(rel);
 out.push(rel);
 }

 for (const entry of branchEntries) {
 if (entry.type !== "message") continue;
 const msg = entry.message as AgentMessage;
 const role = msg.role;
 // Bash tool calls
 if (role === "assistant" && Array.isArray(msg.content)) {
 for (const part of msg.content) {
 if (typeof part !== "object" || part === null) continue;
 const p = part as AgentMessagePart;
 if (p.type === "toolCall" && p.name) {
 const args = (p.arguments ?? {}) as Record<string, unknown>;
 if (typeof args.path === "string") add(args.path);
 if (p.name === "bash" && typeof args.command === "string") {
 for (const p2 of pathsFromBashCommand(args.command)) add(p2);
 }
 }
 }
 }
 // Tool result with toolName="write"/"edit"/"read" may carry the path
 if (role === "toolResult" && msg.toolName && Array.isArray(msg.content)) {
 for (const part of msg.content) {
 if (typeof part !== "object" || part === null) continue;
 const p = part as AgentMessagePart;
 // Some tool results include the path in metadata
 if (typeof p.path === "string") add(p.path);
 }
 }
 }

 return out;
}

/**
 * Clamp text content to MAX_FILE_LINES lines / MAX_FILE_BYTES bytes,
 * appending a truncation marker if we cut anything.
 */
export function clampFileContent(raw: string): { content: string; truncated: boolean } {
 const lineCount = raw.split(/\r?\n/).length;
 if (lineCount <= MAX_FILE_LINES && Buffer.byteLength(raw, "utf8") <= MAX_FILE_BYTES) {
 return { content: raw, truncated: false };
 }
 // Truncate by lines first.
 const lines = raw.split(/\r?\n/).slice(0, MAX_FILE_LINES).join("\n");
 let content = lines;
 // If still too big in bytes, chop further.
 if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
 const buf = Buffer.from(content, "utf8");
 content = buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
 }
 content += TRUNCATION_MARKER;
 return { content, truncated: true };
}

/**
 * Capture the current on-disk state of every path in `paths`.
 * Reads are wrapped in try/catch — missing/locked/binary files are
 * silently recorded with a `skipped` code rather than throwing.
 *
 * Returns an array of ActiveFile records in input order.
 */
export async function captureActiveFileStates(
 cwd: string,
 paths: string[],
): Promise<ActiveFile[]> {
 const out: ActiveFile[] = [];
 for (const p of paths) {
 const skip = shouldSkipPath(p);
 if (skip) {
 out.push({ path: p, content: "", truncated: false, skipped: skip });
 continue;
 }
 const abs = normalize(`${cwd}${sep}${p}`);
 try {
 const buf = await readFile(abs);
 if (looksBinary(buf)) {
 out.push({ path: p, content: "", truncated: false, skipped: "binary" });
 continue;
 }
 const text = buf.toString("utf8");
 const { content, truncated } = clampFileContent(text);
 out.push({ path: p, content, truncated });
 } catch (err) {
 const code = (err as NodeJS.ErrnoException)?.code;
 if (code === "ENOENT") {
 out.push({ path: p, content: "", truncated: false, skipped: "missing" });
 continue;
 }
 if (code === "EACCES" || code === "EPERM") {
 out.push({ path: p, content: "", truncated: false, skipped: "read_error", skipReason: code });
 continue;
 }
 if (code === "EISDIR") {
 out.push({ path: p, content: "", truncated: false, skipped: "read_error", skipReason: "EISDIR" });
 continue;
 }
 // Unknown error — record and continue.
 out.push({ path: p, content: "", truncated: false, skipped: "read_error", skipReason: (err as Error).message });
 }
 }
 return out;
}

/**
 * Local fallback heuristic for `domain_tags` when the verifier returns
 * empty or when the audit failed and we still want to write a record.
 */
export function inferDomainTags(paths: string[]): string[] {
 const tags = new Set<string>();
 for (const p of paths) {
 const lower = p.toLowerCase();
 if (lower.endsWith(".rs")) {
 tags.add("rust");
 if (/tauri|src-tauri/.test(lower)) tags.add("tauri");
 }
 if (lower.endsWith(".cs") || lower.endsWith(".csproj") || lower.endsWith(".sln")) {
 tags.add("csharp");
 tags.add("dotnet");
 }
 if (lower.endsWith(".dart")) {
 tags.add("flutter");
 tags.add("dart");
 }
 if (lower.endsWith(".liquid")) {
 tags.add("shopify");
 tags.add("liquid");
 }
 if (lower.endsWith(".ts") || lower.endsWith(".tsx")) tags.add("typescript");
 if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) tags.add("javascript");
 if (lower.endsWith(".py")) tags.add("python");
 if (lower.endsWith(".go")) tags.add("go");
 if (lower.endsWith(".java") || lower.endsWith(".kt") || lower.endsWith(".kts")) {
 tags.add("jvm");
 if (lower.endsWith(".kt") || lower.endsWith(".kts")) tags.add("kotlin");
 }
 }
 return Array.from(tags);
}

/**
 * Maximum lines captured from `git diff --unified=3`.
 */
export const MAX_GIT_DIFF_LINES = 200;

/**
 * Git diff capture timeout (ms). Keeps a missing/hung git from
 * stalling the audit.
 */
export const GIT_DIFF_TIMEOUT_MS = 5000;

/**
 * Safely capture the local uncommitted `git diff` for the workspace.
 *
 * Returns `null` (not throws) when:
 * - git is not installed (ENOENT)
 * - cwd is not inside a git repository (non-zero exit)
 * - the command times out
 * - any other unexpected error
 *
 * Output is clamped to MAX_GIT_DIFF_LINES to prevent verifier-payload
 * ballooning.
 */
export function extractGitDiff(cwd: string, maxLines: number = MAX_GIT_DIFF_LINES): string | null {
 if (!cwd) return null;
 try {
 const raw = execFileSync("git", ["diff", "--unified=3"], {
 cwd,
 encoding: "utf8",
 timeout: GIT_DIFF_TIMEOUT_MS,
 windowsHide: true,
 stdio: ["ignore", "pipe", "pipe"],
 maxBuffer: 4 * 1024 * 1024,
 });
 if (typeof raw !== "string" || raw.trim().length === 0) return null;
 const lines = raw.split(/\r?\n/);
 if (lines.length <= maxLines) return raw;
 return lines.slice(0, maxLines).join("\n") + "\n[... git diff clamped for harvest ...]";
 } catch {
 // Swallow every error path: ENOENT (no git), non-zero exit (not a repo),
 // ETIMEDOUT (hung git), EACCES (permissions), etc.
 return null;
 }
}
