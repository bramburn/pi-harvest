/**
 * Phase 2 integration smoke test.
 *
 * Boots the compiled extension against a fully-mocked pi runtime:
 * - simulates a 3-failure compile streak
 * - intercepts the HTTP call to the Verifier via a local mock server
 * - drives navigateTree + sendUserMessage
 * - asserts a DPO line lands in .pi/harvest/trajectories.jsonl
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
 return {
 handlers,
 calls,
 on(event, handler) {
 handlers[event] = handler;
 },
 sendUserMessage(content, options) {
 calls.sendUserMessage.push({ content: content, options: options });
 },
 async navigateTree(targetId, options) {
 calls.navigateTree.push({ targetId: targetId, options: options });
 return { cancelled: false };
 },
 _fire(event, eventObj, ctx) {
 if (handlers[event]) {
 return handlers[event](eventObj, ctx);
 }
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
 const jsonlPath = path.join(cwd, ".pi", "harvest", "trajectories.jsonl");

 let lastAudited = 0;
 const mock = await startMockVerifier(function (_req, res) {
 lastAudited += 1;
 const audit = {
 inferred_subtask: "build hello world in rust",
 divergence_detected: true,
 divergence_turn: 3,
 flaw_category: "logic_error",
 root_cause: "missing semicolon",
 discard_advice: "drop turns 2-3",
 steering_instructions: "Add `;` at end of statement.",
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
 ui: {
 setStatus: function () {},
 notify: function () {},
 },
 sessionManager: {
 getBranch: function () {
 return branch;
 },
 getSessionId: function () {
 return "sess-smoke-1";
 },
 },
 };

 extension(pi);

 // Drive 3 failed builds in a row.
 for (let i = 0; i < 3; i++) {
 pi._fire(
 "tool_result",
 { toolName: "bash", output: "error[E0425]: failure " + (i + 1) },
 ctx,
 );
 }
 pi._fire("turn_end", {}, ctx);

 // Audit should fire once.
 await waitFor(function () {
 return lastAudited === 1;
 }, { timeoutMs: 4000 });

 // Steering should be injected.
 await waitFor(function () {
 return pi.calls.sendUserMessage.length === 1;
 }, { timeoutMs: 4000 });

 const steering = pi.calls.sendUserMessage[0];
 assert.match(steering.content, /\[STEER:K3\]/);
 assert.match(steering.content, /Add `;`/);
 assert.equal(steering.options.deliverAs, "steer");

 // navigateTree should have been called once with the divergence entry id.
 assert.equal(pi.calls.navigateTree.length, 1);
 assert.equal(pi.calls.navigateTree[0].targetId, "t1");
 assert.equal(pi.calls.navigateTree[0].options.summarize, true);

 // Worker follows steering: append a fixed-code assistant message.
 branch.push({
 type: "message",
 id: "a2",
 parentId: "t1",
 timestamp: "2026-01-01T00:00:03.000Z",
 message: { role: "assistant", content: "fn main() { println!('hello'); }" },
 });

 // Clean compile resets the streak.
 pi._fire("tool_result", { toolName: "bash", output: "Build succeeded." }, ctx);
 pi._fire("turn_end", {}, ctx);

 // DPO line should appear.
 await waitFor(function () {
 return fs.existsSync(jsonlPath);
 }, { timeoutMs: 4000 });

 const lines = fs.readFileSync(jsonlPath, "utf8").trim().split("\n");
 assert.equal(lines.length, 1);
 const entry = JSON.parse(lines[0]);
 assert.equal(entry.session_id, "sess-smoke-1");
 assert.equal(entry.k3_diagnosis.inferred_subtask, "build hello world in rust");
 assert.equal(entry.k3_diagnosis.divergence_turn, 3);
 assert.equal(entry.immediate_prompt, "build me a hello world rust program");
 assert.equal(entry.rejected_completion, "fn main() { println!('hi') }");
 assert.equal(entry.chosen_completion, "fn main() { println!('hello'); }");
 assert.deepEqual(entry.domain_tags, []);
 assert.match(entry.ts, /^\d{4}-\d{2}-\d{2}T/);

 console.log("Phase 2 smoke test PASSED");
 console.log(" DPO entry written: " + jsonlPath);
 console.log(" session_id: " + entry.session_id);
 console.log(" rejected_completion: " + entry.rejected_completion);
 console.log(" chosen_completion: " + entry.chosen_completion);
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
 console.error("Phase 2 smoke test FAILED:", err);
 process.exit(1);
});
