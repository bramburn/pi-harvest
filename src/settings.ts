/**
 * Lane model selections — persistence and application for
 * /harvest-settings.
 *
 * Why this exists: configuring VERIFIER_BASE_URL / VERIFIER_API_KEY /
 * VERIFIER_MODEL as system env vars is hostile UX. pi already knows
 * every configured model (providers, models.json, /login credentials)
 * via ctx.modelRegistry, and its TUI already has the searchable /model
 * picker. So instead of asking the user to wire env vars,
 * /harvest-settings lets them pick a model from pi's own catalogue; the
 * selection is stored per project in `.pi/harvest/settings.json` and
 * applied by translating it back into the lane env vars the rest of the
 * extension already reads.
 *
 * Lanes:
 * - verifier (parent lane): the compile-failure auditor. Its env vars
 *   keep the historical VERIFIER_* names — pi-audit-gap and friends fall
 *   back to them, so they are the shared "supervisor endpoint" defaults.
 * - distiller / reviewer / opinion (sub-lanes): thrash compression,
 *   semantic review, architectural opinion. Their env vars are
 *   HARVEST_<LANE>_* and every one of them falls back to the verifier
 *   lane's, so without a pick each sub-lane keeps riding the verifier
 *   model exactly as before.
 *
 * Precedence: a stored selection overrides env for its lane; clearing
 * the selection restores the env values captured before the first
 * override. Auth (API key + base URL) is resolved through pi's
 * ModelRegistry at apply time, so OAuth-backed and models.json providers
 * work without storing secrets in the settings file — only
 * { provider, modelId } is persisted.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Lane } from "./verifier.js";

// ---------------------------------------------------------------------------
// Settings file
// ---------------------------------------------------------------------------

export interface LaneModelSelection {
 provider: string;
 modelId: string;
 /** [STEER:*] provider tag; defaults to a sanitized uppercase provider name. */
 tag?: string;
}

export interface HarvestSettings {
 version: 1;
 updatedAt: string;
 verifier?: LaneModelSelection;
 distiller?: LaneModelSelection;
 reviewer?: LaneModelSelection;
 opinion?: LaneModelSelection;
}

export function settingsPath(cwd: string): string {
 return path.join(cwd, ".pi", "harvest", "settings.json");
}

function atomicWriteJson(filePath: string, value: unknown): void {
 fs.mkdirSync(path.dirname(filePath), { recursive: true });
 const tmp = filePath + ".tmp-" + process.pid;
 fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
 fs.renameSync(tmp, filePath);
}

export function loadSettings(cwd: string): HarvestSettings | null {
 let parsed: unknown;
 try {
  parsed = JSON.parse(fs.readFileSync(settingsPath(cwd), "utf8"));
 } catch {
  return null;
 }
 if (!parsed || typeof parsed !== "object") return null;
 const obj = parsed as Record<string, unknown>;
 if (obj.version !== 1) return null;
 const settings: HarvestSettings = {
  version: 1,
  updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : "",
 };
 for (const lane of ["verifier", "distiller", "reviewer", "opinion"] as const) {
  const sel = obj[lane];
  if (!sel || typeof sel !== "object") continue;
  const s = sel as Record<string, unknown>;
  if (typeof s.provider !== "string" || !s.provider) continue;
  if (typeof s.modelId !== "string" || !s.modelId) continue;
  settings[lane] = {
   provider: s.provider,
   modelId: s.modelId,
   ...(typeof s.tag === "string" && s.tag ? { tag: s.tag } : {}),
  };
 }
 return settings;
}

export function saveSettings(cwd: string, lanes: Partial<HarvestSettings>): HarvestSettings {
 const next: HarvestSettings = {
  version: 1,
  updatedAt: new Date().toISOString(),
  ...(lanes.verifier ? { verifier: lanes.verifier } : {}),
  ...(lanes.distiller ? { distiller: lanes.distiller } : {}),
  ...(lanes.reviewer ? { reviewer: lanes.reviewer } : {}),
  ...(lanes.opinion ? { opinion: lanes.opinion } : {}),
 };
 atomicWriteJson(settingsPath(cwd), next);
 return next;
}

/** Set or clear one lane's selection. Pass undefined to clear. */
export function setLaneSelection(cwd: string, lane: Lane, selection: LaneModelSelection | undefined): HarvestSettings {
 const current = loadSettings(cwd) ?? { version: 1 as const, updatedAt: "" };
 if (selection) {
  current[lane] = selection;
 } else {
  delete current[lane];
 }
 return saveSettings(cwd, current);
}

// ---------------------------------------------------------------------------
// Model registry access (structural — the real pi ModelRegistry is richer)
// ---------------------------------------------------------------------------

export interface ModelRegistryLike {
 find?(provider: string, modelId: string): unknown;
 getApiKeyAndHeaders?(model: unknown): Promise<unknown>;
}

type ParsedAuth =
 | { ok: true; apiKey?: string; baseUrl?: string }
 | { ok: false; error: string };

function parseResolvedAuth(value: unknown): ParsedAuth | null {
 if (!value || typeof value !== "object") return null;
 const obj = value as Record<string, unknown>;
 if (obj.ok !== true) {
  return { ok: false, error: typeof obj.error === "string" ? obj.error : "auth resolution failed" };
 }
 return {
  ok: true,
  apiKey: typeof obj.apiKey === "string" && obj.apiKey ? obj.apiKey : undefined,
  baseUrl: typeof obj.baseUrl === "string" && obj.baseUrl ? obj.baseUrl : undefined,
 };
}

