import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { OrderFeed } from "../feed/orders.ts";
import { Mode, type Exchange } from "../feed/protocol.ts";
import type { SmartApi } from "../smartapi.ts";
import type { BaselineFetcher, BaselineQuote, WatchManager } from "../watch.ts";
import { exchange, READ, run, wrap } from "./common.ts";

const PROGRESS_EVERY_MS = 15_000;
const QUOTE_BATCH = 50;

interface ProgressExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (n: ServerNotification) => Promise<void>;
}

/** Awaits `work`, sending MCP progress notifications so clients don't time out. */
async function withProgress<T>(work: Promise<T>, totalMs: number, extra: ProgressExtra, message: string): Promise<T> {
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

interface QuoteRow {
  exchange: Exchange;
  tradingSymbol: string;
  symbolToken: string;
  ltp: number;
  close?: number;
}

/** Baseline prices and trading symbols via the REST quote API, 50 per call. */
export function quoteBaseline(api: SmartApi): BaselineFetcher {
  return async (symbols) => {
    const out: BaselineQuote[] = [];
    for (let i = 0; i < symbols.length; i += QUOTE_BATCH) {
      const exchangeTokens: Partial<Record<Exchange, string[]>> = {};
      for (const s of symbols.slice(i, i + QUOTE_BATCH)) (exchangeTokens[s.exchange] ??= []).push(s.token);
      const r = await api.post<{ fetched?: QuoteRow[] }>("/rest/secure/angelbroking/market/v1/quote", {
        mode: "OHLC",
        exchangeTokens,
      });
      for (const q of r?.fetched ?? []) {
        out.push({
          exchange: q.exchange,
          token: q.symbolToken,
          tradingsymbol: q.tradingSymbol,
          ltp: q.ltp,
          close: q.close ?? null,
        });
      }
    }
    return out;
  };
}

export function registerStreamTools(server: McpServer, deps: { watches: WatchManager; orders: OrderFeed }) {
  const { watches, orders } = deps;

  server.registerTool(
    "start_watch",
    {
      description:
        "Start streaming live ticks for up to 1000 instruments and accumulate per-symbol momentum stats in the background. Returns a watch_id immediately; read results with get_watch_summary (pass wait_seconds, e.g. 300, to let a 5-minute window build). Get symboltokens from search_scrip first. Max 5 watches at once; unread watches stop after 30 minutes.",
      inputSchema: {
        symbols: z.array(z.object({ exchange, symboltoken: z.string() })).min(1).max(1000),
        mode: z
          .enum(["QUOTE", "LTP"])
          .default("QUOTE")
          .describe("QUOTE adds volume and buy/sell quantities, needed for VWAP, volume and pressure metrics"),
        label: z.string().max(60).optional(),
      },
      annotations: READ,
    },
    wrap(({ symbols, mode, label }) =>
      watches.start(
        symbols.map((s) => ({ exchange: s.exchange, token: s.symboltoken })),
        mode === "LTP" ? Mode.LTP : Mode.QUOTE,
        label,
      ),
    ),
  );

  server.registerTool(
    "get_watch_summary",
    {
      description:
        "Per-symbol momentum summary for a watch: % change over the window and day, last price vs window VWAP, window volume and volume/min, buy/sell quantity ratio, uptick ratio, window high/low. wait_seconds waits until that many seconds after the watch started before summarising.",
      inputSchema: {
        watch_id: z.string(),
        wait_seconds: z.number().int().min(0).max(600).default(0),
        sort_by: z.enum(["change", "volume", "vs_vwap", "buy_sell_ratio"]).default("change"),
        limit: z.number().int().positive().optional(),
      },
      annotations: READ,
    },
    ({ watch_id, wait_seconds, sort_by, limit }, extra) =>
      run(async () => {
        const remaining = watches.startedAt(watch_id) + wait_seconds * 1000 - Date.now();
        if (remaining > 0) await withProgress(Bun.sleep(remaining), remaining, extra, `watching ${watch_id}`);
        return watches.summary(watch_id, { sortBy: sort_by, limit });
      }),
  );

  server.registerTool(
    "stop_watch",
    { description: "Stop a watch and release its live subscriptions.", inputSchema: { watch_id: z.string() }, annotations: READ },
    wrap(async ({ watch_id }) => {
      watches.stop(watch_id);
      return { stopped: true };
    }),
  );

  server.registerTool(
    "list_watches",
    { description: "List active watches.", annotations: READ },
    wrap(async () => watches.list()),
  );

  server.registerTool(
    "get_order_updates",
    {
      description:
        "Live status changes for your own orders (placed, modified, filled, rejected, cancelled). The first call connects the order feed; only events after that are captured. Pass next_since from the previous call to get only new events; wait_seconds waits for the next event.",
      inputSchema: {
        since: z.number().int().min(0).optional(),
        wait_seconds: z.number().int().min(0).max(300).default(0),
      },
      annotations: READ,
    },
    ({ since, wait_seconds }, extra) =>
      run(async () => {
        orders.start();
        const from = since ?? 0;
        if (wait_seconds > 0) {
          await withProgress(orders.waitForEvent(from, wait_seconds * 1000), wait_seconds * 1000, extra, "waiting for order updates");
        }
        return { events: orders.after(from), next_since: orders.latestSeq(), feed_status: orders.status() };
      }),
  );
}
