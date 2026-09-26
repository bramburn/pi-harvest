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
 fs.rmSync(cwd, { recursive: true, force: true });
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
