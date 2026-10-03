/**
 * Unit tests for the harvest path resolver + legacy migration.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
 resolveHarvestRoot,
 ensureHarvestRoot,
 migrateLegacyHarvest,
} from "../dist/paths.js";

async function tmpDir(prefix: string): Promise<string> {
 return await mkdtemp(join(tmpdir(), prefix));
}

test("resolveHarvestRoot: honours the PI_HARVEST_ROOT override", () => {
 const prev = process.env.PI_HARVEST_ROOT;
 process.env.PI_HARVEST_ROOT = join(tmpdir(), "pi-harvest-override");
 try {
 assert.equal(resolveHarvestRoot(), join(tmpdir(), "pi-harvest-override"));
 } finally {
 if (prev === undefined) delete process.env.PI_HARVEST_ROOT;
 else process.env.PI_HARVEST_ROOT = prev;
 }
});

test("resolveHarvestRoot: falls back to the user-home .pi/harvest", () => {
 const prev = process.env.PI_HARVEST_ROOT;
 delete process.env.PI_HARVEST_ROOT;
 try {
 const root = resolveHarvestRoot();
 assert.ok(root.endsWith(join(".pi", "harvest")), "expected <home>/.pi/harvest, got " + root);
 assert.ok(root.includes("harvest"));
 } finally {
 if (prev === undefined) delete process.env.PI_HARVEST_ROOT;
 else process.env.PI_HARVEST_ROOT = prev;
 }
});

test("resolveHarvestRoot: ignores blank/whitespace-only overrides", () => {
 const prev = process.env.PI_HARVEST_ROOT;
 process.env.PI_HARVEST_ROOT = "   ";
 try {
 const root = resolveHarvestRoot();
 assert.ok(root.endsWith(join(".pi", "harvest")), "blank override should fall back, got " + root);
 } finally {
 if (prev === undefined) delete process.env.PI_HARVEST_ROOT;
 else process.env.PI_HARVEST_ROOT = prev;
 }
});

test("ensureHarvestRoot: creates the directory when missing", async () => {
 const root = await tmpDir("pi-harvest-ensure-");
 const target = join(root, "nested", "harvest");
 const prev = process.env.PI_HARVEST_ROOT;
 process.env.PI_HARVEST_ROOT = target;
 try {
 const out = ensureHarvestRoot();
 assert.equal(out, target);
 await access(target); // throws if missing
 } finally {
 if (prev === undefined) delete process.env.PI_HARVEST_ROOT;
 else process.env.PI_HARVEST_ROOT = prev;
 await rm(root, { recursive: true, force: true });
 }
});

test("migrateLegacyHarvest: copies legacy jsonl into the user-home root", async () => {
 const workspace = await tmpDir("pi-harvest-migrate-ws-");
 const target = await tmpDir("pi-harvest-migrate-target-");
 const legacy = join(workspace, ".pi", "harvest");
 await mkdir(legacy, { recursive: true });
 await writeFile(join(legacy, "trajectories_2026_09.jsonl"), '{"a":1}\n{"a":2}\n', "utf8");
 await writeFile(join(legacy, "sft_golden_2026_09.jsonl"), '{"b":1}\n', "utf8");
 await writeFile(join(legacy, "readme.txt"), "ignore me", "utf8");

 const prev = process.env.PI_HARVEST_ROOT;
 process.env.PI_HARVEST_ROOT = target;
 try {
 const result = migrateLegacyHarvest(workspace);
 assert.equal(result.migrated.length, 2, "expected 2 .jsonl files migrated");
 assert.equal(result.skipped.length, 0);
 assert.equal(result.targetRoot, target);

 // Files exist at destination with identical content.
 const traj = await readFile(join(target, "trajectories_2026_09.jsonl"), "utf8");
 assert.equal(traj, '{"a":1}\n{"a":2}\n');
 const sft = await readFile(join(target, "sft_golden_2026_09.jsonl"), "utf8");
 assert.equal(sft, '{"b":1}\n');

 // Originals are NOT deleted (copy, not move).
 const origTraj = await readFile(join(legacy, "trajectories_2026_09.jsonl"), "utf8");
 assert.equal(origTraj, '{"a":1}\n{"a":2}\n');

 // Non-.jsonl files are ignored entirely.
 await assert.rejects(() => access(join(target, "readme.txt")));
 } finally {
 if (prev === undefined) delete process.env.PI_HARVEST_ROOT;
 else process.env.PI_HARVEST_ROOT = prev;
 await rm(workspace, { recursive: true, force: true });
 await rm(target, { recursive: true, force: true });
 }
});

test("migrateLegacyHarvest: skips files already present at the destination", async () => {
 const workspace = await tmpDir("pi-harvest-migrate2-ws-");
 const target = await tmpDir("pi-harvest-migrate2-target-");
 const legacy = join(workspace, ".pi", "harvest");
 await mkdir(legacy, { recursive: true });
 await mkdir(target, { recursive: true });
 await writeFile(join(legacy, "trajectories_2026_09.jsonl"), '{"old":1}\n', "utf8");
 await writeFile(join(target, "trajectories_2026_09.jsonl"), '{"existing":1}\n', "utf8");

 const prev = process.env.PI_HARVEST_ROOT;
 process.env.PI_HARVEST_ROOT = target;
 try {
 const result = migrateLegacyHarvest(workspace);
 assert.equal(result.migrated.length, 0);
 assert.equal(result.skipped.length, 1);
 assert.equal(result.skipped[0], "trajectories_2026_09.jsonl");

 // Existing content is preserved (no clobber, no merge).
 const content = await readFile(join(target, "trajectories_2026_09.jsonl"), "utf8");
 assert.equal(content, '{"existing":1}\n');
 } finally {
 if (prev === undefined) delete process.env.PI_HARVEST_ROOT;
 else process.env.PI_HARVEST_ROOT = prev;
 await rm(workspace, { recursive: true, force: true });
 await rm(target, { recursive: true, force: true });
 }
});

test("migrateLegacyHarvest: no-op when the legacy directory is missing", async () => {
 const workspace = await tmpDir("pi-harvest-migrate3-ws-");
 const target = await tmpDir("pi-harvest-migrate3-target-");
 const prev = process.env.PI_HARVEST_ROOT;
 process.env.PI_HARVEST_ROOT = target;
 try {
 const result = migrateLegacyHarvest(workspace);
 assert.equal(result.migrated.length, 0);
 assert.equal(result.skipped.length, 0);
 assert.equal(result.sourceDir, null);
 } finally {
 if (prev === undefined) delete process.env.PI_HARVEST_ROOT;
 else process.env.PI_HARVEST_ROOT = prev;
 await rm(workspace, { recursive: true, force: true });
 await rm(target, { recursive: true, force: true });
 }
});