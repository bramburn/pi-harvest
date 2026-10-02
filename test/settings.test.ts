/** Tests for /harvest-settings persistence, env application, and lane fallbacks. */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
 applyLaneSelections,
 deriveTag,
 laneEnvPrefix,
 loadSettings,
 resetLaneEnvSnapshots,
 restoreLaneEnv,
 setLaneSelection,
 settingsPath,
} from "../dist/settings.js";
import { pickLaneModel, searchableSelect } from "../dist/model-picker.js";
import { readEnv } from "../dist/verifier.js";

const LANE_KEYS = [
 "VERIFIER_BASE_URL",
 "VERIFIER_API_KEY",
 "VERIFIER_MODEL",
 "VERIFIER_PROVIDER",
 "HARVEST_DISTILLER_BASE_URL",
 "HARVEST_DISTILLER_API_KEY",
 "HARVEST_DISTILLER_MODEL",
 "HARVEST_DISTILLER_PROVIDER",
 "HARVEST_REVIEWER_BASE_URL",
 "HARVEST_REVIEWER_API_KEY",
 "HARVEST_REVIEWER_MODEL",
 "HARVEST_REVIEWER_PROVIDER",
 "HARVEST_OPINION_BASE_URL",
 "HARVEST_OPINION_API_KEY",
 "HARVEST_OPINION_MODEL",
 "HARVEST_OPINION_PROVIDER",
];

function tmpCwd(): string {
 return fs.mkdtempSync(path.join(os.tmpdir(), "harvest-settings-"));
}

function snapshotEnv(): Record<string, string | undefined> {
 const snap: Record<string, string | undefined> = {};
 for (const key of LANE_KEYS) snap[key] = process.env[key];
 return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
 for (const key of LANE_KEYS) {
  if (snap[key] === undefined) delete process.env[key];
  else process.env[key] = snap[key];
 }
}

