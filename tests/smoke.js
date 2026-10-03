/**
 * Integration smoke test (Phases 2-4 + steering-quality hardening).
 *
 * Boots the compiled extension against a fully-mocked pi runtime:
 * - drives a 3-failure compile streak
 * - intercepts the HTTP calls to the Verifier/Distiller via a local mock server
 * - asserts the AUTO-audit path self-dispatches "/harvest rewind" and
 *   navigates via a command context (hardening #1)
 * - asserts a clean `ls` does NOT resolve the audit but a clean
 *   `cargo build` does (hardening #2)
 * - asserts thrashing distillation steers the live worker with the
 *   distilled optimal path (hardening #3)
 * - exercises /harvest status, audit, rewind, export
 */

// Module-level env: the extension reads thresholds at load time.
process.env.HARVEST_THRASHING_THRESHOLD = "3";

const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

const extension = require("../dist/index.js").default;
const { migrateLegacyHarvest, resolveHarvestRoot } = require("../dist/paths.js");

async function startMockVerifier(responder) {
 return new Promise((resolve) => {
 const server = http.createServer((req, res) => {
 let body = "";
 req.on("data", (c) => (body += c));
 req.on("end", () => responder(req, res, body));
 });
 server.listen(0, "127.0.0.1", () => {
 const { port } = server.address();
 resolve({ server, baseUrl: "http://127.0.0.1:" + port });
 });
 });
}

// mock-only fixture using legacy { toolName, output } shape for the
// tool_result events plus real-shaped turn_end toolResults; real pi
// emits ToolResultEvent with content: Array<TextContent | ImageContent>
// and input.command — the scenarios mix both shapes on purpose.
function makePi() {
 const handlers = {};
 const calls = { sendUserMessage: [], navigateTree: [], commandErrors: [] };
 const commands = {};
 const notifyCalls = [];
 let lastCtx = null;
 // Mid-stream navigateTree guard simulator. When > 0, the next
 // navigateTree call(s) will reject with the same error real pi emits
 // when the rewind lands during an active response ("Wait for the
 // current response to finish before navigating the session tree.").
 // Used by scenario 1b to verify the queueMicrotask deferral handles
 // the rejection gracefully without crashing the extension.
 let navigateTreeGuardRemaining = 0;
 const pi = {
 handlers: handlers,
 calls: calls,
 commands: commands,
 notifyCalls: notifyCalls,
 on(event, handler) {
 handlers[event] = handler;
 },
 registerCommand(name, options) {
 commands[name] = options;
 },
 sendUserMessage(content, options) {
 calls.sendUserMessage.push({ content: content, options: options });
 // Emulate real pi's prompt() (agent-session.ts): when
 // expandPromptTemplates is set and the text starts with "/", the
 // extension command executes IMMEDIATELY with a fresh command
 // context (including navigateTree) — even when the origin was an
 // event handler whose ctx lacks navigateTree, and even mid-stream.
 if (
 options &&
 options.expandPromptTemplates === true &&
 typeof content === "string" &&
 content.startsWith("/")
 ) {
 const spaceIndex = content.indexOf(" ");
 const name = spaceIndex === -1 ? content.slice(1) : content.slice(1, spaceIndex);
 const args = spaceIndex === -1 ? "" : content.slice(spaceIndex + 1);
 const command = commands[name];
 if (command) {
 const base = lastCtx || {};
 const commandCtx = {
 cwd: base.cwd || "",
 model: base.model,
 hasUI: true,
 ui: base.ui || {
 setStatus: function () {},
 notify: function () {},
 },
 sessionManager: base.sessionManager || {
 getBranch: function () {
 return [];
 },
 getSessionId: function () {
 return "mock";
 },
 },
 navigateTree: function (targetId, navOptions) {
 calls.navigateTree.push({ targetId: targetId, options: navOptions });
 if (navigateTreeGuardRemaining > 0) {
 navigateTreeGuardRemaining -= 1;
 return Promise.reject(
 new Error("Wait for the current response to finish before navigating the session tree."),
 );
 }
 return Promise.resolve({ cancelled: false });
 },
 };
 Promise.resolve(command.handler(args, commandCtx)).catch(function (err) {
 calls.commandErrors.push(err && err.message ? err.message : String(err));
 });
 }
 }
 },
 _fire(event, eventObj, ctx) {
 lastCtx = ctx;
 if (handlers[event]) {
 return handlers[event](eventObj, ctx);
 }
 },
 _callCommand(name, args, ctx) {
 lastCtx = ctx;
 if (!commands[name]) throw new Error("no command: " + name);
 return commands[name].handler(args, ctx);
 },
 setNavigateTreeGuard(remaining) {
 navigateTreeGuardRemaining = remaining;
 },
 };
 return pi;
}

