/**
 * Persistent harvest settings + supervisor resolution.
 *
 * Historically the verifier/commander was configured exclusively via
 * `VERIFIER_BASE_URL` / `VERIFIER_API_KEY` / `VERIFIER_MODEL` env vars.
 * That is hostile to interactive use: every model swap requires editing
 * a shell profile and restarting pi.
 *
 * This module adds `<harvestRoot>/settings.json`, written by the
 * `/harvest-settings` slash command, and a single resolver
 * (`resolveSupervisorConfig`) that both the interactive command and the
 * background verifier calls use:
 *
 *   1. `<harvestRoot>/settings.json` (explicit user choice)
 *   2. pi's live `ctx.modelRegistry` (baseUrl + provider credentials)
 *   3. `VERIFIER_*` env vars (legacy / CI)
 *   4. well-known provider defaults + provider-scoped env keys
 *      (`DEEPSEEK_API_KEY`, `MOONSHOT_API_KEY`, ...)
 *
 * Anything still missing after that throws `VerifierConfigError`, whose
 * message names the exact env-var style key that is absent so existing
 * callers/tests keep working.
 *
 * SECURITY: `settings.json` may contain an API key. It lives in the
 * user's own pi directory (not the repo), is written 0600 where the
 * platform supports it, and is never logged by this module.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ensureHarvestRoot } from "./paths.js";
import { VerifierConfigError } from "./types.js";

export interface HarvestSettings {
 supervisorProvider?: string;
 supervisorModelId?: string;
 supervisorBaseUrl?: string;
 supervisorApiKey?: string;
 updatedAt?: string;
}

export interface SupervisorConfig {
 baseUrl: string;
 apiKey: string;
 model: string;
 provider: string;
 timeoutMs: number;
 retries: number;
}

/** Where the resolved supervisor config came from (for /harvest status). */
export type SupervisorSource = "settings.json" | "env" | "modelRegistry" | "defaults" | "unset";

export interface SupervisorIdentity {
 provider: string;
 model: string;
 source: SupervisorSource;
}

/**
 * Well-known OpenAI-compatible provider defaults.
 *
 * Only used as the LAST resort for baseUrl/apiKey. The `k3` label (the
 * historical default provider tag) deliberately has no default baseUrl —
 * K3/Moonshot endpoints vary by deployment, so it must be configured
 * explicitly (or come from the model registry).
 */
