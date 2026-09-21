/**
 * Telemetry aggregation (Phase 4).
 *
 * Streams the current month's .jsonl sink and tallies `k3_audit.flaw_category`
 * counts. Returns the top-N most frequent categories so the user's
 * `/harvest status` can highlight recurring architectural mistakes.
 *
 * Streams line-by-line via readline so 200MB+ files never load into RAM.
 */

import { createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";

import { currentSinkPath } from "./sink.js";

export interface FlawCount {
 flaw_category: string;
 count: number;
}

export interface TelemetrySummary {
 sinkPath: string;
 recordCount: number;
 topFlaws: FlawCount[];
 totalFlaws: number;
 uniqueCategories: number;
}

/**
 * Stream-read the active month's sink and tally `k3_audit.flaw_category`.
 *
 * @param cwd - workspace root
 * @param topN - number of top flaws to return (default 3 per spec)
 */
export async function aggregateTelemetry(cwd: string, topN: number = 3): Promise<TelemetrySummary> {
 const sinkPath = currentSinkPath(cwd);
 const empty: TelemetrySummary = {
 sinkPath,
 recordCount: 0,
 topFlaws: [],
 totalFlaws: 0,
 uniqueCategories: 0,
 };

 if (!existsSync(sinkPath)) return empty;

 const counts = new Map<string, number>();
 let recordCount = 0;

 const rl = createInterface({
 input: createReadStream(sinkPath, { encoding: "utf8" }),
 crlfDelay: Infinity,
 });

 rl.on("line", (line) => {
 const trimmed = line.trim();
 if (!trimmed) return;
 let parsed: any;
 try {
 parsed = JSON.parse(trimmed);
 } catch {
 return; // skip malformed lines silently
 }
 recordCount++;
 const cat = parsed?.k3_audit?.flaw_category;
 if (typeof cat === "string" && cat.length > 0) {
 counts.set(cat, (counts.get(cat) ?? 0) + 1);
 }
 });

 await new Promise<void>((resolve, reject) => {
 rl.on("close", () => resolve());
 rl.on("error", reject);
 });

 const sorted = Array.from(counts.entries())
 .map(([flaw_category, count]) => ({ flaw_category, count }))
 .sort((a, b) => b.count - a.count || a.flaw_category.localeCompare(b.flaw_category));

 const totalFlaws = sorted.reduce((acc, x) => acc + x.count, 0);

 return {
 sinkPath,
 recordCount,
 topFlaws: sorted.slice(0, topN),
 totalFlaws,
 uniqueCategories: counts.size,
 };
}

/**
 * Format the telemetry summary for the TUI notify panel.
 */
export function formatTelemetryForNotify(summary: TelemetrySummary): string {
 const lines: string[] = [];
 lines.push("[Harvest Telemetry] Active Sink: " + summary.sinkPath + " (" + summary.recordCount + " records)");
 if (summary.topFlaws.length === 0) {
 lines.push(" Top Flaws: (none recorded yet)");
 } else {
 lines.push(" Top Flaws:");
 for (let i = 0; i < summary.topFlaws.length; i++) {
 const f = summary.topFlaws[i];
 lines.push("  " + (i + 1) + ". " + f.flaw_category + " (" + f.count + ")");
 }
 }
 return lines.join("\n");
}
