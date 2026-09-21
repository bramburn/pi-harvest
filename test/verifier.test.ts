/**
 * Unit tests for the verifier module — fence stripping, schema validation,
 * retry+backoff against a mocked HTTP server.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Server } from "node:http";
import * as verifier from "../dist/verifier.js";
import { VerifierUnavailableError } from "../dist/types.js";

const VALID_AUDIT = {
 inferred_subtask: "build hello",
 divergence_detected: true,
 divergence_turn_entry_id: "a1",
 flaw_category: "logic_error",
 root_cause: "wrong import",
 discard_advice: "drop turn 2",
 steering_instructions: "fix the import",
 domain_tags: ["rust", "tauri"],
};

const FAKE_SLICE = {
 inceptionIndex: 0,
 branchEntries: [],
 sliceEntries: [],
 failedCode: "",
 compilerError: "",
 compilerErrorRaw: "",
 inceptionPrompt: "build hello",
 modifiedPaths: [],
 divergenceEntryId: null,
};

function startMock(responder: (req: any, res: any, body: string) => void): Promise<{ server: Server; baseUrl: string }> {
 return new Promise((resolve) => {
 const server = createServer((req, res) => {
 let body = "";
 req.on("data", (c) => (body += c));
 req.on("end", () => responder(req, res, body));
 });
 server.listen(0, "127.0.0.1", () => {
 const addr = server.address() as { port: number };
 resolve({ server, baseUrl: "http://127.0.0.1:" + addr.port });
 });
 });
}

test("stripJsonFences: passes through plain JSON", () => {
 assert.equal(verifier.stripJsonFences('{"a":1}'), '{"a":1}');
});

test("stripJsonFences: strips ```json and bare ``` fences", () => {
 assert.equal(verifier.stripJsonFences("```json\n{\"a\":1}\n```"), '{"a":1}');
 assert.equal(verifier.stripJsonFences("```\n{\"a\":1}\n```"), '{"a":1}');
});

test("validateAudit: accepts a fully-typed Phase 3 audit", () => {
 const out = verifier.validateAudit(VALID_AUDIT);
 assert.deepEqual(out.domain_tags, ["rust", "tauri"]);
 assert.equal(out.divergence_turn_entry_id, "a1");
});

test("validateAudit: rejects missing domain_tags", () => {
 const bad = { ...VALID_AUDIT } as any;
 delete bad.domain_tags;
 assert.throws(() => verifier.validateAudit(bad), /domain_tags/);
});

test("validateAudit: rejects non-array domain_tags", () => {
 const bad = { ...VALID_AUDIT, domain_tags: "rust" };
 assert.throws(() => verifier.validateAudit(bad), /domain_tags/);
});

test("validateAudit: rejects non-string domain_tags entries", () => {
 const bad = { ...VALID_AUDIT, domain_tags: ["rust", 42] };
 assert.throws(() => verifier.validateAudit(bad), /domain_tags entries must be strings/);
});

test("validateAudit: tolerates optional divergence_turn / divergence_turn_entry_id", () => {
 const a = verifier.validateAudit({ ...VALID_AUDIT });
 assert.equal(a.divergence_turn, undefined);
 const b = verifier.validateAudit({ ...VALID_AUDIT, divergence_turn: 3 });
 assert.equal(b.divergence_turn, 3);
});

test("invokeVerifier: parses a clean JSON response", async () => {
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 const { server, baseUrl } = await startMock((_req, res) => {
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_AUDIT) } }] }));
 });
 process.env.VERIFIER_BASE_URL = baseUrl;
 try {
 const out = await verifier.invokeVerifier(FAKE_SLICE as any);
 assert.deepEqual(out.domain_tags, ["rust", "tauri"]);
 } finally {
 server.close();
 }
});

test("invokeVerifier: strips markdown fences before parsing", async () => {
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 const wrapped = "```json\n" + JSON.stringify(VALID_AUDIT) + "\n```";
 const { server, baseUrl } = await startMock((_req, res) => {
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ choices: [{ message: { content: wrapped } }] }));
 });
 process.env.VERIFIER_BASE_URL = baseUrl;
 try {
 const out = await verifier.invokeVerifier(FAKE_SLICE as any);
 assert.equal(out.inferred_subtask, "build hello");
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
 await assert.rejects(() => verifier.invokeVerifier(FAKE_SLICE as any), /VERIFIER_BASE_URL/);
 process.env.VERIFIER_BASE_URL = savedBase;
 process.env.VERIFIER_API_KEY = savedKey;
 process.env.VERIFIER_MODEL = savedModel;
});

test("invokeVerifier: surfaces HTTP 4xx immediately (no retry)", async () => {
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 process.env.HARVEST_MAX_RETRIES = "2";
 let hits = 0;
 const { server, baseUrl } = await startMock((_req, res) => {
 hits++;
 res.writeHead(400, { "Content-Type": "text/plain" });
 res.end("bad request");
 });
 process.env.VERIFIER_BASE_URL = baseUrl;
 try {
 await assert.rejects(() => verifier.invokeVerifier(FAKE_SLICE as any), /HTTP 400/);
 assert.equal(hits, 1);
 } finally {
 delete process.env.HARVEST_MAX_RETRIES;
 server.close();
 }
});

test("invokeVerifier: retries on HTTP 429 and eventually succeeds", async () => {
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 process.env.HARVEST_MAX_RETRIES = "2";
 process.env.HARVEST_TIMEOUT_MS = "5000";
 let hits = 0;
 const { server, baseUrl } = await startMock((_req, res) => {
 hits++;
 if (hits === 1) {
 res.writeHead(429, { "Content-Type": "text/plain" });
 res.end("rate limited");
 return;
 }
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_AUDIT) } }] }));
 });
 process.env.VERIFIER_BASE_URL = baseUrl;
 try {
 const out = await verifier.invokeVerifier(FAKE_SLICE as any);
 assert.equal(out.inferred_subtask, "build hello");
 assert.equal(hits, 2);
 } finally {
 delete process.env.HARVEST_MAX_RETRIES;
 delete process.env.HARVEST_TIMEOUT_MS;
 server.close();
 }
});

test("invokeVerifier: throws VerifierUnavailableError after all retries fail", async () => {
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 process.env.HARVEST_MAX_RETRIES = "2";
 let hits = 0;
 const { server, baseUrl } = await startMock((_req, res) => {
 hits++;
 res.writeHead(503, { "Content-Type": "text/plain" });
 res.end("unavailable");
 });
 process.env.VERIFIER_BASE_URL = baseUrl;
 try {
 await assert.rejects(
 () => verifier.invokeVerifier(FAKE_SLICE as any),
 (err: unknown) => err instanceof VerifierUnavailableError,
 );
 assert.equal(hits, 3, "should have tried exactly 1 + 2 retries");
 } finally {
 delete process.env.HARVEST_MAX_RETRIES;
 server.close();
 }
});

// ---------------------------------------------------------------------------
// Phase 5: Distiller
// ---------------------------------------------------------------------------

const VALID_DISTILL = {
 distilled_chosen_completion: "fn main() { println!(\"hi\"); }",
};

test("validateDistillerResponse: accepts a valid object", () => {
 const out = verifier.validateDistillerResponse(VALID_DISTILL);
 assert.equal(out.distilled_chosen_completion, "fn main() { println!(\"hi\"); }");
});

test("validateDistillerResponse: rejects missing field", () => {
 const bad = {};
 assert.throws(() => verifier.validateDistillerResponse(bad), /distilled_chosen_completion/);
});

test("validateDistillerResponse: rejects wrong type", () => {
 const bad = { distilled_chosen_completion: 123 };
 assert.throws(() => verifier.validateDistillerResponse(bad), /must be a string/);
});

test("validateDistillerResponse: rejects non-object", () => {
 assert.throws(() => verifier.validateDistillerResponse("string"), /not a JSON object/);
 assert.throws(() => verifier.validateDistillerResponse(null), /not a JSON object/);
});

test("buildDistillerPayload: includes WORKING CODE and ORIGINAL TASK sections", () => {
 const out = verifier.buildDistillerPayload({
 slice: {
 ...FAKE_SLICE,
 inceptionPrompt: "build hello",
 modifiedPaths: ["src/main.rs"],
 },
 activeFiles: [{ path: "src/main.rs", content: "fn main() {}", truncated: false }],
 });
 assert.match(out, /WORKING CODE/);
 assert.match(out, /src\/main\.rs/);
 assert.match(out, /fn main/);
 assert.match(out, /ORIGINAL TASK/);
 assert.match(out, /build hello/);
});

test("buildDistillerPayload: omits WORKING CODE when no active files", () => {
 const out = verifier.buildDistillerPayload({
 slice: { ...FAKE_SLICE, inceptionPrompt: "x" },
 activeFiles: [],
 });
 assert.match(out, /no active files captured/);
});

test("invokeDistiller: parses a clean JSON response", async () => {
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 const { server, baseUrl } = await startMock((_req, res) => {
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_DISTILL) } }] }));
 });
 process.env.VERIFIER_BASE_URL = baseUrl;
 try {
 const out = await verifier.invokeDistiller({
 cwd: "/tmp",
 slice: FAKE_SLICE as any,
 activeFiles: [],
 });
 assert.equal(out.distilled_chosen_completion, VALID_DISTILL.distilled_chosen_completion);
 } finally {
 server.close();
 }
});

test("invokeDistiller: retries on 503 and eventually throws VerifierUnavailableError", async () => {
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 process.env.HARVEST_MAX_RETRIES = "1";
 let hits = 0;
 const { server, baseUrl } = await startMock((_req, res) => {
 hits++;
 res.writeHead(503, { "Content-Type": "text/plain" });
 res.end("unavailable");
 });
 process.env.VERIFIER_BASE_URL = baseUrl;
 try {
 await assert.rejects(
 () => verifier.invokeDistiller({ cwd: "/tmp", slice: FAKE_SLICE as any, activeFiles: [] }),
 (err: unknown) => err instanceof VerifierUnavailableError,
 );
 assert.equal(hits, 2, "should have tried 1 + 1 retry");
 } finally {
 delete process.env.HARVEST_MAX_RETRIES;
 server.close();
 }
});

test("invokeDistiller: strips markdown fences before parsing", async () => {
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 const wrapped = "```json\n" + JSON.stringify(VALID_DISTILL) + "\n```";
 const { server, baseUrl } = await startMock((_req, res) => {
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ choices: [{ message: { content: wrapped } }] }));
 });
 process.env.VERIFIER_BASE_URL = baseUrl;
 try {
 const out = await verifier.invokeDistiller({ cwd: "/tmp", slice: FAKE_SLICE as any, activeFiles: [] });
 assert.match(out.distilled_chosen_completion, /println/);
 } finally {
 server.close();
 }
});
