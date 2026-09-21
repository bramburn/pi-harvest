/**
 * Unit tests for the Verifier module.
 *
 * Covers:
 * - stripJsonFences: handles ```json, ```, no-fence, malformed
 * - validateAudit: missing fields, wrong types, valid input
 *
 * HTTP path is mocked by spawning a local HTTP server that returns a
 * canned response — no real network calls.
 */

const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const verifier = require("../dist/verifier.js");

// ---------------------------------------------------------------------------
// stripJsonFences
// ---------------------------------------------------------------------------

test("stripJsonFences: passes through plain JSON", () => {
 const raw = '{"a":1}';
 assert.equal(verifier.stripJsonFences(raw), '{"a":1}');
});

test("stripJsonFences: strips ```json fences", () => {
 const raw = '```json\n{"a":1}\n```';
 assert.equal(verifier.stripJsonFences(raw), '{"a":1}');
});

test("stripJsonFences: strips bare ``` fences", () => {
 const raw = '```\n{"a":1}\n```';
 assert.equal(verifier.stripJsonFences(raw), '{"a":1}');
});

test("stripJsonFences: trims whitespace around fences", () => {
 const raw = '\n\n```json\n{"a":1}\n```\n\n';
 assert.equal(verifier.stripJsonFences(raw), '{"a":1}');
});

test("stripJsonFences: returns raw when no fences present", () => {
 const raw = '  {"a":1}  ';
 assert.equal(verifier.stripJsonFences(raw), '{"a":1}');
});

// ---------------------------------------------------------------------------
// validateAudit
// ---------------------------------------------------------------------------

const VALID_AUDIT = {
 inferred_subtask: "Add a hello-world route",
 divergence_detected: true,
 divergence_turn: 5,
 flaw_category: "logic_error",
 root_cause: "Used the wrong import path",
 discard_advice: "Drop turns 3-5",
 steering_instructions: "Re-import from `./hello` and rebuild.",
};

test("validateAudit: accepts a fully-typed valid audit", () => {
 const out = verifier.validateAudit(VALID_AUDIT);
 assert.equal(out.inferred_subtask, "Add a hello-world route");
 assert.equal(out.divergence_turn, 5);
});

test("validateAudit: rejects non-object", () => {
 assert.throws(() => verifier.validateAudit(null), /not a JSON object/);
 assert.throws(() => verifier.validateAudit("string"), /not a JSON object/);
 assert.throws(() => verifier.validateAudit([]), /not a JSON object/);
});

test("validateAudit: rejects missing fields", () => {
 const bad = { ...VALID_AUDIT };
 delete bad.steering_instructions;
 assert.throws(() => verifier.validateAudit(bad), /missing required field: steering_instructions/);
});

test("validateAudit: rejects wrong types", () => {
 const bad = { ...VALID_AUDIT, divergence_detected: "yes" };
 assert.throws(() => verifier.validateAudit(bad), /divergence_detected must be a boolean/);
 const bad2 = { ...VALID_AUDIT, divergence_turn: "5" };
 assert.throws(() => verifier.validateAudit(bad2), /divergence_turn must be a finite number/);
});

// ---------------------------------------------------------------------------
// invokeVerifier — mocked HTTP
// ---------------------------------------------------------------------------

function startMockServer(handler) {
 return new Promise((resolve) => {
 const server = http.createServer((req, res) => {
 let body = "";
 req.on("data", (c) => (body += c));
 req.on("end", () => handler(req, res, body));
 });
 server.listen(0, "127.0.0.1", () => {
 const { port } = server.address();
 resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
 });
 });
}

const FAKE_SLICE = {
 inceptionIndex: 0,
 branchEntries: [],
 sliceEntries: [],
 failedCode: "",
 compilerError: "",
 inceptionPrompt: "",
 divergenceEntryId: null,
};

test("invokeVerifier: parses a clean JSON response", async () => {
 process.env.VERIFIER_BASE_URL = "http://127.0.0.1:0"; // overwritten below
 process.env.VERIFIER_API_KEY = "test-key";
 process.env.VERIFIER_MODEL = "test-model";

 const { server, baseUrl } = await startMockServer((_req, res) => {
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(
 JSON.stringify({
 choices: [{ message: { content: JSON.stringify(VALID_AUDIT) } }],
 }),
 );
 });
 process.env.VERIFIER_BASE_URL = baseUrl;

 try {
 const out = await verifier.invokeVerifier(FAKE_SLICE);
 assert.equal(out.inferred_subtask, "Add a hello-world route");
 assert.equal(out.divergence_detected, true);
 assert.equal(out.divergence_turn, 5);
 } finally {
 server.close();
 }
});

test("invokeVerifier: strips markdown fences before parsing", async () => {
 process.env.VERIFIER_BASE_URL = "http://127.0.0.1:0";
 process.env.VERIFIER_API_KEY = "test-key";
 process.env.VERIFIER_MODEL = "test-model";

 const wrapped = "```json\n" + JSON.stringify(VALID_AUDIT) + "\n```";
 const { server, baseUrl } = await startMockServer((_req, res) => {
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ choices: [{ message: { content: wrapped } }] }));
 });
 process.env.VERIFIER_BASE_URL = baseUrl;

 try {
 const out = await verifier.invokeVerifier(FAKE_SLICE);
 assert.equal(out.divergence_turn, 5);
 } finally {
 server.close();
 }
});

test("invokeVerifier: rejects when env vars are missing", async () => {
 const savedBase = process.env.VERIFIER_BASE_URL;
 const savedKey = process.env.VERIFIER_API_KEY;
 const savedModel = process.env.VERIFIER_MODEL;
 delete process.env.VERIFIER_BASE_URL;
 delete process.env.VERIFIER_API_KEY;
 delete process.env.VERIFIER_MODEL;

 await assert.rejects(() => verifier.invokeVerifier(FAKE_SLICE), /VERIFIER_BASE_URL/);

 process.env.VERIFIER_BASE_URL = savedBase;
 process.env.VERIFIER_API_KEY = savedKey;
 process.env.VERIFIER_MODEL = savedModel;
});

test("invokeVerifier: surfaces HTTP error status", async () => {
 process.env.VERIFIER_API_KEY = "test-key";
 process.env.VERIFIER_MODEL = "test-model";

 const { server, baseUrl } = await startMockServer((_req, res) => {
 res.writeHead(500, { "Content-Type": "text/plain" });
 res.end("internal error");
 });
 process.env.VERIFIER_BASE_URL = baseUrl;

 try {
 await assert.rejects(() => verifier.invokeVerifier(FAKE_SLICE), /Verifier HTTP 500/);
 } finally {
 server.close();
 }
});
