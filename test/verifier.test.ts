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

// ---------------------------------------------------------------------------
// Phase 6: Reviewer
// ---------------------------------------------------------------------------

const VALID_REVIEW = {
 flaw_category: "SemanticLogicError",
 diagnosis: "Forgot to hoist drawer state to ViewModel.",
 steering_instructions: "Move the local state into a ViewModel property.",
};

test("validateReviewerResponse: accepts the spec's primary schema (diagnosis + steering)", () => {
 const minimal = { diagnosis: "X", steering_instructions: "Y" };
 const out = verifier.validateReviewerResponse(minimal);
 assert.equal(out.flaw_category, "SemanticLogicError"); // default
 assert.equal(out.diagnosis, "X");
});

test("validateReviewerResponse: preserves a supplied flaw_category", () => {
 const out = verifier.validateReviewerResponse(VALID_REVIEW);
 assert.equal(out.flaw_category, "SemanticLogicError");
});

test("validateReviewerResponse: rejects missing diagnosis", () => {
 const bad = { steering_instructions: "Y" };
 assert.throws(() => verifier.validateReviewerResponse(bad), /diagnosis/);
});

test("validateReviewerResponse: rejects missing steering_instructions", () => {
 const bad = { diagnosis: "X" };
 assert.throws(() => verifier.validateReviewerResponse(bad), /steering_instructions/);
});

test("validateReviewerResponse: rejects wrong types", () => {
 assert.throws(() => verifier.validateReviewerResponse(null), /not a JSON object/);
 assert.throws(() => verifier.validateReviewerResponse({ diagnosis: 1, steering_instructions: "y" }), /diagnosis must be a string/);
 assert.throws(() => verifier.validateReviewerResponse({ diagnosis: "x", steering_instructions: 2 }), /steering_instructions must be a string/);
});

test("buildReviewerPayload: includes HUMAN FEEDBACK and ACTIVE FILES sections", () => {
 const out = verifier.buildReviewerPayload({
 slice: { ...FAKE_SLICE, inceptionPrompt: "build drawer" },
 activeFiles: [{ path: "drawer.ts", content: "const x = 1;", truncated: false }],
 humanFeedback: "you forgot state hoisting",
 });
 assert.match(out, /HUMAN FEEDBACK/);
 assert.match(out, /you forgot state hoisting/);
 assert.match(out, /ACTIVE FILES/);
 assert.match(out, /drawer\.ts/);
 assert.match(out, /ORIGINAL TASK/);
 assert.match(out, /build drawer/);
});

test("invokeReviewer: parses a clean JSON response", async () => {
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 const { server, baseUrl } = await startMock((_req, res) => {
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_REVIEW) } }] }));
 });
 process.env.VERIFIER_BASE_URL = baseUrl;
 try {
 const out = await verifier.invokeReviewer({
 cwd: "/tmp",
 slice: FAKE_SLICE as any,
 activeFiles: [],
 humanFeedback: "review this",
 });
 assert.equal(out.diagnosis, "Forgot to hoist drawer state to ViewModel.");
 assert.match(out.steering_instructions, /ViewModel/);
 } finally {
 server.close();
 }
});

test("invokeReviewer: retries on 429 and eventually throws VerifierUnavailableError", async () => {
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 process.env.HARVEST_MAX_RETRIES = "1";
 let hits = 0;
 const { server, baseUrl } = await startMock((_req, res) => {
 hits++;
 res.writeHead(429, { "Content-Type": "text/plain" });
 res.end("rate limited");
 });
 process.env.VERIFIER_BASE_URL = baseUrl;
 try {
 await assert.rejects(
 () => verifier.invokeReviewer({ cwd: "/tmp", slice: FAKE_SLICE as any, activeFiles: [], humanFeedback: "x" }),
 (err: unknown) => err instanceof VerifierUnavailableError,
 );
 assert.equal(hits, 2, "1 initial + 1 retry");
 } finally {
 delete process.env.HARVEST_MAX_RETRIES;
 server.close();
 }
});

// ---------------------------------------------------------------------------
// Phase 8: Opinion (proactive architectural review of working code)
// ---------------------------------------------------------------------------

const VALID_OPINION = {
 opinion_summary: "This file opens the database connection on every request.",
 refactor_instructions: "Hoist the connection into a module-level singleton with lazy init.",
 flaw_category: "PerformanceBottleneck",
};

test("validateOpinionResponse: accepts a valid object", () => {
 const out = verifier.validateOpinionResponse(VALID_OPINION);
 assert.equal(out.opinion_summary, VALID_OPINION.opinion_summary);
 assert.equal(out.flaw_category, "PerformanceBottleneck");
});

test("validateOpinionResponse: rejects missing opinion_summary", () => {
 const bad = { refactor_instructions: "x", flaw_category: "y" };
 assert.throws(() => verifier.validateOpinionResponse(bad), /opinion_summary/);
});