/** Fake pi ModelRegistry: deepseek + openrouter models with resolvable auth. */
function fakeRegistry(): {
 find(p: string, id: string): unknown;
 getApiKeyAndHeaders(model: unknown): Promise<unknown>;
} {
 return {
  find: (provider: string, modelId: string) => {
   if (provider === "deepseek" && modelId === "deepseek-chat") {
    return { api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" };
   }
   if (provider === "openrouter" && modelId === "deepseek/deepseek-chat") {
    return { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" };
   }
   return undefined;
  },
  getApiKeyAndHeaders: async (model: unknown) => {
   const baseUrl = (model as { baseUrl?: string }).baseUrl;
   return { ok: true, apiKey: "sk-test-123", ...(baseUrl ? { baseUrl } : {}) };
  },
 };
}

test("laneEnvPrefix keeps historical VERIFIER_* names for the parent lane", () => {
 assert.equal(laneEnvPrefix("verifier"), "VERIFIER");
 assert.equal(laneEnvPrefix("distiller"), "HARVEST_DISTILLER");
 assert.equal(laneEnvPrefix("reviewer"), "HARVEST_REVIEWER");
 assert.equal(laneEnvPrefix("opinion"), "HARVEST_OPINION");
});

test("settings file roundtrip and path", () => {
 const cwd = tmpCwd();
 try {
  assert.equal(loadSettings(cwd), null);
  setLaneSelection(cwd, "verifier", { provider: "deepseek", modelId: "deepseek-chat", tag: "K3" });
  setLaneSelection(cwd, "distiller", { provider: "openrouter", modelId: "deepseek/deepseek-chat" });
  setLaneSelection(cwd, "reviewer", { provider: "deepseek", modelId: "deepseek-chat" });
  setLaneSelection(cwd, "opinion", { provider: "deepseek", modelId: "deepseek-chat" });
  const loaded = loadSettings(cwd);
  assert.equal(loaded?.verifier?.tag, "K3");
  assert.equal(loaded?.distiller?.provider, "openrouter");
  assert.equal(loaded?.reviewer?.modelId, "deepseek-chat");
  assert.equal(loaded?.opinion?.provider, "deepseek");
  assert.ok(fs.existsSync(settingsPath(cwd)));
  assert.ok(settingsPath(cwd).includes(path.join(".pi", "harvest")));
 } finally {
  fs.rmSync(cwd, { recursive: true, force: true });
 }
});

test("loadSettings tolerates corrupt files and rejects other versions", () => {
 const cwd = tmpCwd();
 try {
  fs.mkdirSync(path.dirname(settingsPath(cwd)), { recursive: true });
  fs.writeFileSync(settingsPath(cwd), "not json {");
  assert.equal(loadSettings(cwd), null);
  fs.writeFileSync(settingsPath(cwd), JSON.stringify({ version: 2, verifier: { provider: "a", modelId: "b" } }));
  assert.equal(loadSettings(cwd), null);
  fs.writeFileSync(
   settingsPath(cwd),
   JSON.stringify({ version: 1, verifier: { provider: "a", modelId: "b" }, opinion: { provider: "", modelId: "x" } }),
  );
  const loaded = loadSettings(cwd);
  assert.equal(loaded?.verifier?.modelId, "b");
  assert.equal(loaded?.opinion, undefined);
 } finally {
  fs.rmSync(cwd, { recursive: true, force: true });
 }
});

test("setLaneSelection clears a lane and keeps the others", () => {
 const cwd = tmpCwd();
 try {
  setLaneSelection(cwd, "verifier", { provider: "deepseek", modelId: "deepseek-chat" });
  setLaneSelection(cwd, "reviewer", { provider: "deepseek", modelId: "deepseek-chat" });
  setLaneSelection(cwd, "verifier", undefined);
  const loaded = loadSettings(cwd);
  assert.equal(loaded?.verifier, undefined);
  assert.equal(loaded?.reviewer?.provider, "deepseek");
 } finally {
  fs.rmSync(cwd, { recursive: true, force: true });
 }
});

test("deriveTag sanitizes provider names", () => {
 assert.equal(deriveTag("deepseek"), "DEEPSEEK");
 assert.equal(deriveTag("open router!"), "OPENROUTER");
 assert.equal(deriveTag("  "), "LLM");
});

test("applyLaneSelections maps a stored sub-lane model onto its own env vars", async () => {
 const snap = snapshotEnv();
 const cwd = tmpCwd();
 resetLaneEnvSnapshots();
 try {
  process.env.VERIFIER_MODEL = "env-verifier-model";
  process.env.VERIFIER_BASE_URL = "https://env.example/v1";
  process.env.VERIFIER_API_KEY = "sk-env";
  setLaneSelection(cwd, "reviewer", { provider: "deepseek", modelId: "deepseek-chat" });

  const results = await applyLaneSelections(cwd, fakeRegistry());
  const reviewer = results.find((r) => r.lane === "reviewer");
  assert.equal(reviewer?.status, "applied");
  assert.equal(process.env.HARVEST_REVIEWER_MODEL, "deepseek-chat");
  assert.equal(process.env.HARVEST_REVIEWER_BASE_URL, "https://api.deepseek.com/v1");
  assert.equal(process.env.HARVEST_REVIEWER_API_KEY, "sk-test-123");
  assert.equal(process.env.HARVEST_REVIEWER_PROVIDER, "DEEPSEEK");
  // Verifier lane untouched (no stored selection, nothing to restore).
  assert.equal(process.env.VERIFIER_MODEL, "env-verifier-model");
 } finally {
  restoreEnv(snap);
  resetLaneEnvSnapshots();
  fs.rmSync(cwd, { recursive: true, force: true });
 }
});

test("applyLaneSelections maps the verifier lane onto the historical VERIFIER_* vars", async () => {
 const snap = snapshotEnv();
 const cwd = tmpCwd();
 resetLaneEnvSnapshots();
 try {
  process.env.VERIFIER_MODEL = "env-verifier-model";
  setLaneSelection(cwd, "verifier", { provider: "openrouter", modelId: "deepseek/deepseek-chat" });
  const results = await applyLaneSelections(cwd, fakeRegistry());
  assert.equal(results.find((r) => r.lane === "verifier")?.status, "applied");
  assert.equal(process.env.VERIFIER_MODEL, "deepseek/deepseek-chat");
  assert.equal(process.env.VERIFIER_BASE_URL, "https://openrouter.ai/api/v1");
  assert.equal(process.env.VERIFIER_PROVIDER, "OPENROUTER");
 } finally {
  restoreEnv(snap);
  resetLaneEnvSnapshots();
  fs.rmSync(cwd, { recursive: true, force: true });
 }
});

test("readEnv falls back to the verifier lane for sub-lanes", () => {
 const snap = snapshotEnv();
 resetLaneEnvSnapshots();
 try {
  delete process.env.HARVEST_DISTILLER_BASE_URL;
  delete process.env.HARVEST_DISTILLER_API_KEY;
  delete process.env.HARVEST_DISTILLER_MODEL;
  process.env.VERIFIER_BASE_URL = "https://api.deepseek.com/v1";
  process.env.VERIFIER_API_KEY = "sk-v";
  process.env.VERIFIER_MODEL = "deepseek-chat";

  // No sub-lane env: distiller rides the verifier config.
  const d = readEnv("distiller");
  assert.equal(d.model, "deepseek-chat");
  assert.equal(d.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(d.apiKey, "sk-v");

  // Sub-lane env wins when present.
  process.env.HARVEST_DISTILLER_MODEL = "other-model";
  assert.equal(readEnv("distiller").model, "other-model");
  assert.equal(readEnv("verifier").model, "deepseek-chat");

  delete process.env.HARVEST_DISTILLER_MODEL;
 } finally {
  restoreEnv(snap);
  resetLaneEnvSnapshots();
 }
});

test("applyLaneSelections restores original env when selection is cleared or model is missing", async () => {
 const snap = snapshotEnv();
 const cwd = tmpCwd();
 resetLaneEnvSnapshots();
 try {
  process.env.HARVEST_OPINION_MODEL = "env-opinion-model";
  process.env.HARVEST_OPINION_BASE_URL = "https://env.example/v1";
  setLaneSelection(cwd, "opinion", { provider: "deepseek", modelId: "deepseek-chat" });
  await applyLaneSelections(cwd, fakeRegistry());
  assert.equal(process.env.HARVEST_OPINION_MODEL, "deepseek-chat");

  // Unknown model -> report missing, env restored.
  setLaneSelection(cwd, "opinion", { provider: "ghost", modelId: "nope" });
  const missing = await applyLaneSelections(cwd, fakeRegistry());
  assert.equal(missing.find((r) => r.lane === "opinion")?.status, "missing");
  assert.equal(process.env.HARVEST_OPINION_MODEL, "env-opinion-model");

  // Cleared selection -> env stays restored.
  setLaneSelection(cwd, "opinion", undefined);
  await applyLaneSelections(cwd, fakeRegistry());
  assert.equal(process.env.HARVEST_OPINION_MODEL, "env-opinion-model");

  // Auth resolution failure -> failed + restore.
  setLaneSelection(cwd, "opinion", { provider: "deepseek", modelId: "deepseek-chat" });
  const badRegistry = { find: fakeRegistry().find, getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) };
  const failed = await applyLaneSelections(cwd, badRegistry);
  assert.equal(failed.find((r) => r.lane === "opinion")?.status, "failed");
  assert.equal(process.env.HARVEST_OPINION_MODEL, "env-opinion-model");
 } finally {
  restoreEnv(snap);
  resetLaneEnvSnapshots();
  fs.rmSync(cwd, { recursive: true, force: true });
 }
});

test("restoreLaneEnv is a no-op when the lane was never overridden", () => {
 const snap = snapshotEnv();
 resetLaneEnvSnapshots();
 try {
  assert.equal(restoreLaneEnv("verifier"), false);
  assert.equal(restoreLaneEnv("distiller"), false);
  assert.equal(restoreLaneEnv("reviewer"), false);
  assert.equal(restoreLaneEnv("opinion"), false);
 } finally {
  restoreEnv(snap);
  resetLaneEnvSnapshots();
 }
});

test("searchableSelect falls back to flat select outside TUI mode", async () => {
 let selectTitle = "";
 let selectOptions: string[] = [];
 const ctx = {
  mode: "rpc",
  ui: {
   select: async (title: string, options: string[]) => {
    selectTitle = title;
    selectOptions = options;
    return options[1];
   },
   custom: async () => {
    throw new Error("custom must not be used headless");
   },
  },
 };
 const picked = await searchableSelect(ctx, {
  title: "Pick",
  items: [
   { value: "a/1", label: "a/1" },
   { value: "b/2", label: "b/2" },
  ],
 });
 assert.equal(selectTitle, "Pick");
 assert.deepEqual(selectOptions, ["a/1", "b/2"]);
 assert.equal(picked?.value, "b/2");

 const cancelled = await searchableSelect(
  { mode: "print", ui: { select: async () => undefined, custom: async () => undefined } },
  { title: "Pick", items: [{ value: "a/1", label: "a/1" }] },
 );
 assert.equal(cancelled, undefined);
});

test("pickLaneModel filters to chat models with auth and maps the choice back", async () => {
 let selectTitle = "";
 const catalog = {
  getModelsOfType: () => [
   { id: "deepseek-chat", provider: "deepseek", api: "openai-completions" },
   { id: "dall-e-3", provider: "openai", type: "image" },
   { id: "deepseek/deepseek-chat", provider: "openrouter", api: "openai-completions" },
  ],
  hasConfiguredAuth: () => true,
 };
 const ctx = {
  mode: "print",
  ui: {
   select: async (title: string, options: string[]) => {
    selectTitle = title;
    assert.deepEqual(options, ["deepseek/deepseek-chat", "openrouter/deepseek/deepseek-chat"]);
    return "deepseek/deepseek-chat";
   },
   custom: async () => undefined,
  },
 };
 const choice = await pickLaneModel(ctx, catalog, "verifier", { openAiCompatibleOnly: true });
 assert.equal(choice?.provider, "deepseek");
 assert.equal(choice?.modelId, "deepseek-chat");
 assert.ok(selectTitle.includes("verifier"));
});

test("pickLaneModel excludes native anthropic models in OpenAI-compatible mode", async () => {
 let seenOptions: string[] = [];
 const catalog = {
  getModelsOfType: () => [
   { id: "claude-opus-5-5", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1" },
   { id: "moonshot/kimi-k3", provider: "openrouter", api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
   { id: "deepseek-chat", provider: "deepseek", api: "openai-completions", baseUrl: "https://api.deepseek.com/v1" },
  ],
  hasConfiguredAuth: () => true,
 };
 const ctx = {
  mode: "print",
  ui: {
   select: async (_title: string, options: string[]) => {
    seenOptions = options;
    return options[0];
   },
   custom: async () => undefined,
  },
 };
 const choice = await pickLaneModel(ctx, catalog, "distiller", { openAiCompatibleOnly: true });
 // The native anthropic-messages model is excluded; OpenRouter models stay.
 assert.deepEqual(seenOptions, ["deepseek/deepseek-chat", "openrouter/moonshot/kimi-k3"]);
 assert.equal(choice?.provider, "deepseek");
});

test("pickLaneModel returns undefined on empty catalogue or cancel", async () => {
 const empty = await pickLaneModel(
  { mode: "print", ui: { select: async () => "x", custom: async () => undefined } },
  { getAvailable: () => [] },
  "reviewer",
 );
 assert.equal(empty, undefined);
 const cancelled = await pickLaneModel(
  {
   mode: "print",
   ui: {
    select: async (_t: string, options: string[]) => (options.length > 0 ? undefined : "x"),
    custom: async () => undefined,
   },
  },
  { getAvailable: () => [{ id: "m", provider: "p" }] },
  "reviewer",
 );
 assert.equal(cancelled, undefined);
});