function modelBaseUrl(handle: unknown): string | undefined {
 const baseUrl = (handle as Record<string, unknown> | undefined)?.baseUrl;
 return typeof baseUrl === "string" && baseUrl ? baseUrl : undefined;
}

/** [STEER:*] tag derived from a provider name: "anthropic" -> "ANTHROPIC". */
export function deriveTag(provider: string): string {
 const tag = provider
  .trim()
  .toUpperCase()
  .replace(/[^A-Z0-9_-]/g, "")
  .slice(0, 10);
 return tag.length > 0 ? tag : "LLM";
}

// ---------------------------------------------------------------------------
// Env application
// ---------------------------------------------------------------------------

/** Env prefix per lane. The verifier lane keeps the historical VERIFIER_* names. */
export function laneEnvPrefix(lane: Lane): string {
 return lane === "verifier" ? "VERIFIER" : "HARVEST_" + lane.toUpperCase();
}

const LANE_ENV_KEYS: Record<Lane, string[]> = {
 verifier: ["VERIFIER_BASE_URL", "VERIFIER_API_KEY", "VERIFIER_MODEL", "VERIFIER_PROVIDER"],
 distiller: ["HARVEST_DISTILLER_BASE_URL", "HARVEST_DISTILLER_API_KEY", "HARVEST_DISTILLER_MODEL", "HARVEST_DISTILLER_PROVIDER"],
 reviewer: ["HARVEST_REVIEWER_BASE_URL", "HARVEST_REVIEWER_API_KEY", "HARVEST_REVIEWER_MODEL", "HARVEST_REVIEWER_PROVIDER"],
 opinion: ["HARVEST_OPINION_BASE_URL", "HARVEST_OPINION_API_KEY", "HARVEST_OPINION_MODEL", "HARVEST_OPINION_PROVIDER"],
};

/** Env values captured before the first override, for per-lane restore. */
const originalEnv = new Map<string, string | undefined>();

function rememberOriginal(key: string): void {
 if (!originalEnv.has(key)) originalEnv.set(key, process.env[key]);
}

/** Restore a lane's env vars to the values captured before the first override. */
export function restoreLaneEnv(lane: Lane): boolean {
 const keys = LANE_ENV_KEYS[lane];
 if (!keys.some((k) => originalEnv.has(k))) return false; // never overridden
 for (const key of keys) {
  const original = originalEnv.get(key);
  if (original === undefined) delete process.env[key];
  else process.env[key] = original;
 }
 return true;
}

function applyLaneEnv(lane: Lane, sel: LaneModelSelection, baseUrl: string, apiKey: string): void {
 const prefix = laneEnvPrefix(lane);
 for (const key of LANE_ENV_KEYS[lane]) rememberOriginal(key);
 process.env[prefix + "_BASE_URL"] = baseUrl;
 process.env[prefix + "_API_KEY"] = apiKey;
 process.env[prefix + "_MODEL"] = sel.modelId;
 process.env[prefix + "_PROVIDER"] = sel.tag && sel.tag.trim() ? sel.tag : deriveTag(sel.provider);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type LaneApplyStatus = "applied" | "restored" | "missing" | "failed";

export interface LaneApplyResult {
 lane: Lane;
 status: LaneApplyStatus;
 detail: string;
}

/**
 * Apply stored lane selections to the env vars the rest of the
 * extension reads. Idempotent; safe to call on every session_start.
 * Lanes without a stored selection are left on their env config
 * (restoring any previously overridden values).
 */
export async function applyLaneSelections(cwd: string, registry: ModelRegistryLike | undefined): Promise<LaneApplyResult[]> {
 const settings = loadSettings(cwd);
 const results: LaneApplyResult[] = [];
 for (const lane of ["verifier", "distiller", "reviewer", "opinion"] as const) {
  const sel = settings?.[lane];
  if (!sel) {
   const restored = restoreLaneEnv(lane);
   results.push({
    lane,
    status: "restored",
    detail: restored ? "env config restored" : "no stored selection; env config in effect",
   });
   continue;
  }

  const handle = registry?.find?.(sel.provider, sel.modelId);
  if (!handle) {
   restoreLaneEnv(lane);
   results.push({
    lane,
    status: "missing",
    detail: sel.provider + "/" + sel.modelId + " is not in pi's model catalogue",
   });
   continue;
  }

  let resolved: unknown;
  try {
   resolved = await registry?.getApiKeyAndHeaders?.(handle);
  } catch (err) {
   resolved = { ok: false, error: (err as Error)?.message ?? String(err) };
  }
  const auth = parseResolvedAuth(resolved);
  const baseUrl = (auth && auth.ok ? auth.baseUrl : undefined) ?? modelBaseUrl(handle);
  const apiKey = auth && auth.ok ? auth.apiKey : undefined;
  if (!auth || !auth.ok || !apiKey || !baseUrl) {
   restoreLaneEnv(lane);
   const reason = !auth
    ? "pi did not return an auth resolution"
    : !auth.ok
      ? auth.error
      : !apiKey
        ? "model auth is header/OAuth-only (unsupported by the lane transports)"
        : "could not resolve a base URL for this model";
   results.push({ lane, status: "failed", detail: reason });
   continue;
  }

  applyLaneEnv(lane, sel, baseUrl, apiKey);
  results.push({ lane, status: "applied", detail: sel.provider + "/" + sel.modelId + " @ " + baseUrl });
 }
 return results;
}

/** Test helper: drop captured env snapshots so each test starts clean. */
export function resetLaneEnvSnapshots(): void {
 originalEnv.clear();
}