test("validateOpinionResponse: rejects missing refactor_instructions", () => {
 const bad = { opinion_summary: "x", flaw_category: "y" };
 assert.throws(() => verifier.validateOpinionResponse(bad), /refactor_instructions/);
});

test("validateOpinionResponse: rejects missing or empty flaw_category", () => {
 assert.throws(() => verifier.validateOpinionResponse({ opinion_summary: "x", refactor_instructions: "y" }), /flaw_category/);
 assert.throws(() => verifier.validateOpinionResponse({ opinion_summary: "x", refactor_instructions: "y", flaw_category: "" }), /flaw_category/);
});

test("validateOpinionResponse: rejects wrong types", () => {
 assert.throws(() => verifier.validateOpinionResponse(null), /not a JSON object/);
 assert.throws(() => verifier.validateOpinionResponse({ opinion_summary: 1, refactor_instructions: "y", flaw_category: "z" }), /opinion_summary must be a string/);
});

test("buildOpinionPayload: includes REVIEW REQUEST, optional query, and active files", () => {
 const out = verifier.buildOpinionPayload({
 slice: { ...FAKE_SLICE, inceptionPrompt: "build hello" },
 activeFiles: [{ path: "main.rs", content: "fn main() {}", truncated: false }],
 optionalQuery: "is this safe from SQL injection?",
 });
 assert.match(out, /REVIEW REQUEST/);
 assert.match(out, /is this safe from SQL injection/);
 assert.match(out, /ACTIVE FILES/);
 assert.match(out, /main\.rs/);
});

test("buildOpinionPayload: omits the user query line when no optionalQuery", () => {
 const out = verifier.buildOpinionPayload({
 slice: { ...FAKE_SLICE, inceptionPrompt: "x" },
 activeFiles: [],
 optionalQuery: "",
 });
 assert.doesNotMatch(out, /specifically asks/);
 assert.match(out, /general architectural/);
});

test("invokeOpinion: parses a clean JSON response", async () => {
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 const { server, baseUrl } = await startMock((_req, res) => {
 res.writeHead(200, { "Content-Type": "application/json" });
 res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(VALID_OPINION) } }] }));
 });
 process.env.VERIFIER_BASE_URL = baseUrl;
 try {
 const out = await verifier.invokeOpinion({
 cwd: "/tmp",
 slice: FAKE_SLICE as any,
 activeFiles: [],
 optionalQuery: "performance check",
 });
 assert.equal(out.flaw_category, "PerformanceBottleneck");
 assert.match(out.refactor_instructions, /singleton/);
 } finally {
 server.close();
 }
});

test("invokeOpinion: retries on 503 and eventually throws VerifierUnavailableError", async () => {
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
 () => verifier.invokeOpinion({ cwd: "/tmp", slice: FAKE_SLICE as any, activeFiles: [], optionalQuery: "x" }),
 (err: unknown) => err instanceof VerifierUnavailableError,
 );
 assert.equal(hits, 2, "1 initial + 1 retry");
 } finally {
 delete process.env.HARVEST_MAX_RETRIES;
 server.close();
 }
});

// ---------------------------------------------------------------------------
// Phase 8.1: VerifierConfigError (graceful failure when env is missing)
// ---------------------------------------------------------------------------

import type { VerifierConfigError } from "../dist/types.js";

test("invokeVerifier: throws VerifierConfigError when VERIFIER_BASE_URL is missing", async () => {
 const saved = {
 baseUrl: process.env.VERIFIER_BASE_URL,
 key: process.env.VERIFIER_API_KEY,
 model: process.env.VERIFIER_MODEL,
 };
 delete process.env.VERIFIER_BASE_URL;
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 try {
 await assert.rejects(
 () => verifier.invokeVerifier(FAKE_SLICE as any),
 (err: unknown) => err instanceof Error && err.name === "VerifierConfigError" && /VERIFIER_BASE_URL/.test((err as Error).message),
 );
 } finally {
 if (saved.baseUrl) process.env.VERIFIER_BASE_URL = saved.baseUrl;
 if (saved.key) process.env.VERIFIER_API_KEY = saved.key;
 if (saved.model) process.env.VERIFIER_MODEL = saved.model;
 }
});

test("invokeVerifier: throws VerifierConfigError when ALL three env vars are missing", async () => {
 const saved = {
 baseUrl: process.env.VERIFIER_BASE_URL,
 key: process.env.VERIFIER_API_KEY,
 model: process.env.VERIFIER_MODEL,
 };
 delete process.env.VERIFIER_BASE_URL;
 delete process.env.VERIFIER_API_KEY;
 delete process.env.VERIFIER_MODEL;
 try {
 await assert.rejects(
 () => verifier.invokeVerifier(FAKE_SLICE as any),
 (err: unknown) => {
 if (!(err instanceof Error) || err.name !== "VerifierConfigError") return false;
 const msg = (err as Error).message;
 return /VERIFIER_BASE_URL/.test(msg) && /VERIFIER_API_KEY/.test(msg) && /VERIFIER_MODEL/.test(msg);
 },
 );
 } finally {
 if (saved.baseUrl) process.env.VERIFIER_BASE_URL = saved.baseUrl;
 if (saved.key) process.env.VERIFIER_API_KEY = saved.key;
 if (saved.model) process.env.VERIFIER_MODEL = saved.model;
 }
});

