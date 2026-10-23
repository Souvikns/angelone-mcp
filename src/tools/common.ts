import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const PROGRESS_EVERY_MS = 15_000;

export const exchange = z.enum(["NSE", "BSE", "NFO", "BFO", "MCX", "CDS", "NCDEX"]);
export const transactionType = z.enum(["BUY", "SELL"]);
export const productType = z.enum(["DELIVERY", "CARRYFORWARD", "MARGIN", "INTRADAY", "BO"]);
export const orderType = z.enum(["MARKET", "LIMIT", "STOPLOSS_LIMIT", "STOPLOSS_MARKET"]);
export const variety = z.enum(["NORMAL", "STOPLOSS", "AMO", "ROBO"]);

export const READ = { readOnlyHint: true, openWorldHint: true } as const;

export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data ?? null, null, 2) }] };
}

export function fail(e: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
}

/** Runs a tool body, turning its result or error into an MCP tool result. */
export async function run(fn: () => Promise<unknown>) {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

export const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  (args: A) =>
    run(() => fn(args));

export interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: ServerNotification) => Promise<void>;
}

/** Awaits `work`, sending MCP progress notifications so clients don't time out. */
export async function withProgress<T>(work: Promise<T>, totalMs: number, extra: ProgressExtra, message: string): Promise<T> {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return work;
  const started = Date.now();
  const timer = setInterval(() => {
    const progress = Math.round(Math.min(totalMs, Date.now() - started) / 1000);
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress, total: Math.round(totalMs / 1000), message },
      })
      .catch(() => {});
  }, PROGRESS_EVERY_MS);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}
