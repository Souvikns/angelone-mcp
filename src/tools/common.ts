import { z } from "zod";

export const exchange = z.enum(["NSE", "BSE", "NFO", "BFO", "MCX", "CDS", "NCDEX"]);
export const transactionType = z.enum(["BUY", "SELL"]);
export const productType = z.enum(["DELIVERY", "CARRYFORWARD", "MARGIN", "INTRADAY", "BO"]);
export const orderType = z.enum(["MARKET", "LIMIT", "STOPLOSS_LIMIT", "STOPLOSS_MARKET"]);
export const variety = z.enum(["NORMAL", "STOPLOSS", "AMO", "ROBO"]);

export const READ = { readOnlyHint: true, openWorldHint: true } as const;
export const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

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
