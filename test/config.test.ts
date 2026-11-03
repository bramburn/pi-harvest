/**
 * Unit tests for the persistent settings store + supervisor resolver.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as config from "../dist/config.js";

const ENV_KEYS = [
 "VERIFIER_BASE_URL",
 "VERIFIER_API_KEY",
 "VERIFIER_MODEL",
 "VERIFIER_PROVIDER",
 "HARVEST_TIMEOUT_MS",
 "HARVEST_MAX_RETRIES",
 "DEEPSEEK_API_KEY",
 "MOONSHOT_API_KEY",
 "OPENROUTER_API_KEY",
 "DASHSCOPE_API_KEY",
 "OPENAI_API_KEY",
 "MINIMAX_API_KEY",
 "QWEN_TOKEN_PLAN",
] as const;

const savedEnv: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) savedEnv[key] = process.env[key];

async function freshRoot(): Promise<string> {
 const dir = await mkdtemp(join(tmpdir(), "pi-harvest-config-"));
 process.env.PI_HARVEST_ROOT = join(dir, ".pi", "harvest");
 for (const key of ENV_KEYS) delete process.env[key];
 return dir;
}

process.on("exit", () => {
 for (const key of ENV_KEYS) {
 if (savedEnv[key] === undefined) delete process.env[key];
 else process.env[key] = savedEnv[key];
 }
});

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

test("loadSettings: returns {} when settings.json does not exist", async () => {
 const dir = await freshRoot();
 try {
 assert.deepEqual(config.loadSettings(), {});
 } finally {
 await rm(dir, { recursive: true, force: true });
 }
});

test("saveSettings: writes a merged, timestamped settings.json", async () => {
 const dir = await freshRoot();
 try {
 config.saveSettings({ supervisorProvider: "deepseek", supervisorModelId: "deepseek-chat" });
 const loaded = config.loadSettings();
 assert.equal(loaded.supervisorProvider, "deepseek");
 assert.equal(loaded.supervisorModelId, "deepseek-chat");
 assert.ok(typeof loaded.updatedAt === "string" && loaded.updatedAt.length > 0);

 // Merge, don't clobber.
 config.saveSettings({ supervisorBaseUrl: "https://example.test/v1" });
 const merged = config.loadSettings();
 assert.equal(merged.supervisorModelId, "deepseek-chat");
 assert.equal(merged.supervisorBaseUrl, "https://example.test/v1");

 const raw = await readFile(config.getSettingsPath(), "utf8");
 const parsed = JSON.parse(raw);
 assert.equal(parsed.supervisorModelId, "deepseek-chat");
 } finally {
 await rm(dir, { recursive: true, force: true });
 }
});

test("loadSettings: tolerates a corrupt settings.json", async () => {
 const dir = await freshRoot();
 try {
 const { mkdir, writeFile } = await import("node:fs/promises");
 const { dirname } = await import("node:path");
 await mkdir(dirname(config.getSettingsPath()), { recursive: true });
 await writeFile(config.getSettingsPath(), "{not json", "utf8");
 assert.deepEqual(config.loadSettings(), {});
 } finally {
 await rm(dir, { recursive: true, force: true });
 }
});

// ---------------------------------------------------------------------------
// identity + full config
// ---------------------------------------------------------------------------

test("resolveSupervisorIdentity: settings win over env", async () => {
 const dir = await freshRoot();
 try {
 process.env.VERIFIER_PROVIDER = "openrouter";
 process.env.VERIFIER_MODEL = "qwen/qwen3-coder";
 config.saveSettings({ supervisorProvider: "deepseek", supervisorModelId: "deepseek-chat" });
 const id = config.resolveSupervisorIdentity();
 assert.equal(id.provider, "deepseek");
 assert.equal(id.model, "deepseek-chat");
 assert.equal(id.source, "settings.json");
 } finally {
 await rm(dir, { recursive: true, force: true });
 }
});

test("resolveSupervisorIdentity: infers provider from a provider/model id", async () => {
 const dir = await freshRoot();
 try {
 process.env.VERIFIER_MODEL = "moonshot/kimi-k2-0711-preview";
 const id = config.resolveSupervisorIdentity();
 assert.equal(id.provider, "moonshot");
 assert.equal(id.model, "kimi-k2-0711-preview");
 assert.equal(id.source, "env");
 } finally {
 await rm(dir, { recursive: true, force: true });
 }
});

test("resolveSupervisorConfig: uses settings.json values", async () => {
 const dir = await freshRoot();
 try {
 config.saveSettings({
 supervisorProvider: "deepseek",
 supervisorModelId: "deepseek-chat",
 supervisorBaseUrl: "https://api.deepseek.com/v1/chat/completions/",
 supervisorApiKey: "sk-settings",
 });
 const cfg = await config.resolveSupervisorConfig();
 assert.equal(cfg.baseUrl, "https://api.deepseek.com/v1");
 assert.equal(cfg.apiKey, "sk-settings");
 assert.equal(cfg.model, "deepseek-chat");
 assert.equal(cfg.provider, "deepseek");
 assert.equal(cfg.timeoutMs, 300000);
 assert.equal(cfg.retries, 2);
 } finally {
 await rm(dir, { recursive: true, force: true });
 }
});

test("resolveSupervisorConfig: falls back to provider defaults + provider env key", async () => {
 const dir = await freshRoot();
 try {
 config.saveSettings({ supervisorProvider: "deepseek", supervisorModelId: "deepseek-reasoner" });
 process.env.DEEPSEEK_API_KEY = "sk-deepseek";
 const cfg = await config.resolveSupervisorConfig();
 assert.equal(cfg.baseUrl, "https://api.deepseek.com/v1");
 assert.equal(cfg.apiKey, "sk-deepseek");
 } finally {
 await rm(dir, { recursive: true, force: true });
 }
});

test("resolveSupervisorConfig: VERIFIER_* env is honoured without settings", async () => {
 const dir = await freshRoot();
 try {
 process.env.VERIFIER_PROVIDER = "deepseek";
 process.env.VERIFIER_MODEL = "deepseek-chat";
 process.env.VERIFIER_BASE_URL = "https://env.example/v1/";
 process.env.VERIFIER_API_KEY = "sk-env";
 process.env.HARVEST_TIMEOUT_MS = "1234";
 process.env.HARVEST_MAX_RETRIES = "5";
 const cfg = await config.resolveSupervisorConfig();
 assert.equal(cfg.baseUrl, "https://env.example/v1");
 assert.equal(cfg.apiKey, "sk-env");
 assert.equal(cfg.timeoutMs, 1234);
 assert.equal(cfg.retries, 5);
 } finally {
 await rm(dir, { recursive: true, force: true });
 }
});

test("resolveSupervisorConfig: throws VerifierConfigError naming every missing value", async () => {
 const dir = await freshRoot();
 try {
 await assert.rejects(
 () => config.resolveSupervisorConfig(),
 (err: unknown) => {
 if (!(err instanceof Error) || err.name !== "VerifierConfigError") return false;
 const msg = err.message;
 return /VERIFIER_BASE_URL/.test(msg) && /VERIFIER_API_KEY/.test(msg) && /VERIFIER_MODEL/.test(msg);
 },
 );
 } finally {
 await rm(dir, { recursive: true, force: true });
 }
});

test("resolveSupervisorConfig: prefers the model registry over env for baseUrl and apiKey", async () => {
 const dir = await freshRoot();
 try {
 config.saveSettings({ supervisorProvider: "openrouter", supervisorModelId: "qwen/qwen3-coder" });
 delete process.env.VERIFIER_BASE_URL;
 const ctx = {
 modelRegistry: {
 find: (provider: string, id: string) =>
 provider === "openrouter" && id === "qwen/qwen3-coder"
 ? { provider, id, baseUrl: "https://openrouter.ai/api/v1" }
 : undefined,
 getApiKeyForProvider: (provider: string) => (provider === "openrouter" ? "sk-registry" : undefined),
 },
 };
 const cfg = await config.resolveSupervisorConfig(ctx);
 assert.equal(cfg.baseUrl, "https://openrouter.ai/api/v1");
 assert.equal(cfg.apiKey, "sk-registry");
 } finally {
 await rm(dir, { recursive: true, force: true });
 }
});

test("resolveSupervisorConfig: extracts the api key from getApiKeyAndHeaders", async () => {
 const dir = await freshRoot();
 try {
 config.saveSettings({ supervisorProvider: "moonshot", supervisorModelId: "kimi-k2-0711-preview" });
 const ctx = {
 modelRegistry: {
 find: () => ({ provider: "moonshot", id: "kimi-k2-0711-preview", baseUrl: "https://api.moonshot.cn/v1" }),
 getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "sk-headers" }),
 },
 };
 const cfg = await config.resolveSupervisorConfig(ctx);
 assert.equal(cfg.apiKey, "sk-headers");
 } finally {
 await rm(dir, { recursive: true, force: true });
 }
});

// ---------------------------------------------------------------------------
// registry enumeration (used by /harvest-settings)
// ---------------------------------------------------------------------------

test("listRegistryModels: dedupes, sorts and skips malformed entries", () => {
 const ctx = {
 modelRegistry: {
 getAvailable: () => [
 { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
 { provider: "deepseek", id: "deepseek-chat" },
 { provider: "alibaba", id: "qwen3-coder-plus", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
 { provider: "", id: "orphan" },
 null,
 ],
 },
 };
 const models = config.listRegistryModels(ctx);
 assert.deepEqual(
 models.map((m) => m.label),
 ["alibaba/qwen3-coder-plus", "deepseek/deepseek-chat"],
 );
 assert.equal(models[1].name, "DeepSeek Chat");
 assert.equal(models[0].baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
});

test("listRegistryModels: returns [] for a missing/odd context", () => {
 assert.deepEqual(config.listRegistryModels(undefined), []);
 assert.deepEqual(config.listRegistryModels({ modelRegistry: {} }), []);
});

test("providerDefaultBaseUrl: knows the documented providers only", () => {
 assert.equal(config.providerDefaultBaseUrl("deepseek"), "https://api.deepseek.com/v1");
 assert.equal(config.providerDefaultBaseUrl("openrouter"), "https://openrouter.ai/api/v1");
 assert.equal(config.providerDefaultBaseUrl("k3"), undefined);
});