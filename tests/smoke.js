/**
 * Integration smoke test (Phase 2 + Phase 3).
 *
 * Boots the compiled extension against a fully-mocked pi runtime:
 * - drives a 3-failure compile streak
 * - intercepts the HTTP call to the Verifier via a local mock server
 * - asserts navigateTree + sendUserMessage fire
 * - verifies a HarvestedTrajectoryRecord lands in .pi/harvest/trajectories.jsonl
 * - exercises /harvest status and /harvest audit slash commands
 */

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

function makePi() {
 const handlers = {};
 const calls = { sendUserMessage: [], navigateTree: [] };
 const commands = {};
 const notifyCalls = [];
 return {
 handlers,
 calls,
 commands,
 notifyCalls,
 on(event, handler) {
 handlers[event] = handler;
 },
 registerCommand(name, options) {
 commands[name] = options;
 },
 sendUserMessage(content, options) {
 calls.sendUserMessage.push({ content: content, options: options });
 },
 // Note: in real pi, navigateTree lives on ExtensionCommandContext (the
 // ctx passed to slash-command handlers), NOT on ExtensionAPI (the pi
 // object). The smoke ctx mock must expose it on ctx.
 _navigateTree(targetId, options) {
 return calls.navigateTree;
 },
 _fire(event, eventObj, ctx) {
 if (handlers[event]) {
 return handlers[event](eventObj, ctx);
 }
 },
 _callCommand(name, args, ctx) {
 if (!commands[name]) throw new Error("no command: " + name);
 return commands[name].handler(args, ctx);
 },
 };
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

async function main() {
 const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-harvest-smoke-"));
 const d = new Date();
 const y = d.getUTCFullYear();
 const m = String(d.getUTCMonth() + 1).padStart(2, "0");
 const jsonlPath = path.join(cwd, ".pi", "harvest", "trajectories_" + y + "_" + m + ".jsonl");

 let lastAudited = 0;
 const mock = await startMockVerifier(function (_req, res) {
 lastAudited += 1;
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
 // Mirror real pi: navigateTree lives on ExtensionCommandContext (the ctx).
 // The smoke test exercises the compiler-streak path which fires from
 // turn_end, where ctx is an ExtensionContext without navigateTree. So
 // for this path we expect rewind to be skipped; the steer-only splice
 // still lands via sendUserMessage. Manual /harvest audit would exercise
 // the command ctx path and would have navigateTree.
 navigateTree: undefined,
 };

 extension(pi);

 // -----------------------------------------------------------------------
 // 1. Existing Phase 2 flow: 3-failure streak -> audit -> steer -> resolve
 // -----------------------------------------------------------------------
 for (let i = 0; i < 3; i++) {
 pi._fire(
 "tool_result",
 { toolName: "bash", output: "error[E0425]: failure " + (i + 1) },
 ctx,
 );
 }
 pi._fire("turn_end", {}, ctx);

 await waitFor(function () {
 return lastAudited === 1;
 }, { timeoutMs: 4000 });

 await waitFor(function () {
 return pi.calls.sendUserMessage.length === 1;
 }, { timeoutMs: 4000 });

 const steering = pi.calls.sendUserMessage[0];
 assert.match(steering.content, /\[STEER:K3\]/);
 assert.match(steering.content, /Add `;`/);
 assert.equal(steering.options.deliverAs, "steer");

 // Auto-audit fires from turn_end; ExtensionContext doesn't expose
 // navigateTree there, so the rewind is silently skipped and only the
 // steer message lands. The command-ctx path (manual /harvest audit)
 // exercises navigateTree below.
 assert.equal(pi.calls.navigateTree.length, 0);
 const skipNotify = pi.notifyCalls.find(function (m) {
 return /Rewind skipped/.test(m);
 });
 assert.ok(skipNotify, "expected a 'Rewind skipped' notification on the auto-audit path");

 branch.push({
 type: "message",
 id: "a2",
 parentId: "t1",
 timestamp: "2026-01-01T00:00:03.000Z",
 message: { role: "assistant", content: "fn main() { println!('hello'); }" },
 });

 pi._fire("tool_result", { toolName: "bash", output: "Build succeeded." }, ctx);
 pi._fire("turn_end", {}, ctx);

 await waitFor(function () {
 return fs.existsSync(jsonlPath);
 }, { timeoutMs: 4000 });

 // -----------------------------------------------------------------------
 // 2. Phase 3 schema assertions on the JSONL line
 // -----------------------------------------------------------------------
 const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
 assert.equal(lines.length, 1);
 const entry = JSON.parse(lines[0]);

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
 // 3. Phase 3 slash commands: /harvest status
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
 // 4. Phase 3 slash commands: /harvest audit (manual trigger)
 // -----------------------------------------------------------------------
 // Simulate the command-handler ctx (real pi's ExtensionCommandContext
 // includes navigateTree; the event-handler ctx does not).
 const commandCtx = Object.assign({}, ctx, {
 navigateTree: function (targetId, options) {
 pi.calls.navigateTree.push({ targetId: targetId, options: options });
 return { cancelled: false };
 },
 });

 pi.notifyCalls.length = 0;
 await pi._callCommand("harvest", "audit", commandCtx);
 await waitFor(function () {
 return lastAudited === 2;
 }, { timeoutMs: 4000 });
 const auditMsg = pi.notifyCalls.find(function (m) {
 return /Manual audit requested/.test(m);
 });
 assert.ok(auditMsg, "audit command should emit a 'Manual audit requested' notification");

 // Manual audit fires from the slash-command handler, so navigateTree IS
 // available on the command ctx. Verify the rewind happened.
 assert.equal(pi.calls.navigateTree.length, 1);
 assert.equal(pi.calls.navigateTree[0].targetId, "t1");
 assert.equal(pi.calls.navigateTree[0].options.summarize, true);

 // Status after manual audit should show awaiting_resolution state.
 pi.notifyCalls.length = 0;
 await pi._callCommand("harvest", "status", ctx);
 const afterMsg = pi.notifyCalls.find(function (m) {
 return /\[Harvester\]/.test(m);
 });
 assert.ok(afterMsg);
 assert.match(afterMsg, /state=awaiting_resolution/);

 // -----------------------------------------------------------------------
 // 5. Phase 4: /harvest export dpo
 // -----------------------------------------------------------------------
 // First resolve the manual audit by giving the worker a clean compile.
 branch.push({
 type: "message",
 id: "a3",
 parentId: "a2",
 timestamp: "2026-01-01T00:00:04.000Z",
 message: { role: "assistant", content: "fn main() { println!('manual hello'); }" },
 });
 pi._fire("tool_result", { toolName: "bash", output: "Build succeeded." }, ctx);
 pi._fire("turn_end", {}, ctx);

 await waitFor(function () {
 return fs.existsSync(jsonlPath) && fs.readFileSync(jsonlPath, "utf8").trim().split("\n").length >= 2;
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
 assert.equal(exportLines.length, 2);
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
 // 6. Phase 4: log rotation — the sink filename should be date-stamped
 // -----------------------------------------------------------------------
 assert.match(jsonlPath, /trajectories_\d{4}_\d{2}\.jsonl$/);

 console.log("Phase 2 + Phase 3 + Phase 4 smoke test PASSED");
 console.log(" DPO entry written: " + jsonlPath);
 console.log(" session_id: " + entry.session_id);
 console.log(" worker_model: " + entry.worker_model);
 console.log(" verifier_model: " + entry.verifier_model);
 console.log(" trigger_reason: " + entry.trigger_reason);
 console.log(" domain_tags: " + JSON.stringify(entry.domain_tags));
 console.log(" active_files: " + entry.active_files.length);
 console.log(" k3_audit.divergence_entry_id: " + entry.k3_audit.divergence_entry_id);
 console.log(" rejected: " + entry.rejected_completion);
 console.log(" chosen: " + entry.chosen_completion);
 console.log(" manual audit HTTP calls: " + lastAudited);
 } finally {
 mock.server.close();
 fs.rmSync(cwd, { recursive: true, force: true });
 delete process.env.VERIFIER_BASE_URL;
 delete process.env.VERIFIER_API_KEY;
 delete process.env.VERIFIER_MODEL;
 delete process.env.HARVEST_STREAK_THRESHOLD;
 }
}

main().catch(function (err) {
 console.error("Phase 3 smoke test FAILED:", err);
 process.exit(1);
});
