import test from "node:test";
import assert from "node:assert/strict";
import { performSplice, type SpliceHost } from "../dist/splice.js";
import type { NeatSlice, VerifierAudit } from "../dist/types.js";

const BASE_SLICE: NeatSlice = {
 inceptionIndex: 0,
 branchEntries: [],
 sliceEntries: [
 { type: "message", id: "u1", parentId: null, timestamp: "t", message: { role: "user", content: "build hello" } },
 { type: "message", id: "a1", parentId: "u1", timestamp: "t", message: { role: "assistant", content: "fn main() {}" } },
 { type: "message", id: "t1", parentId: "a1", timestamp: "t", message: { role: "tool", content: "error" } },
 ],
 failedCode: "fn main() {}",
 compilerError: "error",
 compilerErrorRaw: "error",
 inceptionPrompt: "build hello",
 modifiedPaths: ["src/main.rs"],
 divergenceEntryId: null,
};

const BASE_AUDIT: VerifierAudit = {
 inferred_subtask: "build hello",
 divergence_detected: true,
 divergence_turn_entry_id: "t1",
 flaw_category: "logic_error",
 root_cause: "missing semicolon",
 discard_advice: "drop turns 2-3",
 steering_instructions: "Add ; at end of statement.",
 domain_tags: ["rust"],
};

function hostWith(navigateTree?: SpliceHost["navigateTree"]): { host: SpliceHost; sent: string[]; navs: unknown[] } {
 const sent: string[] = [];
 const navs: unknown[] = [];
 const host: SpliceHost = {
 sendUserMessage: (content: string) => {
 sent.push(content);
 },
 navigateTree: navigateTree
 ? (targetId, options) => {
 navs.push({ targetId, options });
 return Promise.resolve({ cancelled: false });
 }
 : undefined,
 };
 return { host, sent, navs };
}

test("performSplice: skips rewind when navigateTree is absent; steering still lands", async () => {
 const { host, sent, navs } = hostWith(undefined);
 const result = await performSplice(BASE_AUDIT, BASE_SLICE, host, {
 sessionManager: { getSessionId: () => "s" },
 });
 assert.equal(result.navigated, false);
 assert.equal(result.navigationSkippedReason, "no-navigateTree");
 assert.equal(result.steeringInjected, true);
 assert.equal(navs.length, 0);
 assert.equal(sent.length, 1);
 assert.match(sent[0], /\[STEER:K3\]/);
});

test("performSplice: rewinds when navigateTree is provided", async () => {
 const { host, sent, navs } = hostWith((targetId, options) => {
 navs.push({ targetId, options });
 return Promise.resolve({ cancelled: false });
 });
 const result = await performSplice(BASE_AUDIT, BASE_SLICE, host, {
 sessionManager: { getSessionId: () => "s" },
 });
 assert.equal(result.navigated, true);
 assert.equal(result.navigatedToEntryId, "t1");
 assert.equal(result.navigationSkippedReason, null);
 assert.equal(result.steeringInjected, true);
 assert.equal(navs.length, 1);
 assert.equal((navs[0] as { targetId: string }).targetId, "t1");
 assert.equal((navs[0] as { options: { summarize: boolean } }).options.summarize, true);
 assert.equal(sent.length, 1);
});

test("performSplice: marks cancelled when navigateTree returns cancelled: true", async () => {
 const host: SpliceHost = {
 sendUserMessage: () => {},
 navigateTree: () => Promise.resolve({ cancelled: true }),
 };
 const result = await performSplice(BASE_AUDIT, BASE_SLICE, host, {
 sessionManager: { getSessionId: () => "s" },
 });
 assert.equal(result.navigated, false);
 assert.equal(result.navigationSkippedReason, "cancelled");
 assert.equal(result.steeringInjected, true);
});

test("performSplice: skips rewind when no divergence_detected", async () => {
 const audit = { ...BASE_AUDIT, divergence_detected: false };
 const { host, sent } = hostWith();
 const result = await performSplice(audit, BASE_SLICE, host, {
 sessionManager: { getSessionId: () => "s" },
 });
 assert.equal(result.navigated, false);
 assert.equal(result.navigationSkippedReason, "no-divergence");
 assert.equal(result.steeringInjected, true);
 assert.equal(sent.length, 1);
 assert.match(sent[0], /Status: no divergence detected by auditor/);
});

test("performSplice: skips rewind when no target id is resolvable", async () => {
 const audit = { ...BASE_AUDIT, divergence_turn_entry_id: undefined, divergence_turn: undefined };
 const { host, sent, navs } = hostWith();
 const result = await performSplice(audit, BASE_SLICE, host, {
 sessionManager: { getSessionId: () => "s" },
 });
 assert.equal(result.navigated, false);
 assert.equal(result.navigationSkippedReason, "no-target");
 assert.equal(result.steeringInjected, true);
 assert.equal(navs.length, 0);
 assert.equal(sent.length, 1);
});

test("performSplice: still lands the steering message when navigateTree throws", async () => {
 const host: SpliceHost = {
 sendUserMessage: (c) => {
 sent.push(c);
 },
 navigateTree: () => Promise.reject(new Error("boom")),
 };
 const sent: string[] = [];
 const result = await performSplice(BASE_AUDIT, BASE_SLICE, host, {
 sessionManager: { getSessionId: () => "s" },
 ui: { notify: () => {} },
 });
 assert.equal(result.navigated, false);
 assert.equal(result.steeringInjected, true);
 assert.equal(sent.length, 1);
 assert.match(sent[0], /\[STEER:K3\]/);
});

test("performSplice: steering body carries compiler error, verify command, and files", async () => {
 const { host, sent } = hostWith();
 const result = await performSplice(
 BASE_AUDIT,
 BASE_SLICE,
 host,
 { sessionManager: { getSessionId: () => "s" } },
 { failedCommand: "cargo build" },
 );
 assert.equal(result.steeringInjected, true);
 assert.match(sent[0], /Flaw: logic_error — missing semicolon/);
 assert.match(sent[0], /Error: error/);
 assert.match(sent[0], /Fix: Add ; at end of statement\./);
 assert.match(sent[0], /Verify: run `cargo build` and confirm it exits clean\./);
 assert.match(sent[0], /Files: rewrite src\/main\.rs/);
 assert.match(sent[0], /Domain: rust/);
});

test("performSplice: verify line omitted when no failed command is known", async () => {
 const { host, sent } = hostWith();
 await performSplice(BASE_AUDIT, BASE_SLICE, host, {
 sessionManager: { getSessionId: () => "s" },
 });
 assert.doesNotMatch(sent[0], /Verify:/);
});

test("performSplice: files line omitted when slice has no modified paths", async () => {
 const { host, sent } = hostWith();
 const emptyPathsSlice: NeatSlice = { ...BASE_SLICE, modifiedPaths: [] };
 await performSplice(BASE_AUDIT, emptyPathsSlice, host, {
 sessionManager: { getSessionId: () => "s" },
 });
 assert.doesNotMatch(sent[0], /Files:/);
});
