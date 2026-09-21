/**
 * Unit tests for the telemetry aggregation module.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as telemetry from "../dist/telemetry.js";
import * as sink from "../dist/sink.js";

async function tmpCwd() {
 return await mkdtemp(join(tmpdir(), "pi-harvest-telemetry-"));
}

async function writeRecords(cwd: string, records: any[]) {
 await mkdir(join(cwd, ".pi", "harvest"), { recursive: true });
 const path = sink.currentSinkPath(cwd);
 for (const r of records) {
 await writeFile(path, JSON.stringify(r) + "\n", { encoding: "utf8", flag: "a" });
 }
}

test("aggregateTelemetry: returns empty summary when sink is missing", async () => {
 const cwd = await tmpCwd();
 try {
 const out = await telemetry.aggregateTelemetry(cwd);
 assert.equal(out.recordCount, 0);
 assert.deepEqual(out.topFlaws, []);
 assert.equal(out.uniqueCategories, 0);
 assert.equal(out.totalFlaws, 0);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("aggregateTelemetry: counts flaw_category occurrences", async () => {
 const cwd = await tmpCwd();
 try {
 await writeRecords(cwd, [
 { k3_audit: { flaw_category: "logic_error" } },
 { k3_audit: { flaw_category: "logic_error" } },
 { k3_audit: { flaw_category: "missed_spec" } },
 ]);
 const out = await telemetry.aggregateTelemetry(cwd, 3);
 assert.equal(out.recordCount, 3);
 assert.equal(out.totalFlaws, 3);
 assert.equal(out.uniqueCategories, 2);
 assert.equal(out.topFlaws.length, 2);
 assert.equal(out.topFlaws[0].flaw_category, "logic_error");
 assert.equal(out.topFlaws[0].count, 2);
 assert.equal(out.topFlaws[1].flaw_category, "missed_spec");
 assert.equal(out.topFlaws[1].count, 1);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("aggregateTelemetry: returns only the top N", async () => {
 const cwd = await tmpCwd();
 try {
 const records = [
 ...Array.from({ length: 14 }, () => ({ k3_audit: { flaw_category: "borrow_check" } })),
 ...Array.from({ length: 8 }, () => ({ k3_audit: { flaw_category: "state_hoisting" } })),
 ...Array.from({ length: 3 }, () => ({ k3_audit: { flaw_category: "liquid_syntax" } })),
 ...Array.from({ length: 2 }, () => ({ k3_audit: { flaw_category: "off_topic" } })),
 ];
 await writeRecords(cwd, records);
 const out = await telemetry.aggregateTelemetry(cwd, 3);
 assert.equal(out.topFlaws.length, 3);
 assert.equal(out.topFlaws[0].flaw_category, "borrow_check");
 assert.equal(out.topFlaws[0].count, 14);
 assert.equal(out.topFlaws[1].flaw_category, "state_hoisting");
 assert.equal(out.topFlaws[1].count, 8);
 assert.equal(out.topFlaws[2].flaw_category, "liquid_syntax");
 assert.equal(out.topFlaws[2].count, 3);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("aggregateTelemetry: ignores malformed lines", async () => {
 const cwd = await tmpCwd();
 try {
 await writeRecords(cwd, [
 { k3_audit: { flaw_category: "logic_error" } },
 // malformed JSON
 { k3_audit: { flaw_category: "logic_error" } },
 ]);
 const path = sink.currentSinkPath(cwd);
 await writeFile(path, "this is not json\n", { encoding: "utf8", flag: "a" });
 const out = await telemetry.aggregateTelemetry(cwd);
 assert.equal(out.recordCount, 2); // only valid JSON counted
 assert.equal(out.topFlaws[0].count, 2);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("aggregateTelemetry: ignores records without flaw_category", async () => {
 const cwd = await tmpCwd();
 try {
 await writeRecords(cwd, [
 { k3_audit: { flaw_category: "logic_error" } },
 { k3_audit: {} },
 { no_audit: true },
 ]);
 const out = await telemetry.aggregateTelemetry(cwd);
 assert.equal(out.recordCount, 3);
 assert.equal(out.totalFlaws, 1); // only one had a string flaw_category
 assert.equal(out.uniqueCategories, 1);
 } finally {
 await rm(cwd, { recursive: true, force: true });
 }
});

test("formatTelemetryForNotify: formats top-3 lines and zero state", () => {
 const empty = telemetry.formatTelemetryForNotify({
 sinkPath: "/x/y.jsonl",
 recordCount: 0,
 topFlaws: [],
 totalFlaws: 0,
 uniqueCategories: 0,
 });
 assert.match(empty, /Harvest Telemetry/);
 assert.match(empty, /\(none recorded yet\)/);
});

test("formatTelemetryForNotify: numbered top flaws", () => {
 const text = telemetry.formatTelemetryForNotify({
 sinkPath: "/x/y.jsonl",
 recordCount: 25,
 topFlaws: [
 { flaw_category: "logic_error", count: 14 },
 { flaw_category: "state_hoisting", count: 8 },
 { flaw_category: "liquid_syntax", count: 3 },
 ],
 totalFlaws: 25,
 uniqueCategories: 3,
 });
 assert.match(text, /1\. logic_error \(14\)/);
 assert.match(text, /2\. state_hoisting \(8\)/);
 assert.match(text, /3\. liquid_syntax \(3\)/);
});