function wait(ms) {
 return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, opts) {
 opts = opts || {};
 const timeoutMs = opts.timeoutMs || 3000;
 const intervalMs = opts.intervalMs || 25;
 const start = Date.now();
 while (Date.now() - start < timeoutMs) {
 if (predicate()) return true;
 await wait(intervalMs);
 }
 throw new Error("waitFor: timed out");
}

function readJsonl(jsonlPath) {
 return fs.readFileSync(jsonlPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

async function main() {
 const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harvest-smoke-"));
 // Pin the harvest root under the temp dir so writes land inside it
 // and the final rm(cwd) cleanup reclaims them. See src/paths.js.
 process.env.PI_HARVEST_ROOT = path.join(cwd, ".pi", "harvest");
 // chdir into a clean workspace so the extension's startup migration
 // (which scans process.cwd()/.pi/harvest) finds nothing and the
 // record-count assertions below stay deterministic.
 const cleanWs = path.join(cwd, "clean-ws");
 fs.mkdirSync(cleanWs, { recursive: true });
 const originalCwd = process.cwd();
 process.chdir(cleanWs);
 const d = new Date();
 const y = d.getUTCFullYear();
 const m = String(d.getUTCMonth() + 1).padStart(2, "0");
 const jsonlPath = path.join(cwd, ".pi", "harvest", "trajectories_" + y + "_" + m + ".jsonl");

 let auditCalls = 0;
 let distillerCalls = 0;
 const mock = await startMockVerifier(function (_req, res, body) {
 const parsed = JSON.parse(body);
 const systemPrompt = parsed.messages && parsed.messages[0] ? parsed.messages[0].content : "";
 if (/Hindsight Relabeling/.test(systemPrompt)) {
 distillerCalls += 1;
 const distilled = {
 distilled_chosen_completion: 'fn main() { println!("distilled hello"); }',
 };
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(distilled) } }] }));
 return;
 }
 auditCalls += 1;
 const audit = {
 inferred_subtask: "build hello world in rust",
 divergence_detected: true,
 divergence_turn_entry_id: "t1",
 flaw_category: "logic_error",
 root_cause: "missing semicolon",
 discard_advice: "drop turns 2-3",
 steering_instructions: "Add `;` at end of statement.",
 domain_tags: ["rust"],
 };
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(audit) } }] }));
 });

 process.env.VERIFIER_BASE_URL = mock.baseUrl;
 process.env.VERIFIER_API_KEY = "test-key";
 process.env.VERIFIER_MODEL = "test-model";
 process.env.HARVEST_STREAK_THRESHOLD = "3";

 try {
 const pi = makePi();

 // Branch is mutated between audit and resolution to simulate the
 // worker fixing the code after the K3 steering directive.
 const branch = [
 {
 type: "message",
 id: "u1",
 parentId: null,
 timestamp: "2026-01-01T00:00:00.000Z",
 message: { role: "user", content: "build me a hello world rust program" },
 },
 {
 type: "message",
 id: "a1",
 parentId: "u1",
 timestamp: "2026-01-01T00:00:01.000Z",
 message: { role: "assistant", content: "fn main() { println!('hi') }" },
 },
 {
 type: "message",
 id: "t1",
 parentId: "a1",
 timestamp: "2026-01-01T00:00:02.000Z",
 message: { role: "tool", toolName: "bash", content: "error[E0425]: cannot find value x" },
 },
 ];

 const ctx = {
 cwd: cwd,
 model: { id: "MiniMax-M3", provider: "minimax" },
 ui: {
 setStatus: function () {},
 notify: function (msg) {
 pi.notifyCalls.push(msg);
 },
 },
 sessionManager: {
 getBranch: function () {
 return branch;
 },
 getSessionId: function () {
 return "sess-smoke-1";
 },
 },
 // Mirror real pi: navigateTree lives on ExtensionCommandContext (the
 // ctx passed to slash-command handlers), NOT on ExtensionContext (the
 // ctx passed to turn_end / tool_result event handlers).
 navigateTree: undefined,
 };

 extension(pi);

 // -----------------------------------------------------------------------
 // 1. 3-failure streak -> auto-audit -> SELF-DISPATCHED rewind -> steer
 // -----------------------------------------------------------------------
 for (let i = 0; i < 3; i++) {
 pi._fire(
 "tool_result",
 {
 toolName: "bash",
 input: { command: "cargo build" },
 output: "error[E0425]: failure " + (i + 1),
 },
 ctx,
 );
 }
 pi._fire("turn_end", {}, ctx);

 await waitFor(function () {
 return auditCalls === 1;
 }, { timeoutMs: 4000 });

 // Hardening #1: the auto-audit (event-handler ctx, no navigateTree)
 // must self-dispatch "/harvest rewind", which the mock executes with a
 // fresh command context — so the rewind NOW happens on the auto path
 // too, and the steer lands AFTER the navigation.
 await waitFor(function () {
 return pi.calls.navigateTree.length === 1;
 }, { timeoutMs: 4000 });

 await waitFor(function () {
 return pi.calls.sendUserMessage.length >= 2;
 }, { timeoutMs: 4000 });

 assert.equal(pi.calls.sendUserMessage[0].content, "/harvest rewind");
 assert.equal(pi.calls.sendUserMessage[0].options.expandPromptTemplates, true);
 assert.equal(pi.calls.navigateTree[0].targetId, "t1");
 assert.equal(pi.calls.navigateTree[0].options.summarize, true);
 assert.match(pi.calls.navigateTree[0].options.customInstructions, /Add `;`/);

 const steering = pi.calls.sendUserMessage[1];
 assert.match(steering.content, /\[STEER:K3\]/);
 assert.match(steering.content, /Add `;`/);
 assert.equal(steering.options.deliverAs, "steer");
 // Steering-body enrichment: the clamped compiler error, the exact
 // verification command captured from the failing tool_result, and the
 // "rewrite these files" line all ride along in the steer.
 assert.match(steering.content, /Error: error\[E0425\]: cannot find value x/);
 assert.match(steering.content, /Verify: run `cargo build` and confirm it exits clean\./);

 // No steer-only fallback notify, no command-dispatch errors.
 assert.equal(pi.calls.commandErrors.length, 0);
 assert.ok(
 !pi.notifyCalls.find(function (m) {
 return /Rewind skipped/.test(m);
 }),
 "auto-audit path must no longer fall back to steer-only splice",
 );

 // -----------------------------------------------------------------------
 // 1b. Mid-stream navigateTree guard: rejection is caught, no crash,
 // audit remains in awaiting_resolution, and the deferred rewind
 // eventually lands on retry. Uses a fresh pi + fresh mock verifier so
 // the audit/navigateTree counters in scenario 1 don't drift.
 // -----------------------------------------------------------------------
 let guardAuditCalls = 0;
 const guardMock = await startMockVerifier(function (_req, res, _body) {
 guardAuditCalls += 1;
 const audit = {
 inferred_subtask: "build hello world in rust",
 divergence_detected: true,
 divergence_turn_entry_id: "t1b",
 flaw_category: "logic_error",
 root_cause: "missing semicolon",
 discard_advice: "drop turns 2-3",
 steering_instructions: "Add `;` at end of statement.",
 domain_tags: ["rust"],
 };
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(audit) } }] }));
 });
 const savedBaseUrl = process.env.VERIFIER_BASE_URL;
 process.env.VERIFIER_BASE_URL = guardMock.baseUrl;
 let cwd1b;
 try {
 const pi1b = makePi();
 // First navigateTree call (the deferred rewind from cycle 1) rejects
 // with the exact message real pi emits when the rewind lands during
 // an active response. Subsequent calls succeed.
 pi1b.setNavigateTreeGuard(1);

 const branch1b = [
 {
 type: "message",
 id: "u1b",
 parentId: null,
 timestamp: "2026-01-01T00:00:00.000Z",
 message: { role: "user", content: "build me a hello world rust program" },
 },
 {
 type: "message",
 id: "a1b",
 parentId: "u1b",
 timestamp: "2026-01-01T00:00:01.000Z",
 message: { role: "assistant", content: "fn main() { println!('hi') }" },
 },
 {
 type: "message",
 id: "t1b",
 parentId: "a1b",
 timestamp: "2026-01-01T00:00:02.000Z",
 message: { role: "tool", toolName: "bash", content: "error[E0425]: cannot find value x" },
 },
 ];
 cwd1b = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harvest-smoke-1b-"));
 // Scenario 1b needs its own harvest root so its records don't land in
 // the same file as scenario 1's (the sink root is global now).
 process.env.PI_HARVEST_ROOT = path.join(cwd1b, ".pi", "harvest");
 const jsonlPath1b = path.join(
 cwd1b,
 ".pi",
 "harvest",
 "trajectories_" + y + "_" + m + ".jsonl",
 );
 const ctx1b = {
 cwd: cwd1b,
 model: { id: "MiniMax-M3", provider: "minimax" },
 ui: {
 setStatus: function () {},
 notify: function (msg) {
 pi1b.notifyCalls.push(msg);
 },
 },
 sessionManager: {
 getBranch: function () {
 return branch1b;
 },
 getSessionId: function () {
 return "sess-smoke-1b";
 },
 },
 // Mirror real pi: event-handler ctx has no navigateTree.
 navigateTree: undefined,
 };
 extension(pi1b);

 // Cycle 1: 3 failures -> auto-audit -> deferred rewind dispatches ->
 // navigateTree rejects with the mid-stream guard message.
 for (let i = 0; i < 3; i++) {
 pi1b._fire(
 "tool_result",
 { toolName: "bash", input: { command: "cargo build" }, output: "error[E0425]: failure " + (i + 1) },
 ctx1b,
 );
 }
 pi1b._fire("turn_end", {}, ctx1b);

 await waitFor(function () {
 return pi1b.calls.navigateTree.length >= 1;
 }, { timeoutMs: 4000 });
 // Give the rejection's catch handler a tick to emit the warning.
 await wait(100);
 assert.equal(
 pi1b.calls.navigateTree.length,
 1,
 "cycle 1: deferred rewind attempted exactly one navigateTree call before the guard rejected",
 );
 assert.ok(
 pi1b.notifyCalls.find(function (m) {
 return /navigateTree failed/.test(m);
 }),
 "cycle 1: rejection must surface as a [Harvester] navigateTree failed warning, not a crash",
 );
 assert.equal(
 pi1b.calls.commandErrors.length,
 0,
 "cycle 1: rejection must not propagate as a command error (graceful fallback)",
 );

 // Cycle 2: user manually retries via /harvest audit. The command
 // handler runs with a fresh command ctx (real pi provides navigateTree
 // here), and the mock's guard counter is already 0 so the rewind
 // succeeds. This is the realistic retry path: a user sees the
 // [Harvester] navigateTree failed warning and re-runs the audit.
 // (The state machine would otherwise keep the audit pinned in
 // awaiting_resolution until resolution, so a second auto-audit can't
 // fire without a clean build first.)
 pi1b.notifyCalls.length = 0;
 const commandCtx1b = Object.assign({}, ctx1b, {
 navigateTree: function (targetId, options) {
 pi1b.calls.navigateTree.push({ targetId: targetId, options: options });
 return { cancelled: false };
 },
 });
 await pi1b._callCommand("harvest", "audit", commandCtx1b);
 await waitFor(function () {
 return guardAuditCalls >= 2 && pi1b.calls.navigateTree.length >= 2;
 }, { timeoutMs: 4000 });
 assert.equal(
 pi1b.calls.navigateTree.length,
 2,
 "cycle 2: /harvest audit rewind landed (mock succeeded after first guard call consumed)",
 );

 // Cycle 3: worker fixes the issue; clean cargo build resolves the
 // audit and writes the DPO pair. Verifies the bug fix doesn't break
 // the resolution path - the DPO entry still gets sealed even when the
 // first rewind attempt was rejected by the guard.
 branch1b.push({
 type: "message",
 id: "a3b",
 parentId: "t2b",
 timestamp: "2026-01-01T00:00:05.000Z",
 message: { role: "assistant", content: "fn main() { println!('hello'); }" },
 });
 pi1b._fire(
 "tool_result",
 { toolName: "bash", input: { command: "cargo build" }, output: "Build succeeded." },
 ctx1b,
 );
 pi1b._fire("turn_end", {}, ctx1b);

 await waitFor(function () {
 return fs.existsSync(jsonlPath1b);
 }, { timeoutMs: 4000 });
 const records1b = readJsonl(jsonlPath1b);
 assert.equal(
 records1b.length,
 1,
 "DPO pair still gets written after a mid-stream guard rejection",
 );
 assert.equal(records1b[0].session_id, "sess-smoke-1b");
 // The DPO entry was sealed by the /harvest audit from cycle 2 (the
 // retry), so trigger_reason is "manual" rather than "compiler_streak".
 // Both are valid outcomes of the resolution path.
 assert.ok(
 records1b[0].trigger_reason === "compiler_streak" || records1b[0].trigger_reason === "manual",
 "trigger_reason should be compiler_streak or manual, got: " + records1b[0].trigger_reason,
 );
 assert.match(records1b[0].chosen_completion, /println!\('hello'\)/);

 console.log(" scenario 1b: mid-stream guard handled cleanly; DPO pair written to " + jsonlPath1b);
 } finally {
 if (cwd1b) {
 fs.rmSync(cwd1b, { recursive: true, force: true });
 }
 guardMock.server.close();
 process.env.VERIFIER_BASE_URL = savedBaseUrl;
 // Restore scenario 1's harvest root for the remaining sections.
 process.env.PI_HARVEST_ROOT = path.join(cwd, ".pi", "harvest");
 }

 // -----------------------------------------------------------------------
 // 2. Resolution gate: clean `ls` does NOT resolve; clean build does
 // -----------------------------------------------------------------------
 branch.push({
 type: "message",
 id: "a2",
 parentId: "t1",
 timestamp: "2026-01-01T00:00:03.000Z",
 message: { role: "assistant", content: "fn main() { println!('hello'); }" },
 });

 // A clean non-build command must not satisfy the resolution gate.
 pi._fire("tool_result", { toolName: "bash", input: { command: "ls -la" }, output: "main.rs Cargo.toml" }, ctx);
 pi._fire("turn_end", {}, ctx);
 await wait(300);
 assert.ok(!fs.existsSync(jsonlPath), "clean `ls` must not resolve the audit (resolution gate)");

 // A clean build/test-shaped command satisfies it.
 pi._fire("tool_result", { toolName: "bash", input: { command: "cargo build" }, output: "Build succeeded." }, ctx);
 pi._fire("turn_end", {}, ctx);

 await waitFor(function () {
 return fs.existsSync(jsonlPath);
 }, { timeoutMs: 4000 });

 // -----------------------------------------------------------------------
 // 3. Schema assertions on the first JSONL record
 // -----------------------------------------------------------------------
 const records = readJsonl(jsonlPath);
 assert.equal(records.length, 1);
 const entry = records[0];

 assert.equal(entry.session_id, "sess-smoke-1");
 assert.match(entry.timestamp, /^\d{4}-\d{2}-\d{2}T/);
 assert.equal(entry.worker_model, "minimax:MiniMax-M3");
 assert.equal(entry.verifier_model, "test-model");
 assert.equal(entry.trigger_reason, "compiler_streak");
 assert.deepEqual(entry.domain_tags, ["rust"]);
 assert.equal(entry.immediate_prompt, "build me a hello world rust program");
 assert.equal(entry.rejected_completion, "fn main() { println!('hi') }");
 assert.equal(entry.chosen_completion, "fn main() { println!('hello'); }");
 assert.equal(entry.compiler_error_summary, "error[E0425]: cannot find value x");
 assert.equal(entry.k3_audit.divergence_entry_id, "t1");
 assert.equal(entry.k3_audit.flaw_category, "logic_error");
 assert.equal(entry.k3_audit.root_cause, "missing semicolon");
 assert.equal(entry.k3_audit.steering_instructions, "Add `;` at end of statement.");
 assert.ok(Array.isArray(entry.active_files));
 // Phase 4 schema field
 assert.ok("git_diff_summary" in entry, "git_diff_summary must be present (null is OK)");

 // -----------------------------------------------------------------------
 // 4. /harvest status
 // -----------------------------------------------------------------------
 assert.ok(pi.commands["harvest"], "registerCommand should have been called with 'harvest'");
 assert.equal(typeof pi.commands["harvest"].handler, "function");

 pi.notifyCalls.length = 0;
 await pi._callCommand("harvest", "status", ctx);
 const statusMsg = pi.notifyCalls.find(function (m) {
 return /\[Harvester\]/.test(m);
 });
 assert.ok(statusMsg, "status command should emit a [Harvester] notification");
 assert.match(statusMsg, /turn=\d+/);
 assert.match(statusMsg, /streak=\d+/);
 assert.match(statusMsg, /harvests=1/);
 assert.match(statusMsg, /state=idle/);
 assert.match(statusMsg, /model=test-model/);
 assert.match(statusMsg, /records=1/);
 assert.match(statusMsg, /size=\d+B/);
 // Phase 4 telemetry aggregation
 assert.match(statusMsg, /Harvest Telemetry/);
 assert.match(statusMsg, /Top Flaws/);
 assert.match(statusMsg, /logic_error \(1\)/);

 // -----------------------------------------------------------------------
 // 5. Thrashing -> distillation DPO + LIVE-WORKER steer (hardening #3)
 // -----------------------------------------------------------------------
 pi.notifyCalls.length = 0;
 pi._fire("turn_end", {
 toolResults: [
 { toolName: "bash", content: [{ type: "text", text: "compiling v0.1.0 ..." }], isError: false },
 { toolName: "edit", details: { path: "src/main.rs" } },
 { toolName: "edit", details: { path: "src/main.rs" } },
 { toolName: "bash", content: [{ type: "text", text: "Build finished" }], isError: false },
 ],
 }, ctx);

 await waitFor(function () {
 return distillerCalls === 1;
 }, { timeoutMs: 4000 });

 await waitFor(function () {
 return readJsonl(jsonlPath).length >= 2;
 }, { timeoutMs: 4000 });

 await waitFor(function () {
 return pi.calls.sendUserMessage.some(function (m) {
 return /Optimal path/.test(m.content);
 });
 }, { timeoutMs: 4000 });

 const distSteer = pi.calls.sendUserMessage.find(function (m) {
 return /Optimal path/.test(m.content);
 });
 assert.match(distSteer.content, /^\[STEER:K3\]\[THRASHING\]/);
 assert.match(distSteer.content, /distilled hello/);
 assert.match(distSteer.content, /thrashing/i);
 assert.equal(distSteer.options.deliverAs, "steer");

 const distRecord = readJsonl(jsonlPath)[1];
 assert.equal(distRecord.trigger_reason, "thrashing_distillation");
 assert.equal(distRecord.chosen_completion, 'fn main() { println!("distilled hello"); }');
 assert.match(distRecord.rejected_completion, /fn main/);

 // -----------------------------------------------------------------------
 // 6. Manual /harvest audit (command ctx) -> direct navigateTree path
 // -----------------------------------------------------------------------
 const commandCtx = Object.assign({}, ctx, {
 navigateTree: function (targetId, options) {
 pi.calls.navigateTree.push({ targetId: targetId, options: options });
 return { cancelled: false };
 },
 });

 pi.notifyCalls.length = 0;
 await pi._callCommand("harvest", "audit", commandCtx);
 await waitFor(function () {
 return auditCalls === 2;
 }, { timeoutMs: 4000 });
 const auditMsg = pi.notifyCalls.find(function (m) {
 return /Manual audit requested/.test(m);
 });
 assert.ok(auditMsg, "audit command should emit a 'Manual audit requested' notification");

 // Manual audit fires from the slash-command handler, so navigateTree is
 // used directly from the passed ctx (no self-dispatch on this path).
 await waitFor(function () {
 return pi.calls.navigateTree.length === 2;
 }, { timeoutMs: 4000 });
 assert.equal(pi.calls.navigateTree[1].targetId, "t1");
 assert.equal(pi.calls.navigateTree[1].options.summarize, true);

 // Status after manual audit should show awaiting_resolution state.
 pi.notifyCalls.length = 0;
 await pi._callCommand("harvest", "status", ctx);
 const afterMsg = pi.notifyCalls.find(function (m) {
 return /\[Harvester\]/.test(m);
 });
 assert.ok(afterMsg);
 assert.match(afterMsg, /state=awaiting_resolution/);

 // -----------------------------------------------------------------------
 // 7. /harvest export dpo (3 records by now)
 // -----------------------------------------------------------------------
 // First resolve the manual audit by giving the worker a clean build.
 branch.push({
 type: "message",
 id: "a3",
 parentId: "a2",
 timestamp: "2026-01-01T00:00:04.000Z",
 message: { role: "assistant", content: "fn main() { println!('manual hello'); }" },
 });
 pi._fire("tool_result", { toolName: "bash", input: { command: "cargo build" }, output: "Build succeeded." }, ctx);
 pi._fire("turn_end", {}, ctx);

 await waitFor(function () {
 return readJsonl(jsonlPath).length >= 3;
 }, { timeoutMs: 4000 });

 pi.notifyCalls.length = 0;
 await pi._callCommand("harvest", "export dpo", ctx);
 const exportMsg = pi.notifyCalls.find(function (m) {
 return /DPO export written/.test(m);
 });
 assert.ok(exportMsg, "export command should emit a 'DPO export written' notification");
 const exportMatch = exportMsg.match(/DPO export written: ([^\s]+)/);
 assert.ok(exportMatch, "export message should contain the file path");
 const exportPath = exportMatch[1];
 assert.ok(fs.existsSync(exportPath), "export file must exist on disk: " + exportPath);

 // Validate HF DPO format on the export
 const exportLines = fs.readFileSync(exportPath, "utf8").trim().split("\n");
 assert.equal(exportLines.length, 3);
 for (const line of exportLines) {
 const rec = JSON.parse(line);
 assert.equal(rec.prompt.length, 1);
 assert.equal(rec.prompt[0].role, "user");
 assert.equal(rec.chosen.length, 1);
 assert.equal(rec.chosen[0].role, "assistant");
 assert.equal(rec.rejected.length, 1);
 assert.equal(rec.rejected[0].role, "assistant");
 assert.match(rec.prompt[0].content, /=== TASK ===/);
 assert.match(rec.prompt[0].content, /=== GIT DIFF ===/);
 // ACTIVE FILES section is only present when the slice had modifiedPaths;
 // the smoke mock doesn't trigger write/edit tool calls, so this is optional.
 // The exporter correctly omits empty sections.
 }

 // -----------------------------------------------------------------------
 // 8. Log rotation — the sink filename should be date-stamped
 // -----------------------------------------------------------------------
 assert.match(jsonlPath, /trajectories_\d{4}_\d{2}\.jsonl$/);

 // -----------------------------------------------------------------------
 // 9. Legacy migration — <cwd>/.pi/harvest/*.jsonl is copied into the
 // user-home harvest root without deleting the originals.
 // -----------------------------------------------------------------------
 {
 const legacyWs = path.join(cwd, "legacy-ws");
 const legacyDir = path.join(legacyWs, ".pi", "harvest");
 fs.mkdirSync(legacyDir, { recursive: true });
 const legacyFile = path.join(legacyDir, "trajectories_2026_01.jsonl");
 fs.writeFileSync(legacyFile, '{"legacy":1}\n{"legacy":2}\n', "utf8");

 const migratedRoot = path.join(cwd, "migrated-root");
 const savedRoot = process.env.PI_HARVEST_ROOT;
 process.env.PI_HARVEST_ROOT = migratedRoot;
 try {
 const result = migrateLegacyHarvest(legacyWs);
 assert.equal(result.migrated.length, 1, "one legacy .jsonl should migrate");
 assert.equal(result.skipped.length, 0);
 assert.equal(result.targetRoot, migratedRoot);

 const copied = path.join(migratedRoot, "trajectories_2026_01.jsonl");
 assert.ok(fs.existsSync(copied), "migrated file must exist at the user-home root");
 assert.equal(fs.readFileSync(copied, "utf8"), '{"legacy":1}\n{"legacy":2}\n');
 // Originals are NOT deleted (copy, not move).
 assert.ok(fs.existsSync(legacyFile), "legacy original must be preserved");
 assert.equal(fs.readFileSync(legacyFile, "utf8"), '{"legacy":1}\n{"legacy":2}\n');
 // Re-running must not duplicate or clobber.
 const again = migrateLegacyHarvest(legacyWs);
 assert.equal(again.migrated.length, 0, "second run should be a no-op");
 assert.equal(again.skipped.length, 1);
 assert.equal(fs.readFileSync(copied, "utf8"), '{"legacy":1}\n{"legacy":2}\n');

 console.log(" legacy migration: copied 1 file to " + migratedRoot + " (original preserved)");
 } finally {
 process.env.PI_HARVEST_ROOT = savedRoot;
 fs.rmSync(legacyWs, { recursive: true, force: true });
 fs.rmSync(migratedRoot, { recursive: true, force: true });
 }
 }

 console.log("Steering-hardening smoke test PASSED");
 console.log(" DPO entries written: " + jsonlPath + " (" + readJsonl(jsonlPath).length + " records)");
 console.log(" session_id: " + entry.session_id);
 console.log(" worker_model: " + entry.worker_model);
 console.log(" verifier_model: " + entry.verifier_model);
 console.log(" trigger_reason: " + entry.trigger_reason);
 console.log(" domain_tags: " + JSON.stringify(entry.domain_tags));
 console.log(" active_files: " + entry.active_files.length);
 console.log(" k3_audit.divergence_entry_id: " + entry.k3_audit.divergence_entry_id);
 console.log(" rejected: " + entry.rejected_completion);
 console.log(" chosen: " + entry.chosen_completion);
 console.log(" auto-audit HTTP calls: " + auditCalls);
 console.log(" distiller HTTP calls: " + distillerCalls);
 console.log(" rewind navigations: " + pi.calls.navigateTree.length);
 } finally {
 mock.server.close();
 process.chdir(originalCwd);
 fs.rmSync(cwd, { recursive: true, force: true });
 delete process.env.PI_HARVEST_ROOT;
 delete process.env.VERIFIER_BASE_URL;
 delete process.env.VERIFIER_API_KEY;
 delete process.env.VERIFIER_MODEL;
 delete process.env.HARVEST_STREAK_THRESHOLD;
 delete process.env.HARVEST_THRASHING_THRESHOLD;
 }
}

main().catch(function (err) {
 console.error("Smoke test FAILED:", err);
 process.exit(1);
});