const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; envKey: string }> = {
 deepseek: { baseUrl: "https://api.deepseek.com/v1", envKey: "DEEPSEEK_API_KEY" },
 moonshot: { baseUrl: "https://api.moonshot.cn/v1", envKey: "MOONSHOT_API_KEY" },
 kimi: { baseUrl: "https://api.moonshot.cn/v1", envKey: "MOONSHOT_API_KEY" },
 openrouter: { baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY" },
 alibaba: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", envKey: "DASHSCOPE_API_KEY" },
 dashscope: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", envKey: "DASHSCOPE_API_KEY" },
 qwen: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", envKey: "DASHSCOPE_API_KEY" },
 "qwen-token": {
 baseUrl: "https://token-plan.maas.qwencloudapi.com/compatible-mode/v1",
 envKey: "QWEN_TOKEN_PLAN",
 },
 openai: { baseUrl: "https://api.openai.com/v1", envKey: "OPENAI_API_KEY" },
 anthropic: { baseUrl: "https://api.anthropic.com/v1", envKey: "ANTHROPIC_API_KEY" },
 minimax: { baseUrl: "https://api.minimax.chat/v1", envKey: "MINIMAX_API_KEY" },
};

// ---------------------------------------------------------------------------
// Loose ctx shape (pi's ModelRegistry is not a build dependency here)
// ---------------------------------------------------------------------------

interface RegistryModelLike {
 id?: string;
 name?: string;
 provider?: string;
 baseUrl?: string;
 [k: string]: unknown;
}

interface ModelRegistryLike {
 getAvailable?(): RegistryModelLike[];
 getAll?(): RegistryModelLike[];
 find?(provider: string, modelId: string): RegistryModelLike | undefined;
 getProvider?(provider: string): { baseUrl?: string } | undefined;
 getApiKeyForProvider?(provider: string): Promise<string | undefined> | string | undefined;
 getApiKeyAndHeaders?(
 model: RegistryModelLike,
 ): Promise<{ ok?: boolean; apiKey?: string; baseUrl?: string } | undefined>;
 models?: RegistryModelLike[];
 [k: string]: unknown;
}

interface LooseContext {
 modelRegistry?: ModelRegistryLike;
 authStorage?: {
 getApiKey?(provider: string): Promise<string | undefined> | string | undefined;
 [k: string]: unknown;
 };
 [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// settings.json
// ---------------------------------------------------------------------------

export function getSettingsPath(): string {
 return join(ensureHarvestRoot(), "settings.json");
}

/**
 * Read `<harvestRoot>/settings.json`. Returns `{}` when the file is
 * missing or malformed — a corrupt settings file must never block the
 * extension from starting.
 */
export function loadSettings(): HarvestSettings {
 const p = getSettingsPath();
 if (!existsSync(p)) return {};
 try {
 const parsed: unknown = JSON.parse(readFileSync(p, "utf8"));
 if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
 return parsed as HarvestSettings;
 } catch {
 return {};
 }
}

/**
 * Merge `patch` into the existing settings, stamp `updatedAt`, and write
 * atomically (tmp file + rename) with 0600 permissions where supported.
 */
export function saveSettings(patch: Partial<HarvestSettings>): HarvestSettings {
 const current = loadSettings();
 const next: HarvestSettings = {
 ...current,
 ...patch,
 updatedAt: new Date().toISOString(),
 };
 const target = getSettingsPath();
 const tmp = target + ".tmp-" + process.pid;
 const body = JSON.stringify(next, null, 2) + "\n";
 try {
 writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
 renameSync(tmp, target);
 } catch {
 // Fall back to a direct write if rename is blocked (e.g. a virus
 // scanner holding the tmp file on Windows).
 writeFileSync(target, body, { encoding: "utf8" });
 }
 return next;
}

// ---------------------------------------------------------------------------
// Model registry helpers (used by /harvest-settings)
// ---------------------------------------------------------------------------

export interface SupervisorModelOption {
 /** Stable UI key: `<provider>/<modelId>`. */
 label: string;
 provider: string;
 id: string;
 /** Registry-provided base URL, when the model entry carries one. */
 baseUrl?: string;
 /** Display name, when it differs from the id. */
 name?: string;
}

function asLooseContext(ctx: unknown): LooseContext | undefined {
 if (!ctx || typeof ctx !== "object") return undefined;
 return ctx as LooseContext;
}

/** Enumerate every model pi's registry knows about (deduped, stable order). */
export function listRegistryModels(ctx?: unknown): SupervisorModelOption[] {
 const c = asLooseContext(ctx);
 const reg = c?.modelRegistry;
 if (!reg) return [];

 let raw: RegistryModelLike[] = [];
 try {
 if (typeof reg.getAvailable === "function") raw = reg.getAvailable() ?? [];
 else if (typeof reg.getAll === "function") raw = reg.getAll() ?? [];
 else if (Array.isArray(reg.models)) raw = reg.models;
 } catch {
 return [];
 }

 const seen = new Set<string>();
 const out: SupervisorModelOption[] = [];
 for (const m of raw) {
 if (!m || typeof m !== "object") continue;
 const provider = typeof m.provider === "string" && m.provider.length > 0 ? m.provider : "";
 const id = typeof m.id === "string" && m.id.length > 0 ? m.id : typeof m.name === "string" ? m.name : "";
 if (!provider || !id) continue;
 const label = provider + "/" + id;
 if (seen.has(label)) continue;
 seen.add(label);
 out.push({
 label,
 provider,
 id,
 ...(typeof m.baseUrl === "string" && m.baseUrl.length > 0 ? { baseUrl: m.baseUrl } : {}),
 ...(typeof m.name === "string" && m.name.length > 0 && m.name !== id ? { name: m.name } : {}),
 });
 }
 out.sort((a, b) => a.label.localeCompare(b.label));
 return out;
}

/** Resolve a provider's API key from pi's registry (never throws). */
export async function resolveRegistryApiKey(
 ctx: unknown,
 provider: string,
 modelId?: string,
): Promise<string | undefined> {
 const c = asLooseContext(ctx);
 if (!c) return undefined;
 const reg = c.modelRegistry;

 if (reg && modelId) {
 try {
 const model = typeof reg.find === "function" ? reg.find(provider, modelId) : undefined;
 const resolved = model && typeof reg.getApiKeyAndHeaders === "function"
 ? await reg.getApiKeyAndHeaders(model)
 : undefined;
 if (resolved && typeof resolved.apiKey === "string" && resolved.apiKey.length > 0) {
 return resolved.apiKey;
 }
 } catch {
 // fall through
 }
 }

 if (reg && typeof reg.getApiKeyForProvider === "function") {
 try {
 const key = await reg.getApiKeyForProvider(provider);
 if (typeof key === "string" && key.length > 0) return key;
 } catch {
 // fall through
 }
 }

 // Legacy / alternative host shape.
 const auth = c.authStorage;
 if (auth && typeof auth.getApiKey === "function") {
 try {
 const key = await auth.getApiKey(provider);
 if (typeof key === "string" && key.length > 0) return key;
 } catch {
 // ignore
 }
 }
 return undefined;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

function normalizeBaseUrl(raw: string): string {
 return raw
 .trim()
 .replace(/\/+$/, "")
 .replace(/\/chat\/completions$/i, "")
 .replace(/\/+$/, "");
}

function splitProviderModel(raw: string): { provider: string; model: string } | null {
 const slash = raw.indexOf("/");
 if (slash <= 0 || slash >= raw.length - 1) return null;
 /** Only split when the prefix looks like a bare provider token (no `/`). */
 const provider = raw.slice(0, slash);
 if (!/^[A-Za-z0-9._-]+$/.test(provider)) return null;
 return { provider, model: raw.slice(slash + 1) };
}

/**
 * Synchronous identity (provider + model + source). Useful where only a
 * label is needed (`steerProviderTag`, the `verifier_model` field on a
 * harvested record). Never throws.
 */
export function resolveSupervisorIdentity(): SupervisorIdentity {
 const s = loadSettings();
 let provider = (s.supervisorProvider || process.env.VERIFIER_PROVIDER || "").trim();
 let model = (s.supervisorModelId || process.env.VERIFIER_MODEL || "").trim();

 let source: SupervisorSource = "unset";
 if (s.supervisorModelId || s.supervisorProvider) source = "settings.json";
 else if (process.env.VERIFIER_MODEL || process.env.VERIFIER_PROVIDER) source = "env";

 if (model && !provider) {
 const split = splitProviderModel(model);
 if (split) {
 provider = split.provider;
 model = split.model;
 }
 }
 if (model.includes("/") && provider) {
 const prefix = provider + "/";
 if (model.startsWith(prefix)) model = model.slice(prefix.length);
 }
 return {
 provider: (provider || "k3").toLowerCase(),
 model: model || "",
 source,
 };
}

/**
 * Resolve the full supervisor/verifier connection config.
 *
 * Async because pi's model registry exposes credentials through async
 * accessors. Always pass the active `ctx` when you have one so
 * registry-stored keys can be used without duplicating them into
 * settings.json.
 */
export async function resolveSupervisorConfig(ctx?: unknown): Promise<SupervisorConfig> {
 const s = loadSettings();
 const identity = resolveSupervisorIdentity();
 const provider = identity.provider;
 let model = identity.model;
 const defaults = PROVIDER_DEFAULTS[provider];

 // Base URL precedence: settings -> registry -> explicit env -> defaults.
 let baseUrl = "";
 if (typeof s.supervisorBaseUrl === "string" && s.supervisorBaseUrl.trim().length > 0) {
 baseUrl = normalizeBaseUrl(s.supervisorBaseUrl);
 } else {
 const c = asLooseContext(ctx);
 const reg = c?.modelRegistry;
 if (reg) {
 try {
 if (typeof reg.find === "function" && model) {
 const m = reg.find(provider, model);
 if (m && typeof m.baseUrl === "string" && m.baseUrl.length > 0) {
 baseUrl = normalizeBaseUrl(m.baseUrl);
 }
 }
 if (!baseUrl && typeof reg.getProvider === "function") {
 const p = reg.getProvider(provider);
 if (p && typeof p.baseUrl === "string" && p.baseUrl.length > 0) {
 baseUrl = normalizeBaseUrl(p.baseUrl);
 }
 }
 } catch {
 // fall through
 }
 }
 if (!baseUrl && process.env.VERIFIER_BASE_URL) {
 baseUrl = normalizeBaseUrl(process.env.VERIFIER_BASE_URL);
 }
 if (!baseUrl && defaults) {
 baseUrl = normalizeBaseUrl(defaults.baseUrl);
 }
 }

 // API key precedence: settings -> explicit env -> registry -> provider env.
 let apiKey = "";
 if (typeof s.supervisorApiKey === "string" && s.supervisorApiKey.trim().length > 0) {
 apiKey = s.supervisorApiKey.trim();
 } else if (process.env.VERIFIER_API_KEY) {
 apiKey = process.env.VERIFIER_API_KEY.trim();
 } else if (model) {
 const fromRegistry = await resolveRegistryApiKey(ctx, provider, model);
 if (fromRegistry) apiKey = fromRegistry;
 }
 if (!apiKey && defaults?.envKey) {
 const fromProviderEnv = process.env[defaults.envKey];
 if (typeof fromProviderEnv === "string" && fromProviderEnv.trim().length > 0) {
 apiKey = fromProviderEnv.trim();
 }
 }

 // A model id that came from settings as `provider/model` loses the
 // prefix (the verifier API expects the bare id).
 if (model && provider && model.startsWith(provider + "/")) {
 model = model.slice(provider.length + 1);
 }

 const timeoutMs = Number(process.env.HARVEST_TIMEOUT_MS ?? "300000");
 const retries = Number(process.env.HARVEST_MAX_RETRIES ?? "2");

 const missing: string[] = [];
 if (!baseUrl) missing.push("VERIFIER_BASE_URL");
 if (!apiKey) missing.push("VERIFIER_API_KEY");
 if (!model) missing.push("VERIFIER_MODEL");
 if (missing.length > 0) {
 throw new VerifierConfigError(missing);
 }
 if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
 throw new VerifierConfigError(["HARVEST_TIMEOUT_MS (must be a positive number)"]);
 }
 if (!Number.isFinite(retries) || retries < 0) {
 throw new VerifierConfigError(["HARVEST_MAX_RETRIES (must be >= 0)"]);
 }

 return { baseUrl, apiKey, model, provider, timeoutMs, retries };
}

/** Provider defaults, exposed for the interactive command's prompts. */
export function providerDefaultBaseUrl(provider: string): string | undefined {
 return PROVIDER_DEFAULTS[provider.toLowerCase()]?.baseUrl;
}

/** Whether a provider-scoped API key env var is present. */
export function providerEnvKeyPresent(provider: string): boolean {
 const envKey = PROVIDER_DEFAULTS[provider.toLowerCase()]?.envKey;
 if (!envKey) return false;
 const value = process.env[envKey];
 return typeof value === "string" && value.trim().length > 0;
}