test("invokeDistiller: throws VerifierConfigError when VERIFIER_API_KEY is missing", async () => {
 const saved = {
 baseUrl: process.env.VERIFIER_BASE_URL,
 key: process.env.VERIFIER_API_KEY,
 model: process.env.VERIFIER_MODEL,
 };
 process.env.VERIFIER_BASE_URL = "https://example.test";
 delete process.env.VERIFIER_API_KEY;
 process.env.VERIFIER_MODEL = "m";
 try {
 await assert.rejects(
 () => verifier.invokeDistiller({ cwd: "/tmp", slice: FAKE_SLICE as any, activeFiles: [] }),
 (err: unknown) => err instanceof Error && err.name === "VerifierConfigError" && /VERIFIER_API_KEY/.test((err as Error).message),
 );
 } finally {
 if (saved.baseUrl) process.env.VERIFIER_BASE_URL = saved.baseUrl;
 if (saved.key) process.env.VERIFIER_API_KEY = saved.key;
 if (saved.model) process.env.VERIFIER_MODEL = saved.model;
 }
});

test("invokeReviewer: throws VerifierConfigError when VERIFIER_MODEL is missing", async () => {
 const saved = {
 baseUrl: process.env.VERIFIER_BASE_URL,
 key: process.env.VERIFIER_API_KEY,
 model: process.env.VERIFIER_MODEL,
 };
 process.env.VERIFIER_BASE_URL = "https://example.test";
 process.env.VERIFIER_API_KEY = "k";
 delete process.env.VERIFIER_MODEL;
 try {
 await assert.rejects(
 () => verifier.invokeReviewer({ cwd: "/tmp", slice: FAKE_SLICE as any, activeFiles: [], humanFeedback: "x" }),
 (err: unknown) => err instanceof Error && err.name === "VerifierConfigError" && /VERIFIER_MODEL/.test((err as Error).message),
 );
 } finally {
 if (saved.baseUrl) process.env.VERIFIER_BASE_URL = saved.baseUrl;
 if (saved.key) process.env.VERIFIER_API_KEY = saved.key;
 if (saved.model) process.env.VERIFIER_MODEL = saved.model;
 }
});

test("invokeOpinion: throws VerifierConfigError when VERIFIER_BASE_URL is missing", async () => {
 const saved = {
 baseUrl: process.env.VERIFIER_BASE_URL,
 key: process.env.VERIFIER_API_KEY,
 model: process.env.VERIFIER_MODEL,
 };
 delete process.env.VERIFIER_BASE_URL;
 process.env.VERIFIER_API_KEY = "k";
 process.env.VERIFIER_MODEL = "m";
 try {
 await assert.rejects(
 () => verifier.invokeOpinion({ cwd: "/tmp", slice: FAKE_SLICE as any, activeFiles: [], optionalQuery: "x" }),
 (err: unknown) => err instanceof Error && err.name === "VerifierConfigError" && /VERIFIER_BASE_URL/.test((err as Error).message),
 );
 } finally {
 if (saved.baseUrl) process.env.VERIFIER_BASE_URL = saved.baseUrl;
 if (saved.key) process.env.VERIFIER_API_KEY = saved.key;
 if (saved.model) process.env.VERIFIER_MODEL = saved.model;
 }
});

test("VerifierConfigError: does NOT attempt any HTTP retries (no mock server needed)", async () => {
 // Save env state
 const saved = {
 baseUrl: process.env.VERIFIER_BASE_URL,
 key: process.env.VERIFIER_API_KEY,
 model: process.env.VERIFIER_MODEL,
 };
 delete process.env.VERIFIER_BASE_URL;
 delete process.env.VERIFIER_API_KEY;
 delete process.env.VERIFIER_MODEL;
 try {
 // No mock server is started; if retry logic kicks in, this would
 // hang trying to reach a non-existent endpoint. Fail-fast is the test.
 const start = Date.now();
 await assert.rejects(
 () => verifier.invokeVerifier(FAKE_SLICE as any),
 (err: unknown) => err instanceof Error && err.name === "VerifierConfigError",
 );
 const elapsed = Date.now() - start;
 // Should fail in <100ms (sync env check), not after retries + backoff
 assert.ok(elapsed < 200, "VerifierConfigError must fail fast, took " + elapsed + "ms");
 } finally {
 if (saved.baseUrl) process.env.VERIFIER_BASE_URL = saved.baseUrl;
 if (saved.key) process.env.VERIFIER_API_KEY = saved.key;
 if (saved.model) process.env.VERIFIER_MODEL = saved.model;
 }
});
