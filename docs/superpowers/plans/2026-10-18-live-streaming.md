# Live Streaming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SmartAPI WebSocket market-feed watch sessions (momentum summaries) and an order-update feed to the angelone-mcp stdio server.

**Architecture:** A shared `ManagedConnection` owns socket lifecycle (lazy connect, heartbeat, backoff reconnect, one re-login). `MarketFeed` and `OrderFeed` build on it. `WatchManager` routes decoded ticks into per-symbol accumulators; pure `momentum.ts` turns accumulators into summaries. Five new MCP tools expose it; tools wait with progress notifications.

**Tech Stack:** Bun 1.3 (built-in `WebSocket` with `headers` option, `bun:test`), TypeScript strict, `@modelcontextprotocol/sdk` 1.32, `zod` 4.

**Spec:** `docs/superpowers/specs/2026-10-18-live-streaming-design.md`

## Global Constraints

- Runtime is Bun; no new npm dependencies (use Bun's global `WebSocket`, `DataView`, `bun:test`).
- stdout carries MCP JSON-RPC — all logging goes to stderr (`console.error`).
- Market feed URL `wss://smartapisocket.angelone.in/smart-stream`; order feed URL `wss://tns.angelone.in/smart-order-update`.
- Ping text `ping` every 10s; stale after 20s without any message; reconnect backoff 1s doubling, capped at 30s.
- Limits: 1000 live subscriptions, 5 concurrent watches, watches unread for 30 minutes expire.
- `wait_seconds` max 600 for `get_watch_summary`, 300 for `get_order_updates`; progress notifications every 15s.
- Prices in ticks are paise (÷100); CDS ÷10^7.
- `correlationID` must be ≤10 chars — use `"mcp"`.
- No orders are placed in any test.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File Structure

| File | Responsibility |
|---|---|
| `src/feed/protocol.ts` (new) | Exchange/mode constants, subscribe message builder, binary tick decoder. Pure. |
| `src/feed/connection.ts` (new) | `ManagedConnection`: socket lifecycle, heartbeat, reconnect, re-login, status. Shared types (`FeedSession`, `FeedStatus`, `SocketLike`, `Timers`). |
| `src/feed/fakes.ts` (new) | Test doubles: `FakeTimers`, `FakeSocket`, `socketRecorder`, `flush`. Test-only. |
| `src/feed/market.ts` (new) | `MarketFeed`: ref-counted subscriptions over a `ManagedConnection`, tick fan-out. Defines `FeedLike`, `SymbolRef`. |
| `src/feed/orders.ts` (new) | `OrderFeed`: order events ring buffer + wait. |
| `src/momentum.ts` (new) | Accumulator + summary metrics + sorting. Pure. |
| `src/watch.ts` (new) | `WatchManager`: watches, routing, limits, gaps, idle expiry. |
| `src/tools/common.ts` (new) | `ok`, `fail`, `run`, `wrap`, shared `exchange` zod enum, `READ`/`WRITE` annotations. |
| `src/tools/rest.ts` (moved from `src/tools.ts`) | Existing REST tools, renamed export `registerRestTools`. |
| `src/tools/stream.ts` (new) | Five streaming tools, `quoteBaseline`, progress helper. |
| `src/smartapi.ts` (modify) | Keep `feedToken`; add `session()` / `relogin()`. |
| `index.ts` (modify) | Wire feeds, watch manager, tools, shutdown. |
| `README.md` (modify) | Document streaming tools. |

---

### Task 1: Tick protocol

**Files:**
- Create: `src/feed/protocol.ts`
- Test: `src/feed/protocol.test.ts`

**Interfaces:**
- Produces:
  - `type Exchange = "NSE" | "NFO" | "BSE" | "BFO" | "MCX" | "NCDEX" | "CDS"`
  - `const Mode = { LTP: 1, QUOTE: 2, SNAP_QUOTE: 3 } as const; type Mode = 1 | 2 | 3`
  - `const EXCHANGE_TYPE: Record<Exchange, number>`
  - `interface Tick { exchange: Exchange; token: string; mode: Mode; exchangeTs: number; ltp: number; ltq: number | null; atp: number | null; volume: number | null; buyQty: number | null; sellQty: number | null; open: number | null; high: number | null; low: number | null; close: number | null; oi: number | null }`
  - `decodeTick(input: ArrayBuffer | Uint8Array): Tick | null`
  - `subscribeMessage(action: 0 | 1, mode: Mode, symbols: { exchange: Exchange; token: string }[]): string`

- [ ] **Step 1: Write the failing test**

`src/feed/protocol.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { decodeTick, Mode, subscribeMessage } from "./protocol.ts";

interface PacketFields {
  mode: number;
  exchangeType: number;
  token: string;
  ltp: bigint;
}

// Builds a packet using the byte layout in the spec's offset table.
function packet({ mode, exchangeType, token, ltp }: PacketFields): ArrayBuffer {
  const size = mode === 1 ? 51 : mode === 2 ? 123 : 379;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint8(0, mode);
  v.setUint8(1, exchangeType);
  new Uint8Array(buf).set(new TextEncoder().encode(token), 2);
  v.setBigInt64(27, 7n, true);
  v.setBigInt64(35, 1760000000000n, true);
  v.setBigInt64(43, ltp, true);
  if (mode >= 2) {
    v.setBigInt64(51, 25n, true);
    v.setBigInt64(59, 81234n, true);
    v.setBigInt64(67, 1234567n, true);
    v.setFloat64(75, 5000, true);
    v.setFloat64(83, 2500, true);
    v.setBigInt64(91, 81000n, true);
    v.setBigInt64(99, 82000n, true);
    v.setBigInt64(107, 80500n, true);
    v.setBigInt64(115, 80000n, true);
  }
  if (mode === 3) v.setBigInt64(131, 4500n, true);
  return buf;
}

describe("decodeTick", () => {
  test("LTP packet", () => {
    expect(decodeTick(packet({ mode: 1, exchangeType: 1, token: "3045", ltp: 81250n }))).toEqual({
      exchange: "NSE",
      token: "3045",
      mode: Mode.LTP,
      exchangeTs: 1760000000000,
      ltp: 812.5,
      ltq: null,
      atp: null,
      volume: null,
      buyQty: null,
      sellQty: null,
      open: null,
      high: null,
      low: null,
      close: null,
      oi: null,
    });
  });

  test("Quote packet", () => {
    expect(decodeTick(packet({ mode: 2, exchangeType: 2, token: "49014", ltp: 177370n }))).toEqual({
      exchange: "NFO",
      token: "49014",
      mode: Mode.QUOTE,
      exchangeTs: 1760000000000,
      ltp: 1773.7,
      ltq: 25,
      atp: 812.34,
      volume: 1234567,
      buyQty: 5000,
      sellQty: 2500,
      open: 810,
      high: 820,
      low: 805,
      close: 800,
      oi: null,
    });
  });

  test("SnapQuote packet adds open interest", () => {
    const t = decodeTick(packet({ mode: 3, exchangeType: 1, token: "3045", ltp: 81250n }));
    expect(t?.mode).toBe(Mode.SNAP_QUOTE);
    expect(t?.oi).toBe(4500);
    expect(t?.volume).toBe(1234567);
  });

  test("CDS prices use a 10^7 divisor", () => {
    expect(decodeTick(packet({ mode: 1, exchangeType: 13, token: "1", ltp: 835000000n }))?.ltp).toBe(83.5);
  });

  test("accepts a Uint8Array view", () => {
    const bytes = new Uint8Array(packet({ mode: 1, exchangeType: 3, token: "500325", ltp: 100n }));
    expect(decodeTick(bytes)?.exchange).toBe("BSE");
  });

  test("rejects short packets and unknown exchange or mode", () => {
    expect(decodeTick(new ArrayBuffer(10))).toBeNull();
    expect(decodeTick(packet({ mode: 1, exchangeType: 99, token: "1", ltp: 1n }))).toBeNull();
    expect(decodeTick(packet({ mode: 1, exchangeType: 1, token: "1", ltp: 1n }).slice(0, 50))).toBeNull();
    const badMode = packet({ mode: 1, exchangeType: 1, token: "1", ltp: 1n });
    new DataView(badMode).setUint8(0, 9);
    expect(decodeTick(badMode)).toBeNull();
  });
});

describe("subscribeMessage", () => {
  test("groups tokens by exchange type", () => {
    const msg = subscribeMessage(1, Mode.QUOTE, [
      { exchange: "NSE", token: "3045" },
      { exchange: "NFO", token: "49014" },
      { exchange: "NSE", token: "2885" },
    ]);
    expect(JSON.parse(msg)).toEqual({
      correlationID: "mcp",
      action: 1,
      params: {
        mode: 2,
        tokenList: [
          { exchangeType: 1, tokens: ["3045", "2885"] },
          { exchangeType: 2, tokens: ["49014"] },
        ],
      },
    });
  });

  test("unsubscribe uses action 0", () => {
    expect(JSON.parse(subscribeMessage(0, Mode.LTP, [{ exchange: "BSE", token: "1" }])).action).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/feed/protocol.test.ts`
Expected: FAIL — `Cannot find module './protocol.ts'`.

- [ ] **Step 3: Write the implementation**

`src/feed/protocol.ts`:

```ts
// SmartAPI WebSocket 2.0 wire format. Byte offsets follow the official SDK
// (see docs/superpowers/specs/2026-10-18-live-streaming-design.md).

export type Exchange = "NSE" | "NFO" | "BSE" | "BFO" | "MCX" | "NCDEX" | "CDS";

export const EXCHANGE_TYPE: Record<Exchange, number> = {
  NSE: 1,
  NFO: 2,
  BSE: 3,
  BFO: 4,
  MCX: 5,
  NCDEX: 7,
  CDS: 13,
};

const EXCHANGE_BY_TYPE = new Map<number, Exchange>(
  Object.entries(EXCHANGE_TYPE).map(([ex, type]) => [type, ex as Exchange]),
);

export const Mode = { LTP: 1, QUOTE: 2, SNAP_QUOTE: 3 } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export interface Tick {
  exchange: Exchange;
  token: string;
  mode: Mode;
  exchangeTs: number;
  ltp: number;
  ltq: number | null;
  atp: number | null;
  volume: number | null;
  buyQty: number | null;
  sellQty: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  oi: number | null;
}

const LTP_SIZE = 51;
const QUOTE_SIZE = 123;
const SNAP_OI_END = 139;

export function decodeTick(input: ArrayBuffer | Uint8Array): Tick | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < LTP_SIZE) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mode = v.getUint8(0);
  const exchange = EXCHANGE_BY_TYPE.get(v.getUint8(1));
  if (!exchange || (mode !== Mode.LTP && mode !== Mode.QUOTE && mode !== Mode.SNAP_QUOTE)) return null;

  const divisor = exchange === "CDS" ? 1e7 : 100;
  const int = (offset: number) => Number(v.getBigInt64(offset, true));
  const price = (offset: number) => int(offset) / divisor;
  const token = new TextDecoder().decode(bytes.subarray(2, 27)).split("\0")[0] ?? "";

  const tick: Tick = {
    exchange,
    token,
    mode,
    exchangeTs: int(35),
    ltp: price(43),
    ltq: null,
    atp: null,
    volume: null,
    buyQty: null,
    sellQty: null,
    open: null,
    high: null,
    low: null,
    close: null,
    oi: null,
  };
  if (mode !== Mode.LTP && bytes.length >= QUOTE_SIZE) {
    tick.ltq = int(51);
    tick.atp = price(59);
    tick.volume = int(67);
    tick.buyQty = v.getFloat64(75, true);
    tick.sellQty = v.getFloat64(83, true);
    tick.open = price(91);
    tick.high = price(99);
    tick.low = price(107);
    tick.close = price(115);
  }
  if (mode === Mode.SNAP_QUOTE && bytes.length >= SNAP_OI_END) tick.oi = int(131);
  return tick;
}

export function subscribeMessage(
  action: 0 | 1,
  mode: Mode,
  symbols: { exchange: Exchange; token: string }[],
): string {
  const byType = new Map<number, string[]>();
  for (const s of symbols) {
    const type = EXCHANGE_TYPE[s.exchange];
    const tokens = byType.get(type) ?? [];
    tokens.push(s.token);
    byType.set(type, tokens);
  }
  return JSON.stringify({
    correlationID: "mcp",
    action,
    params: { mode, tokenList: [...byType].map(([exchangeType, tokens]) => ({ exchangeType, tokens })) },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/feed/protocol.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/feed/protocol.ts src/feed/protocol.test.ts
git commit -m "Add SmartAPI WebSocket tick protocol

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Momentum metrics

**Files:**
- Create: `src/momentum.ts`
- Test: `src/momentum.test.ts`

**Interfaces:**
- Consumes: `Tick`, `Exchange`, `Mode` from `src/feed/protocol.ts`.
- Produces:
  - `interface Accumulator { first; last; high; low; prevClose; firstVolume; lastVolume: number | null; pv; vSum; upticks; downticks; ticks: number; buyQty; sellQty: number | null }`
  - `newAccumulator(baseline?: { ltp: number; close: number | null }): Accumulator`
  - `applyTick(acc: Accumulator, t: Tick): void`
  - `interface SymbolMeta { exchange: Exchange; token: string; tradingsymbol: string }`
  - `interface SymbolSummary` (fields below)
  - `summarize(acc: Accumulator, meta: SymbolMeta, elapsedMs: number): SymbolSummary`
  - `type SortKey = "change" | "volume" | "vs_vwap" | "buy_sell_ratio"`
  - `sortSummaries(list: SymbolSummary[], key: SortKey): SymbolSummary[]`

- [ ] **Step 1: Write the failing test**

`src/momentum.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { Mode, type Tick } from "./feed/protocol.ts";
import { applyTick, newAccumulator, sortSummaries, summarize, type SymbolSummary } from "./momentum.ts";

const META = { exchange: "NSE" as const, token: "3045", tradingsymbol: "SBIN-EQ" };

function tick(ltp: number, extra: Partial<Tick> = {}): Tick {
  return {
    exchange: "NSE",
    token: "3045",
    mode: Mode.QUOTE,
    exchangeTs: 0,
    ltp,
    ltq: null,
    atp: null,
    volume: null,
    buyQty: null,
    sellQty: null,
    open: null,
    high: null,
    low: null,
    close: null,
    oi: null,
    ...extra,
  };
}

describe("summarize", () => {
  test("QUOTE ticks produce price, VWAP, volume and pressure metrics", () => {
    const acc = newAccumulator({ ltp: 100, close: 98 });
    applyTick(acc, tick(101, { volume: 1000 }));
    applyTick(acc, tick(102, { volume: 1500 }));
    applyTick(acc, tick(101, { volume: 1700, buyQty: 3000, sellQty: 1500 }));

    expect(summarize(acc, META, 120_000)).toEqual({
      tradingsymbol: "SBIN-EQ",
      exchange: "NSE",
      token: "3045",
      ltp: 101,
      change_pct_window: 1,
      change_pct_day: 3.06,
      vwap_window: 101.71,
      ltp_vs_vwap_pct: -0.7,
      volume_window: 700,
      volume_per_min: 350,
      buy_sell_ratio: 2,
      uptick_ratio: 0.667,
      high_window: 102,
      low_window: 100,
      ticks: 3,
    });
  });

  test("LTP-only ticks leave volume metrics null", () => {
    const acc = newAccumulator();
    applyTick(acc, tick(50));
    applyTick(acc, tick(51));
    const s = summarize(acc, META, 60_000);
    expect(s.change_pct_window).toBe(2);
    expect(s.change_pct_day).toBeNull();
    expect(s.vwap_window).toBeNull();
    expect(s.volume_window).toBeNull();
    expect(s.buy_sell_ratio).toBeNull();
    expect(s.uptick_ratio).toBe(1);
  });

  test("a zero baseline price is ignored", () => {
    const acc = newAccumulator({ ltp: 0, close: null });
    applyTick(acc, tick(10));
    expect(summarize(acc, META, 1000).change_pct_window).toBe(0);
  });

  test("no ticks keeps the baseline as the last price", () => {
    const s = summarize(newAccumulator({ ltp: 100, close: 100 }), META, 1000);
    expect(s.ltp).toBe(100);
    expect(s.ticks).toBe(0);
    expect(s.uptick_ratio).toBeNull();
  });
});

describe("sortSummaries", () => {
  const row = (tradingsymbol: string, change: number | null, volume: number | null): SymbolSummary => ({
    ...summarize(newAccumulator(), { ...META, tradingsymbol }, 1000),
    change_pct_window: change,
    volume_window: volume,
  });

  test("sorts descending with nulls last", () => {
    const list = [row("A", 1, 10), row("B", null, 30), row("C", 3, null), row("D", -2, 20)];
    expect(sortSummaries(list, "change").map((r) => r.tradingsymbol)).toEqual(["C", "A", "D", "B"]);
    expect(sortSummaries(list, "volume").map((r) => r.tradingsymbol)).toEqual(["B", "D", "A", "C"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/momentum.test.ts`
Expected: FAIL — `Cannot find module './momentum.ts'`.

- [ ] **Step 3: Write the implementation**

`src/momentum.ts`:

```ts
import type { Exchange, Tick } from "./feed/protocol.ts";

/** Running per-symbol stats for one watch. Raw ticks are never stored. */
export interface Accumulator {
  first: number | null;
  last: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  firstVolume: number | null;
  lastVolume: number | null;
  pv: number;
  vSum: number;
  upticks: number;
  downticks: number;
  ticks: number;
  buyQty: number | null;
  sellQty: number | null;
}

export interface SymbolMeta {
  exchange: Exchange;
  token: string;
  tradingsymbol: string;
}

export interface SymbolSummary extends SymbolMeta {
  ltp: number | null;
  change_pct_window: number | null;
  change_pct_day: number | null;
  vwap_window: number | null;
  ltp_vs_vwap_pct: number | null;
  volume_window: number | null;
  volume_per_min: number | null;
  buy_sell_ratio: number | null;
  uptick_ratio: number | null;
  high_window: number | null;
  low_window: number | null;
  ticks: number;
}

export type SortKey = "change" | "volume" | "vs_vwap" | "buy_sell_ratio";

const SORT_FIELD: Record<SortKey, keyof SymbolSummary> = {
  change: "change_pct_window",
  volume: "volume_window",
  vs_vwap: "ltp_vs_vwap_pct",
  buy_sell_ratio: "buy_sell_ratio",
};

const round = (x: number, digits = 2) => Math.round(x * 10 ** digits) / 10 ** digits;

const pctChange = (now: number | null, base: number | null) =>
  now !== null && base !== null && base > 0 ? round(((now - base) / base) * 100) : null;

export function newAccumulator(baseline?: { ltp: number; close: number | null }): Accumulator {
  const p = baseline && baseline.ltp > 0 ? baseline.ltp : null;
  return {
    first: p,
    last: p,
    high: p,
    low: p,
    prevClose: baseline?.close ?? null,
    firstVolume: null,
    lastVolume: null,
    pv: 0,
    vSum: 0,
    upticks: 0,
    downticks: 0,
    ticks: 0,
    buyQty: null,
    sellQty: null,
  };
}

export function applyTick(acc: Accumulator, t: Tick): void {
  const p = t.ltp;
  if (acc.last !== null) {
    if (p > acc.last) acc.upticks++;
    else if (p < acc.last) acc.downticks++;
  }
  acc.first ??= p;
  acc.last = p;
  acc.high = acc.high === null ? p : Math.max(acc.high, p);
  acc.low = acc.low === null ? p : Math.min(acc.low, p);
  acc.ticks++;
  if (t.close !== null && t.close > 0) acc.prevClose = t.close;
  if (t.volume !== null) {
    // Ticks carry the day's cumulative volume; the window only sees the increase.
    if (acc.lastVolume !== null && t.volume > acc.lastVolume) {
      const traded = t.volume - acc.lastVolume;
      acc.pv += p * traded;
      acc.vSum += traded;
    }
    acc.firstVolume ??= t.volume;
    acc.lastVolume = t.volume;
  }
  if (t.buyQty !== null) acc.buyQty = t.buyQty;
  if (t.sellQty !== null) acc.sellQty = t.sellQty;
}

export function summarize(acc: Accumulator, meta: SymbolMeta, elapsedMs: number): SymbolSummary {
  const vwap = acc.vSum > 0 ? acc.pv / acc.vSum : null;
  const volume = acc.firstVolume !== null && acc.lastVolume !== null ? acc.lastVolume - acc.firstVolume : null;
  const minutes = Math.max(elapsedMs / 60_000, 1 / 60);
  const moves = acc.upticks + acc.downticks;
  return {
    tradingsymbol: meta.tradingsymbol,
    exchange: meta.exchange,
    token: meta.token,
    ltp: acc.last,
    change_pct_window: pctChange(acc.last, acc.first),
    change_pct_day: pctChange(acc.last, acc.prevClose),
    vwap_window: vwap === null ? null : round(vwap),
    ltp_vs_vwap_pct: pctChange(acc.last, vwap),
    volume_window: volume,
    volume_per_min: volume === null ? null : Math.round(volume / minutes),
    buy_sell_ratio: acc.buyQty !== null && acc.sellQty ? round(acc.buyQty / acc.sellQty) : null,
    uptick_ratio: moves > 0 ? round(acc.upticks / moves, 3) : null,
    high_window: acc.high,
    low_window: acc.low,
    ticks: acc.ticks,
  };
}

export function sortSummaries(list: SymbolSummary[], key: SortKey): SymbolSummary[] {
  const field = SORT_FIELD[key];
  return [...list].sort((a, b) => {
    const x = a[field] as number | null;
    const y = b[field] as number | null;
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    return y - x;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/momentum.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/momentum.ts src/momentum.test.ts
git commit -m "Add momentum accumulator and summary metrics

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Managed WebSocket connection

**Files:**
- Create: `src/feed/connection.ts`
- Create: `src/feed/fakes.ts`
- Test: `src/feed/connection.test.ts`

**Interfaces:**
- Produces (in `connection.ts`):
  - `interface FeedSession { jwt: string; feedToken: string; apiKey: string; clientCode: string }`
  - `interface SocketLike { binaryType: string; send(data: string): void; close(): void; onopen; onmessage: ((ev: { data: unknown }) => void) | null; onclose; onerror }`
  - `type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike`
  - `interface Timers { setTimeout(fn, ms): unknown; clearTimeout(h): void; setInterval(fn, ms): unknown; clearInterval(h): void }`
  - `type ConnState = "idle" | "connecting" | "connected" | "reconnecting" | "error"`
  - `interface FeedStatus { state: ConnState; since: string; last_error: string | null; reconnect_attempts: number }`
  - `interface FeedOptions { getSession: () => Promise<FeedSession>; relogin: () => Promise<FeedSession>; socketFactory?; timers?; now?: () => number; log?: (msg: string) => void }`
  - `backoffDelay(attempt: number): number`
  - `class ManagedConnection { constructor(o: ConnectionOptions); start(): void; stop(): void; send(data: string): boolean; noteError(message: string): void; status(): FeedStatus; onStatus(fn): () => void }`
- Produces (in `fakes.ts`): `FakeTimers` (with `now` and `advance(ms)`), `FakeSocket` (`url`, `headers`, `sent`, `closed`, `open()`, `receive(data)`, `close()`), `socketRecorder(): { sockets: FakeSocket[]; factory: SocketFactory }`, `flush(): Promise<void>`.

- [ ] **Step 1: Write the test doubles**

`src/feed/fakes.ts`:

```ts
// Test doubles for the WebSocket layer. Not imported by production code.
import type { SocketFactory, SocketLike, Timers } from "./connection.ts";

interface Task {
  at: number;
  every: number | null;
  fn: () => void;
}

export class FakeTimers implements Timers {
  now = 0;
  private seq = 0;
  private readonly tasks = new Map<number, Task>();

  setTimeout = (fn: () => void, ms: number) => this.add(fn, ms, null);
  setInterval = (fn: () => void, ms: number) => this.add(fn, ms, ms);
  clearTimeout = (handle: unknown) => void this.tasks.delete(handle as number);
  clearInterval = (handle: unknown) => void this.tasks.delete(handle as number);

  /** Moves the clock forward, firing due timers in order. */
  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let nextId: number | null = null;
      let next: Task | null = null;
      for (const [id, task] of this.tasks) {
        if (task.at <= end && (next === null || task.at < next.at)) {
          nextId = id;
          next = task;
        }
      }
      if (next === null || nextId === null) break;
      this.now = next.at;
      if (next.every === null) this.tasks.delete(nextId);
      else next.at += next.every;
      next.fn();
    }
    this.now = end;
  }

  private add(fn: () => void, ms: number, every: number | null): number {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, every, fn });
    return id;
  }
}

export class FakeSocket implements SocketLike {
  binaryType = "blob";
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  /** Closing works for both sides: our close() and a server drop. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.({});
  }

  open(): void {
    this.onopen?.({});
  }

  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
}

export function socketRecorder(): { sockets: FakeSocket[]; factory: SocketFactory } {
  const sockets: FakeSocket[] = [];
  return {
    sockets,
    factory: (url, headers) => {
      const s = new FakeSocket(url, headers);
      sockets.push(s);
      return s;
    },
  };
}

/** Lets pending promise callbacks (e.g. an awaited getSession) run. */
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
```

- [ ] **Step 2: Write the failing test**

`src/feed/connection.test.ts`:

```ts
import { expect, test } from "bun:test";
import { backoffDelay, ManagedConnection, type FeedSession } from "./connection.ts";
import { FakeTimers, flush, socketRecorder } from "./fakes.ts";

const SESSION: FeedSession = { jwt: "jwt1", feedToken: "feed", apiKey: "key", clientCode: "C1" };

function setup() {
  const timers = new FakeTimers();
  const rec = socketRecorder();
  const opened: number[] = [];
  const messages: unknown[] = [];
  const calls = { logins: 0, relogins: 0 };
  const conn = new ManagedConnection({
    url: "wss://example.test/feed",
    headers: (s) => ({ token: s.jwt }),
    getSession: async () => {
      calls.logins++;
      return SESSION;
    },
    relogin: async () => {
      calls.relogins++;
      return { ...SESSION, jwt: "jwt2" };
    },
    socketFactory: rec.factory,
    timers,
    now: () => timers.now,
    onOpen: () => opened.push(timers.now),
    onMessage: (d) => messages.push(d),
  });
  return { timers, rec, conn, opened, messages, calls };
}

test("backoff doubles from 1s and caps at 30s", () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("connects lazily with session headers and reports connected", async () => {
  const { rec, conn, opened } = setup();
  expect(conn.status().state).toBe("idle");
  conn.start();
  await flush();
  const ws = rec.sockets[0]!;
  expect(ws.url).toBe("wss://example.test/feed");
  expect(ws.headers).toEqual({ token: "jwt1" });
  expect(ws.binaryType).toBe("arraybuffer");
  expect(conn.status().state).toBe("connecting");
  ws.open();
  expect(conn.status().state).toBe("connected");
  expect(opened).toHaveLength(1);
  expect(conn.send("hello")).toBe(true);
  expect(ws.sent).toEqual(["hello"]);
});

test("send returns false while not connected", () => {
  const { conn } = setup();
  expect(conn.send("x")).toBe(false);
});

test("forwards messages but swallows pong", async () => {
  const { rec, conn, messages } = setup();
  conn.start();
  await flush();
  rec.sockets[0]!.open();
  rec.sockets[0]!.receive("pong");
  rec.sockets[0]!.receive("data");
  expect(messages).toEqual(["data"]);
});

test("pings every 10s and reconnects a socket silent for over 20s", async () => {
  const { timers, rec, conn } = setup();
  conn.start();
  await flush();
  rec.sockets[0]!.open();
  timers.advance(10_000);
  expect(rec.sockets[0]!.sent).toEqual(["ping"]);
  timers.advance(15_000);
  expect(rec.sockets[0]!.closed).toBe(true);
  expect(conn.status().state).toBe("reconnecting");
  timers.advance(1000);
  await flush();
  expect(rec.sockets).toHaveLength(2);
});

test("any message keeps the socket alive", async () => {
  const { timers, rec, conn } = setup();
  conn.start();
  await flush();
  rec.sockets[0]!.open();
  for (let i = 0; i < 6; i++) {
    timers.advance(10_000);
    rec.sockets[0]!.receive("pong");
  }
  expect(rec.sockets[0]!.closed).toBe(false);
});

test("re-logs in once after two failed opens, then reports error while retrying", async () => {
  const { timers, rec, conn, calls } = setup();
  conn.start();
  await flush();
  rec.sockets[0]!.close();
  expect(conn.status().state).toBe("reconnecting");

  timers.advance(1000);
  await flush();
  rec.sockets[1]!.close();
  timers.advance(2000);
  await flush();
  expect(calls.relogins).toBe(1);
  expect(rec.sockets[2]!.headers).toEqual({ token: "jwt2" });

  rec.sockets[2]!.close();
  expect(conn.status().state).toBe("error");
  expect(conn.status().last_error).toContain("closed before opening");

  for (const delay of [4000, 8000, 16000]) {
    timers.advance(delay);
    await flush();
    rec.sockets.at(-1)!.close();
  }
  expect(rec.sockets).toHaveLength(6);
  timers.advance(29_999);
  await flush();
  expect(rec.sockets).toHaveLength(6);
  timers.advance(1);
  await flush();
  expect(rec.sockets).toHaveLength(7);
  expect(calls.relogins).toBe(1);

  rec.sockets[6]!.open();
  expect(conn.status()).toMatchObject({ state: "connected", last_error: null, reconnect_attempts: 0 });
});

test("stop closes the socket and never reconnects", async () => {
  const { timers, rec, conn } = setup();
  conn.start();
  await flush();
  rec.sockets[0]!.open();
  conn.stop();
  expect(rec.sockets[0]!.closed).toBe(true);
  expect(conn.status().state).toBe("idle");
  timers.advance(60_000);
  await flush();
  expect(rec.sockets).toHaveLength(1);
});

test("noteError records the message and notifies listeners", () => {
  const { conn } = setup();
  const seen: (string | null)[] = [];
  conn.onStatus((s) => seen.push(s.last_error));
  conn.noteError("E1002 limit");
  expect(conn.status().last_error).toBe("E1002 limit");
  expect(seen).toEqual(["E1002 limit"]);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bun test src/feed/connection.test.ts`
Expected: FAIL — `Cannot find module './connection.ts'`.

- [ ] **Step 4: Write the implementation**

`src/feed/connection.ts`:

```ts
export interface FeedSession {
  jwt: string;
  feedToken: string;
  apiKey: string;
  clientCode: string;
}

export interface SocketLike {
  binaryType: string;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => SocketLike;

// Bun's WebSocket accepts custom upgrade headers, which SmartAPI uses for auth.
export const defaultSocketFactory: SocketFactory = (url, headers) =>
  new WebSocket(url, { headers }) as unknown as SocketLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export type ConnState = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export interface FeedStatus {
  state: ConnState;
  since: string;
  last_error: string | null;
  reconnect_attempts: number;
}

export interface FeedOptions {
  getSession: () => Promise<FeedSession>;
  relogin: () => Promise<FeedSession>;
  socketFactory?: SocketFactory;
  timers?: Timers;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface ConnectionOptions extends FeedOptions {
  url: string;
  headers: (s: FeedSession) => Record<string, string>;
  onOpen: () => void;
  onMessage: (data: unknown) => void;
}

const PING_MS = 10_000;
const STALE_CHECK_MS = 5_000;
const STALE_AFTER_MS = 20_000;
const MAX_BACKOFF_MS = 30_000;

export const backoffDelay = (attempt: number) => Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS);

/**
 * One auto-reconnecting WebSocket. Connects on start(), keeps itself alive with
 * pings, reconnects with backoff, and re-logs in once when opens keep failing
 * (SmartAPI rejects the upgrade when the JWT or feed token is stale).
 */
export class ManagedConnection {
  private ws: SocketLike | null = null;
  private state: ConnState = "idle";
  private stateSince: number;
  private lastError: string | null = null;
  private attempt = 0;
  private failedOpens = 0;
  private reloginUsed = false;
  private forceRelogin = false;
  private wanted = false;
  private generation = 0;
  private lastMessageAt = 0;
  private heartbeat: unknown[] = [];
  private reconnectTimer: unknown = null;
  private readonly listeners = new Set<(s: FeedStatus) => void>();
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly factory: SocketFactory;

  constructor(private readonly o: ConnectionOptions) {
    this.timers = o.timers ?? realTimers;
    this.now = o.now ?? Date.now;
    this.factory = o.socketFactory ?? defaultSocketFactory;
    this.stateSince = this.now();
  }

  status(): FeedStatus {
    return {
      state: this.state,
      since: new Date(this.stateSince).toISOString(),
      last_error: this.lastError,
      reconnect_attempts: this.attempt,
    };
  }

  onStatus(fn: (s: FeedStatus) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    this.wanted = true;
    if (this.state === "idle") void this.connect();
  }

  stop(): void {
    this.wanted = false;
    this.generation++;
    this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.attempt = 0;
    this.failedOpens = 0;
    this.reloginUsed = false;
    this.setState("idle");
  }

  send(data: string): boolean {
    if (this.state !== "connected" || !this.ws) return false;
    this.ws.send(data);
    return true;
  }

  noteError(message: string): void {
    this.lastError = message;
    this.o.log?.(message);
    this.emit();
  }

  private async connect(): Promise<void> {
    const gen = ++this.generation;
    if (this.state !== "error") this.setState(this.attempt === 0 ? "connecting" : "reconnecting");
    let session: FeedSession;
    try {
      session = this.forceRelogin ? await this.o.relogin() : await this.o.getSession();
      this.forceRelogin = false;
    } catch (e) {
      if (gen !== this.generation) return;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.failedOpens++;
      this.scheduleReconnect();
      return;
    }
    if (!this.wanted || gen !== this.generation) return;

    const ws = this.factory(this.o.url, this.o.headers(session));
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      opened = true;
      this.attempt = 0;
      this.failedOpens = 0;
      this.reloginUsed = false;
      this.lastError = null;
      this.lastMessageAt = this.now();
      this.setState("connected");
      this.startHeartbeat(ws);
      this.o.onOpen();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastMessageAt = this.now();
      if (ev.data === "pong") return;
      this.o.onMessage(ev.data);
    };
    ws.onerror = () => {
      // onclose always follows; reconnect is handled there.
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.stopHeartbeat();
      if (!opened) {
        this.failedOpens++;
        this.lastError ??= "WebSocket closed before opening (check API key and session)";
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.wanted) {
      this.setState("idle");
      return;
    }
    if (this.failedOpens >= 2 && !this.reloginUsed) {
      this.reloginUsed = true;
      this.forceRelogin = true;
    }
    const delay = backoffDelay(this.attempt);
    this.attempt++;
    this.setState(this.reloginUsed && this.failedOpens > 2 ? "error" : "reconnecting");
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private startHeartbeat(ws: SocketLike): void {
    this.heartbeat = [
      this.timers.setInterval(() => ws.send("ping"), PING_MS),
      this.timers.setInterval(() => {
        if (this.now() - this.lastMessageAt > STALE_AFTER_MS) ws.close();
      }, STALE_CHECK_MS),
    ];
  }

  private stopHeartbeat(): void {
    for (const h of this.heartbeat) this.timers.clearInterval(h);
    this.heartbeat = [];
  }

  private setState(state: ConnState): void {
    if (state === this.state) return;
    this.state = state;
    this.stateSince = this.now();
    this.o.log?.(`${this.o.url}: ${state}`);
    this.emit();
  }

  private emit(): void {
    const s = this.status();
    for (const fn of this.listeners) fn(s);
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/feed/connection.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/feed/connection.ts src/feed/fakes.ts src/feed/connection.test.ts
git commit -m "Add auto-reconnecting WebSocket connection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Market and order feeds

**Files:**
- Create: `src/feed/market.ts`
- Create: `src/feed/orders.ts`
- Test: `src/feed/market.test.ts`
- Test: `src/feed/orders.test.ts`

**Interfaces:**
- Consumes: `ManagedConnection`, `FeedOptions`, `FeedStatus`, `realTimers`, `Timers` from `connection.ts`; `decodeTick`, `subscribeMessage`, `Exchange`, `Mode`, `Tick` from `protocol.ts`; fakes from `fakes.ts`.
- Produces (in `market.ts`):
  - `interface SymbolRef { exchange: Exchange; token: string }`
  - `interface FeedLike { subscribe(symbols: SymbolRef[], mode: Mode): void; unsubscribe(symbols: SymbolRef[], mode: Mode): void; onTick(fn: (t: Tick) => void): () => void; onStatus(fn: (s: FeedStatus) => void): () => void; status(): FeedStatus; subscriptionCount(): number }`
  - `class MarketFeed implements FeedLike { constructor(opts: FeedOptions); close(): void }`
- Produces (in `orders.ts`):
  - `interface OrderEvent { seq: number; received_at: string; data: unknown }`
  - `class OrderFeed { constructor(opts: FeedOptions & { capacity?: number }); start(): void; close(): void; status(): FeedStatus; latestSeq(): number; after(since: number): OrderEvent[]; waitForEvent(since: number, ms: number): Promise<void> }`

- [ ] **Step 1: Write the failing market feed test**

`src/feed/market.test.ts`:

```ts
import { expect, test } from "bun:test";
import { FakeTimers, flush, socketRecorder } from "./fakes.ts";
import { MarketFeed } from "./market.ts";
import { Mode, type Tick } from "./protocol.ts";

const SESSION = { jwt: "jwt", feedToken: "feed", apiKey: "key", clientCode: "C1" };
const SBIN = { exchange: "NSE" as const, token: "3045" };
const RELI = { exchange: "NSE" as const, token: "2885" };

function setup() {
  const timers = new FakeTimers();
  const rec = socketRecorder();
  const feed = new MarketFeed({
    getSession: async () => SESSION,
    relogin: async () => SESSION,
    socketFactory: rec.factory,
    timers,
    now: () => timers.now,
  });
  return { timers, rec, feed };
}

const sentJson = (sent: string[]) => sent.map((s) => JSON.parse(s));

function ltpPacket(token: string, paise: bigint): ArrayBuffer {
  const buf = new ArrayBuffer(51);
  const v = new DataView(buf);
  v.setUint8(0, 1);
  v.setUint8(1, 1);
  new Uint8Array(buf).set(new TextEncoder().encode(token), 2);
  v.setBigInt64(43, paise, true);
  return buf;
}

test("connects on first subscribe with market headers and subscribes once open", async () => {
  const { rec, feed } = setup();
  feed.subscribe([SBIN, RELI], Mode.QUOTE);
  await flush();
  const ws = rec.sockets[0]!;
  expect(ws.url).toBe("wss://smartapisocket.angelone.in/smart-stream");
  expect(ws.headers).toEqual({
    Authorization: "jwt",
    "x-api-key": "key",
    "x-client-code": "C1",
    "x-feed-token": "feed",
  });
  ws.open();
  expect(sentJson(ws.sent)).toEqual([
    { correlationID: "mcp", action: 1, params: { mode: 2, tokenList: [{ exchangeType: 1, tokens: ["3045", "2885"] }] } },
  ]);
});

test("shares subscriptions and unsubscribes only when the last reference goes", async () => {
  const { rec, feed } = setup();
  feed.subscribe([SBIN], Mode.QUOTE);
  await flush();
  const ws = rec.sockets[0]!;
  ws.open();
  feed.subscribe([SBIN], Mode.QUOTE);
  expect(ws.sent).toHaveLength(1);
  feed.subscribe([RELI], Mode.QUOTE);
  expect(ws.sent).toHaveLength(2);
  expect(feed.subscriptionCount()).toBe(2);

  feed.unsubscribe([SBIN], Mode.QUOTE);
  expect(ws.sent).toHaveLength(2);
  feed.unsubscribe([SBIN], Mode.QUOTE);
  expect(sentJson(ws.sent)[2]).toEqual({
    correlationID: "mcp",
    action: 0,
    params: { mode: 2, tokenList: [{ exchangeType: 1, tokens: ["3045"] }] },
  });
  expect(feed.subscriptionCount()).toBe(1);

  feed.unsubscribe([RELI], Mode.QUOTE);
  expect(ws.closed).toBe(true);
  expect(feed.status().state).toBe("idle");
});

test("decodes binary frames and forwards ticks", async () => {
  const { rec, feed } = setup();
  const ticks: Tick[] = [];
  feed.onTick((t) => ticks.push(t));
  feed.subscribe([SBIN], Mode.LTP);
  await flush();
  rec.sockets[0]!.open();
  rec.sockets[0]!.receive(ltpPacket("3045", 81250n));
  expect(ticks).toHaveLength(1);
  expect(ticks[0]).toMatchObject({ exchange: "NSE", token: "3045", ltp: 812.5 });
});

test("records JSON error frames on the status", async () => {
  const { rec, feed } = setup();
  feed.subscribe([SBIN], Mode.QUOTE);
  await flush();
  rec.sockets[0]!.open();
  rec.sockets[0]!.receive(
    JSON.stringify({ correlationID: "mcp", errorCode: "E1002", errorMessage: "Subscription Limit Exceeded" }),
  );
  expect(feed.status().last_error).toBe("market feed: E1002 Subscription Limit Exceeded");
});

test("re-subscribes everything after a reconnect", async () => {
  const { timers, rec, feed } = setup();
  feed.subscribe([SBIN], Mode.QUOTE);
  feed.subscribe([RELI], Mode.LTP);
  await flush();
  rec.sockets[0]!.open();
  rec.sockets[0]!.close();
  timers.advance(1000);
  await flush();
  const ws2 = rec.sockets[1]!;
  ws2.open();
  expect(sentJson(ws2.sent)).toEqual([
    { correlationID: "mcp", action: 1, params: { mode: 2, tokenList: [{ exchangeType: 1, tokens: ["3045"] }] } },
    { correlationID: "mcp", action: 1, params: { mode: 1, tokenList: [{ exchangeType: 1, tokens: ["2885"] }] } },
  ]);
});
```

- [ ] **Step 2: Write the failing order feed test**

`src/feed/orders.test.ts`:

```ts
import { expect, test } from "bun:test";
import { FakeTimers, flush, socketRecorder } from "./fakes.ts";
import { OrderFeed } from "./orders.ts";

const SESSION = { jwt: "jwt", feedToken: "feed", apiKey: "key", clientCode: "C1" };

function setup(capacity?: number) {
  const timers = new FakeTimers();
  const rec = socketRecorder();
  const feed = new OrderFeed({
    getSession: async () => SESSION,
    relogin: async () => SESSION,
    socketFactory: rec.factory,
    timers,
    now: () => timers.now,
    capacity,
  });
  return { timers, rec, feed };
}

test("uses Bearer auth and buffers events with sequence numbers", async () => {
  const { rec, feed } = setup();
  feed.start();
  await flush();
  const ws = rec.sockets[0]!;
  expect(ws.url).toBe("wss://tns.angelone.in/smart-order-update");
  expect(ws.headers).toEqual({
    Authorization: "Bearer jwt",
    "x-api-key": "key",
    "x-client-code": "C1",
    "x-feed-token": "feed",
  });
  ws.open();
  ws.receive(JSON.stringify({ "order-status": "AB00" }));
  ws.receive("pong");
  ws.receive(JSON.stringify({ orderData: { orderid: "1" } }));
  ws.receive("not json");

  expect(feed.latestSeq()).toBe(3);
  expect(feed.after(0).map((e) => e.data)).toEqual([
    { "order-status": "AB00" },
    { orderData: { orderid: "1" } },
    "not json",
  ]);
  expect(feed.after(2).map((e) => e.seq)).toEqual([3]);
  expect(feed.after(0)[0]!.received_at).toBe("1970-01-01T00:00:00.000Z");
});

test("keeps only the newest events up to capacity", async () => {
  const { rec, feed } = setup(3);
  feed.start();
  await flush();
  rec.sockets[0]!.open();
  for (let i = 1; i <= 5; i++) rec.sockets[0]!.receive(JSON.stringify({ i }));
  expect(feed.after(0).map((e) => e.seq)).toEqual([3, 4, 5]);
});

test("waitForEvent resolves on a new event or on timeout", async () => {
  const { timers, rec, feed } = setup();
  feed.start();
  await flush();
  rec.sockets[0]!.open();

  let resolved = false;
  const p = feed.waitForEvent(0, 5000).then(() => (resolved = true));
  await flush();
  expect(resolved).toBe(false);
  rec.sockets[0]!.receive("{}");
  await p;
  expect(resolved).toBe(true);

  let timedOut = false;
  const q = feed.waitForEvent(1, 5000).then(() => (timedOut = true));
  timers.advance(4999);
  await flush();
  expect(timedOut).toBe(false);
  timers.advance(1);
  await q;
  expect(timedOut).toBe(true);
});

test("waitForEvent returns immediately when newer events exist", async () => {
  const { rec, feed } = setup();
  feed.start();
  await flush();
  rec.sockets[0]!.open();
  rec.sockets[0]!.receive("{}");
  await feed.waitForEvent(0, 60_000);
  expect(feed.latestSeq()).toBe(1);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test src/feed/market.test.ts src/feed/orders.test.ts`
Expected: FAIL — `Cannot find module './market.ts'` / `'./orders.ts'`.

- [ ] **Step 4: Implement `MarketFeed`**

`src/feed/market.ts`:

```ts
import { ManagedConnection, type FeedOptions, type FeedStatus } from "./connection.ts";
import { decodeTick, subscribeMessage, type Exchange, type Mode, type Tick } from "./protocol.ts";

export const MARKET_FEED_URL = "wss://smartapisocket.angelone.in/smart-stream";

export interface SymbolRef {
  exchange: Exchange;
  token: string;
}

/** What WatchManager needs from a market feed (lets tests use a fake). */
export interface FeedLike {
  subscribe(symbols: SymbolRef[], mode: Mode): void;
  unsubscribe(symbols: SymbolRef[], mode: Mode): void;
  onTick(fn: (t: Tick) => void): () => void;
  onStatus(fn: (s: FeedStatus) => void): () => void;
  status(): FeedStatus;
  subscriptionCount(): number;
}

const subKey = (s: SymbolRef, mode: Mode) => `${s.exchange}:${s.token}:${mode}`;

export class MarketFeed implements FeedLike {
  private readonly conn: ManagedConnection;
  private readonly subs = new Map<string, { symbol: SymbolRef; mode: Mode; refs: number }>();
  private readonly tickListeners = new Set<(t: Tick) => void>();

  constructor(opts: FeedOptions) {
    this.conn = new ManagedConnection({
      ...opts,
      url: MARKET_FEED_URL,
      headers: (s) => ({
        Authorization: s.jwt,
        "x-api-key": s.apiKey,
        "x-client-code": s.clientCode,
        "x-feed-token": s.feedToken,
      }),
      onOpen: () => this.resubscribeAll(),
      onMessage: (data) => this.handle(data),
    });
  }

  subscribe(symbols: SymbolRef[], mode: Mode): void {
    const added: SymbolRef[] = [];
    for (const s of symbols) {
      const entry = this.subs.get(subKey(s, mode));
      if (entry) entry.refs++;
      else {
        this.subs.set(subKey(s, mode), { symbol: s, mode, refs: 1 });
        added.push(s);
      }
    }
    if (added.length === 0) return;
    // When not connected yet, onOpen re-sends every subscription.
    if (!this.conn.send(subscribeMessage(1, mode, added))) this.conn.start();
  }

  unsubscribe(symbols: SymbolRef[], mode: Mode): void {
    const removed: SymbolRef[] = [];
    for (const s of symbols) {
      const entry = this.subs.get(subKey(s, mode));
      if (!entry) continue;
      if (--entry.refs === 0) {
        this.subs.delete(subKey(s, mode));
        removed.push(s);
      }
    }
    if (this.subs.size === 0) {
      this.conn.stop();
      return;
    }
    if (removed.length > 0) this.conn.send(subscribeMessage(0, mode, removed));
  }

  onTick(fn: (t: Tick) => void): () => void {
    this.tickListeners.add(fn);
    return () => this.tickListeners.delete(fn);
  }

  onStatus(fn: (s: FeedStatus) => void): () => void {
    return this.conn.onStatus(fn);
  }

  status(): FeedStatus {
    return this.conn.status();
  }

  subscriptionCount(): number {
    return this.subs.size;
  }

  close(): void {
    this.subs.clear();
    this.conn.stop();
  }

  private resubscribeAll(): void {
    const byMode = new Map<Mode, SymbolRef[]>();
    for (const { symbol, mode } of this.subs.values()) {
      const list = byMode.get(mode) ?? [];
      list.push(symbol);
      byMode.set(mode, list);
    }
    for (const [mode, list] of byMode) this.conn.send(subscribeMessage(1, mode, list));
  }

  private handle(data: unknown): void {
    if (typeof data === "string") {
      try {
        const msg = JSON.parse(data) as { errorCode?: string; errorMessage?: string };
        if (msg.errorCode || msg.errorMessage) {
          this.conn.noteError(`market feed: ${msg.errorCode ?? ""} ${msg.errorMessage ?? ""}`.trim());
        }
      } catch {
        // Other text frames carry nothing we use.
      }
      return;
    }
    if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
      const tick = decodeTick(data);
      if (tick) for (const fn of this.tickListeners) fn(tick);
    }
  }
}
```

- [ ] **Step 5: Implement `OrderFeed`**

`src/feed/orders.ts`:

```ts
import { ManagedConnection, realTimers, type FeedOptions, type FeedStatus, type Timers } from "./connection.ts";

export const ORDER_FEED_URL = "wss://tns.angelone.in/smart-order-update";

export interface OrderEvent {
  seq: number;
  received_at: string;
  data: unknown;
}

/** Buffers the user's order status updates; connects on first use. */
export class OrderFeed {
  private readonly conn: ManagedConnection;
  private readonly events: OrderEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly timers: Timers;
  private readonly now: () => number;
  private readonly capacity: number;
  private seq = 0;

  constructor(opts: FeedOptions & { capacity?: number }) {
    this.timers = opts.timers ?? realTimers;
    this.now = opts.now ?? Date.now;
    this.capacity = opts.capacity ?? 500;
    this.conn = new ManagedConnection({
      ...opts,
      url: ORDER_FEED_URL,
      headers: (s) => ({
        Authorization: `Bearer ${s.jwt}`,
        "x-api-key": s.apiKey,
        "x-client-code": s.clientCode,
        "x-feed-token": s.feedToken,
      }),
      onOpen: () => {},
      onMessage: (data) => this.handle(data),
    });
  }

  start(): void {
    this.conn.start();
  }

  close(): void {
    this.conn.stop();
    for (const wake of [...this.waiters]) wake();
  }

  status(): FeedStatus {
    return this.conn.status();
  }

  latestSeq(): number {
    return this.seq;
  }

  after(since: number): OrderEvent[] {
    return this.events.filter((e) => e.seq > since);
  }

  /** Resolves once an event newer than `since` exists, or after `ms`. */
  waitForEvent(since: number, ms: number): Promise<void> {
    if (this.seq > since) return Promise.resolve();
    return new Promise((resolve) => {
      const wake = () => {
        this.timers.clearTimeout(timer);
        this.waiters.delete(wake);
        resolve();
      };
      const timer = this.timers.setTimeout(wake, ms);
      this.waiters.add(wake);
    });
  }

  private handle(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: unknown = data;
    try {
      parsed = JSON.parse(data);
    } catch {
      // Keep non-JSON frames as raw text.
    }
    this.events.push({ seq: ++this.seq, received_at: new Date(this.now()).toISOString(), data: parsed });
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    for (const wake of [...this.waiters]) wake();
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/feed && bunx tsc --noEmit`
Expected: PASS for protocol, connection, market, orders tests.

- [ ] **Step 7: Commit**

```bash
git add src/feed/market.ts src/feed/orders.ts src/feed/market.test.ts src/feed/orders.test.ts
git commit -m "Add market and order update feeds

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Watch manager

**Files:**
- Create: `src/watch.ts`
- Test: `src/watch.test.ts`

**Interfaces:**
- Consumes: `FeedLike`, `SymbolRef` (market.ts); `FeedStatus` (connection.ts); `Mode`, `Tick`, `Exchange` (protocol.ts); `newAccumulator`, `applyTick`, `summarize`, `sortSummaries`, `Accumulator`, `SortKey`, `SymbolSummary` (momentum.ts).
- Produces:
  - `interface BaselineQuote extends SymbolRef { tradingsymbol: string; ltp: number; close: number | null }`
  - `type BaselineFetcher = (symbols: SymbolRef[]) => Promise<BaselineQuote[]>`
  - `interface WatchManagerOptions { feed: FeedLike; fetchBaseline: BaselineFetcher; now?: () => number; maxWatches?: number; maxSubscriptions?: number; idleMs?: number; sweepEveryMs?: number | null }`
  - `interface StartResult { watch_id: string; subscribed: { exchange; token; tradingsymbol }[]; rejected: { exchange; token; reason: string }[] }`
  - `interface WatchSummary { watch_id; label: string | null; mode: "LTP" | "QUOTE" | "SNAP_QUOTE"; elapsed_seconds: number; feed_status: FeedStatus; gaps: { from: string; to: string | null }[]; note: string | null; total_ticks: number; symbols: SymbolSummary[] }`
  - `class WatchManager { start(symbols: SymbolRef[], mode: Mode, label?: string): Promise<StartResult>; summary(id: string, opts?: { sortBy?: SortKey; limit?: number }): WatchSummary; startedAt(id: string): number; stop(id: string): void; list(): { watch_id; label; mode; age_seconds; symbols: number }[]; expireIdle(): void; dispose(): void }`

- [ ] **Step 1: Write the failing test**

`src/watch.test.ts`:

```ts
import { expect, test } from "bun:test";
import type { FeedStatus } from "./feed/connection.ts";
import type { FeedLike, SymbolRef } from "./feed/market.ts";
import { Mode, type Tick } from "./feed/protocol.ts";
import { WatchManager, type BaselineFetcher, type BaselineQuote, type WatchManagerOptions } from "./watch.ts";

class FakeFeed implements FeedLike {
  refs = new Map<string, number>();
  current: FeedStatus = { state: "connected", since: "", last_error: null, reconnect_attempts: 0 };
  private readonly tickFns = new Set<(t: Tick) => void>();
  private readonly statusFns = new Set<(s: FeedStatus) => void>();

  subscribe(symbols: SymbolRef[], mode: Mode) {
    for (const s of symbols) {
      const k = `${s.exchange}:${s.token}:${mode}`;
      this.refs.set(k, (this.refs.get(k) ?? 0) + 1);
    }
  }
  unsubscribe(symbols: SymbolRef[], mode: Mode) {
    for (const s of symbols) {
      const k = `${s.exchange}:${s.token}:${mode}`;
      const n = (this.refs.get(k) ?? 0) - 1;
      if (n <= 0) this.refs.delete(k);
      else this.refs.set(k, n);
    }
  }
  onTick(fn: (t: Tick) => void) {
    this.tickFns.add(fn);
    return () => this.tickFns.delete(fn);
  }
  onStatus(fn: (s: FeedStatus) => void) {
    this.statusFns.add(fn);
    return () => this.statusFns.delete(fn);
  }
  status() {
    return this.current;
  }
  subscriptionCount() {
    return this.refs.size;
  }
  tick(t: Tick) {
    for (const fn of this.tickFns) fn(t);
  }
  setState(state: FeedStatus["state"]) {
    this.current = { ...this.current, state };
    for (const fn of this.statusFns) fn(this.current);
  }
}

const QUOTES: Record<string, BaselineQuote> = {
  "NSE:3045": { exchange: "NSE", token: "3045", tradingsymbol: "SBIN-EQ", ltp: 800, close: 790 },
  "NSE:2885": { exchange: "NSE", token: "2885", tradingsymbol: "RELIANCE-EQ", ltp: 1400, close: 1390 },
  "NSE:1594": { exchange: "NSE", token: "1594", tradingsymbol: "INFY-EQ", ltp: 1500, close: 1500 },
};
const fetchBaseline: BaselineFetcher = async (symbols) =>
  symbols.flatMap((s) => QUOTES[`${s.exchange}:${s.token}`] ?? []);

const SBIN = { exchange: "NSE" as const, token: "3045" };
const RELI = { exchange: "NSE" as const, token: "2885" };
const INFY = { exchange: "NSE" as const, token: "1594" };

function setup(opts: Partial<WatchManagerOptions> = {}) {
  let now = 0;
  const feed = new FakeFeed();
  const m = new WatchManager({ feed, fetchBaseline, now: () => now, sweepEveryMs: null, ...opts });
  return { feed, m, advance: (ms: number) => void (now += ms) };
}

function tick(token: string, ltp: number, extra: Partial<Tick> = {}): Tick {
  return {
    exchange: "NSE",
    token,
    mode: Mode.QUOTE,
    exchangeTs: 0,
    ltp,
    ltq: null,
    atp: null,
    volume: null,
    buyQty: null,
    sellQty: null,
    open: null,
    high: null,
    low: null,
    close: null,
    oi: null,
    ...extra,
  };
}

test("start subscribes quoted symbols and rejects unknown ones", async () => {
  const { feed, m } = setup();
  const r = await m.start([SBIN, RELI, SBIN, { exchange: "NSE", token: "9999" }], Mode.QUOTE, "test");
  expect(r.watch_id).toBe("w1");
  expect(r.subscribed).toEqual([
    { exchange: "NSE", token: "3045", tradingsymbol: "SBIN-EQ" },
    { exchange: "NSE", token: "2885", tradingsymbol: "RELIANCE-EQ" },
  ]);
  expect(r.rejected).toEqual([
    { exchange: "NSE", token: "9999", reason: "No quote returned; check exchange and symboltoken with search_scrip" },
  ]);
  expect([...feed.refs.keys()]).toEqual(["NSE:3045:2", "NSE:2885:2"]);
});

test("start fails when no symbol can be quoted", async () => {
  const { m } = setup();
  await expect(m.start([{ exchange: "NSE", token: "9999" }], Mode.QUOTE)).rejects.toThrow("None of the symbols");
});

test("routes ticks to every watch with that symbol and mode", async () => {
  const { feed, m } = setup();
  const a = await m.start([SBIN, RELI], Mode.QUOTE);
  const b = await m.start([SBIN], Mode.QUOTE);
  expect(feed.refs.get("NSE:3045:2")).toBe(2);

  feed.tick(tick("3045", 808));
  feed.tick(tick("3045", 900, { mode: Mode.LTP }));
  for (const id of [a.watch_id, b.watch_id]) {
    const sbin = m.summary(id).symbols.find((s) => s.token === "3045")!;
    expect(sbin.ltp).toBe(808);
    expect(sbin.change_pct_window).toBe(1);
  }

  m.stop(a.watch_id);
  expect(feed.refs.get("NSE:3045:2")).toBe(1);
  expect(feed.refs.has("NSE:2885:2")).toBe(false);
  m.stop(b.watch_id);
  expect(feed.refs.size).toBe(0);
});

test("enforces watch and subscription limits", async () => {
  const { m } = setup({ maxWatches: 2, maxSubscriptions: 2 });
  await m.start([SBIN, RELI], Mode.QUOTE);
  await expect(m.start([INFY], Mode.QUOTE)).rejects.toThrow("the limit is 2");
  await m.start([SBIN], Mode.QUOTE);
  await expect(m.start([SBIN], Mode.QUOTE)).rejects.toThrow("Already running 2 watches");
});

test("summary sorts, limits and counts ticks", async () => {
  const { feed, m } = setup();
  const { watch_id } = await m.start([SBIN, RELI, INFY], Mode.QUOTE);
  feed.tick(tick("3045", 816));
  feed.tick(tick("2885", 1386));
  feed.tick(tick("1594", 1515));
  const s = m.summary(watch_id, { sortBy: "change", limit: 2 });
  expect(s.symbols.map((x) => [x.tradingsymbol, x.change_pct_window])).toEqual([
    ["SBIN-EQ", 2],
    ["INFY-EQ", 1],
  ]);
  expect(s.total_ticks).toBe(3);
  expect(s.mode).toBe("QUOTE");
  expect(s.note).toBeNull();
});

test("notes a likely closed market after 30s without ticks", async () => {
  const { m, advance } = setup();
  const { watch_id } = await m.start([SBIN], Mode.QUOTE);
  advance(29_000);
  expect(m.summary(watch_id).note).toBeNull();
  advance(1000);
  expect(m.summary(watch_id).note).toBe("no ticks received — market may be closed (NSE 09:15–15:30 IST)");
  expect(m.summary(watch_id).elapsed_seconds).toBe(30);
});

test("records disconnect gaps", async () => {
  const { feed, m, advance } = setup();
  const { watch_id } = await m.start([SBIN], Mode.QUOTE);
  advance(1000);
  feed.setState("reconnecting");
  advance(5000);
  feed.setState("connected");
  expect(m.summary(watch_id).gaps).toEqual([
    { from: "1970-01-01T00:00:01.000Z", to: "1970-01-01T00:00:06.000Z" },
  ]);
});

test("expires watches unread for 30 minutes", async () => {
  const { feed, m, advance } = setup();
  const { watch_id } = await m.start([SBIN], Mode.QUOTE);
  advance(29 * 60_000);
  m.expireIdle();
  m.summary(watch_id);
  advance(29 * 60_000);
  m.expireIdle();
  expect(m.list()).toHaveLength(1);
  advance(60_000);
  m.expireIdle();
  expect(m.list()).toEqual([]);
  expect(feed.refs.size).toBe(0);
});

test("unknown watch ids throw a helpful error", () => {
  const { m } = setup();
  expect(() => m.summary("w9")).toThrow('Unknown watch_id "w9"');
});

test("list describes active watches", async () => {
  const { m, advance } = setup();
  await m.start([SBIN, RELI], Mode.LTP, "banks");
  advance(65_000);
  expect(m.list()).toEqual([{ watch_id: "w1", label: "banks", mode: "LTP", age_seconds: 65, symbols: 2 }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/watch.test.ts`
Expected: FAIL — `Cannot find module './watch.ts'`.

- [ ] **Step 3: Write the implementation**

`src/watch.ts`:

```ts
import type { FeedStatus } from "./feed/connection.ts";
import type { FeedLike, SymbolRef } from "./feed/market.ts";
import type { Exchange, Mode, Tick } from "./feed/protocol.ts";
import {
  applyTick,
  newAccumulator,
  sortSummaries,
  summarize,
  type Accumulator,
  type SortKey,
  type SymbolSummary,
} from "./momentum.ts";

export interface BaselineQuote extends SymbolRef {
  tradingsymbol: string;
  ltp: number;
  close: number | null;
}

/** Returns quotes for the symbols it could find; missing ones are rejected. */
export type BaselineFetcher = (symbols: SymbolRef[]) => Promise<BaselineQuote[]>;

export interface WatchManagerOptions {
  feed: FeedLike;
  fetchBaseline: BaselineFetcher;
  now?: () => number;
  maxWatches?: number;
  maxSubscriptions?: number;
  idleMs?: number;
  sweepEveryMs?: number | null;
}

export interface StartResult {
  watch_id: string;
  subscribed: { exchange: Exchange; token: string; tradingsymbol: string }[];
  rejected: { exchange: Exchange; token: string; reason: string }[];
}

export interface WatchSummary {
  watch_id: string;
  label: string | null;
  mode: "LTP" | "QUOTE" | "SNAP_QUOTE";
  elapsed_seconds: number;
  feed_status: FeedStatus;
  gaps: { from: string; to: string | null }[];
  note: string | null;
  total_ticks: number;
  symbols: SymbolSummary[];
}

interface Watch {
  id: string;
  label: string | null;
  mode: Mode;
  createdAt: number;
  lastReadAt: number;
  symbols: Map<string, { meta: BaselineQuote; acc: Accumulator }>;
  gaps: { from: number; to: number | null }[];
}

const MODE_NAME: Record<Mode, WatchSummary["mode"]> = { 1: "LTP", 2: "QUOTE", 3: "SNAP_QUOTE" };
const NO_TICKS_NOTE = "no ticks received — market may be closed (NSE 09:15–15:30 IST)";
const NO_TICKS_AFTER_MS = 30_000;

const symKey = (s: SymbolRef) => `${s.exchange}:${s.token}`;
const routeKey = (s: SymbolRef, mode: Mode) => `${symKey(s)}:${mode}`;
const iso = (ms: number) => new Date(ms).toISOString();

export class WatchManager {
  private readonly watches = new Map<string, Watch>();
  private readonly routes = new Map<string, Set<Watch>>();
  private readonly feed: FeedLike;
  private readonly fetchBaseline: BaselineFetcher;
  private readonly now: () => number;
  private readonly maxWatches: number;
  private readonly maxSubscriptions: number;
  private readonly idleMs: number;
  private readonly sweep: ReturnType<typeof setInterval> | null = null;
  private feedState: FeedStatus["state"];
  private nextId = 0;

  constructor(o: WatchManagerOptions) {
    this.feed = o.feed;
    this.fetchBaseline = o.fetchBaseline;
    this.now = o.now ?? Date.now;
    this.maxWatches = o.maxWatches ?? 5;
    this.maxSubscriptions = o.maxSubscriptions ?? 1000;
    this.idleMs = o.idleMs ?? 30 * 60_000;
    this.feedState = this.feed.status().state;
    this.feed.onTick((t) => this.route(t));
    this.feed.onStatus((s) => this.onFeedStatus(s));
    const every = o.sweepEveryMs === undefined ? 60_000 : o.sweepEveryMs;
    if (every) {
      this.sweep = setInterval(() => this.expireIdle(), every);
      this.sweep.unref?.();
    }
  }

  async start(symbols: SymbolRef[], mode: Mode, label?: string): Promise<StartResult> {
    this.assertWatchSlot();
    const unique = [...new Map(symbols.map((s) => [symKey(s), s])).values()];
    const needed = this.feed.subscriptionCount() + unique.filter((s) => !this.routes.has(routeKey(s, mode))).length;
    if (needed > this.maxSubscriptions) {
      throw new Error(`Watching these would need ${needed} live subscriptions; the limit is ${this.maxSubscriptions}`);
    }

    const quotes = new Map((await this.fetchBaseline(unique)).map((q) => [symKey(q), q]));
    const found = unique.flatMap((s) => quotes.get(symKey(s)) ?? []);
    if (found.length === 0) {
      throw new Error("None of the symbols could be quoted; check exchange and symboltoken with search_scrip");
    }
    this.assertWatchSlot();

    const now = this.now();
    const w: Watch = {
      id: `w${++this.nextId}`,
      label: label ?? null,
      mode,
      createdAt: now,
      lastReadAt: now,
      symbols: new Map(),
      gaps: [],
    };
    for (const q of found) {
      w.symbols.set(symKey(q), { meta: q, acc: newAccumulator({ ltp: q.ltp, close: q.close }) });
      const rk = routeKey(q, mode);
      const set = this.routes.get(rk) ?? new Set<Watch>();
      set.add(w);
      this.routes.set(rk, set);
    }
    this.watches.set(w.id, w);
    this.feed.subscribe(
      found.map((q) => ({ exchange: q.exchange, token: q.token })),
      mode,
    );

    return {
      watch_id: w.id,
      subscribed: found.map((q) => ({ exchange: q.exchange, token: q.token, tradingsymbol: q.tradingsymbol })),
      rejected: unique
        .filter((s) => !quotes.has(symKey(s)))
        .map((s) => ({
          exchange: s.exchange,
          token: s.token,
          reason: "No quote returned; check exchange and symboltoken with search_scrip",
        })),
    };
  }

  summary(id: string, opts: { sortBy?: SortKey; limit?: number } = {}): WatchSummary {
    const w = this.get(id);
    const now = this.now();
    w.lastReadAt = now;
    const elapsedMs = now - w.createdAt;
    const all = [...w.symbols.values()].map((e) => summarize(e.acc, e.meta, elapsedMs));
    const sorted = sortSummaries(all, opts.sortBy ?? "change");
    const totalTicks = all.reduce((n, s) => n + s.ticks, 0);
    return {
      watch_id: w.id,
      label: w.label,
      mode: MODE_NAME[w.mode],
      elapsed_seconds: Math.round(elapsedMs / 1000),
      feed_status: this.feed.status(),
      gaps: w.gaps.map((g) => ({ from: iso(g.from), to: g.to === null ? null : iso(g.to) })),
      note: totalTicks === 0 && elapsedMs >= NO_TICKS_AFTER_MS ? NO_TICKS_NOTE : null,
      total_ticks: totalTicks,
      symbols: opts.limit ? sorted.slice(0, opts.limit) : sorted,
    };
  }

  startedAt(id: string): number {
    return this.get(id).createdAt;
  }

  stop(id: string): void {
    this.remove(this.get(id));
  }

  list() {
    const now = this.now();
    return [...this.watches.values()].map((w) => ({
      watch_id: w.id,
      label: w.label,
      mode: MODE_NAME[w.mode],
      age_seconds: Math.round((now - w.createdAt) / 1000),
      symbols: w.symbols.size,
    }));
  }

  expireIdle(): void {
    const now = this.now();
    for (const w of [...this.watches.values()]) {
      if (now - w.lastReadAt >= this.idleMs) this.remove(w);
    }
  }

  dispose(): void {
    if (this.sweep) clearInterval(this.sweep);
    for (const w of [...this.watches.values()]) this.remove(w);
  }

  private assertWatchSlot(): void {
    if (this.watches.size >= this.maxWatches) {
      throw new Error(`Already running ${this.maxWatches} watches; stop one with stop_watch first`);
    }
  }

  private get(id: string): Watch {
    const w = this.watches.get(id);
    if (!w) throw new Error(`Unknown watch_id "${id}"; use list_watches to see active watches`);
    return w;
  }

  private remove(w: Watch): void {
    this.watches.delete(w.id);
    const refs: SymbolRef[] = [];
    for (const { meta } of w.symbols.values()) {
      const rk = routeKey(meta, w.mode);
      const set = this.routes.get(rk);
      set?.delete(w);
      if (set?.size === 0) this.routes.delete(rk);
      refs.push({ exchange: meta.exchange, token: meta.token });
    }
    this.feed.unsubscribe(refs, w.mode);
  }

  private route(t: Tick): void {
    const set = this.routes.get(routeKey(t, t.mode));
    if (!set) return;
    for (const w of set) {
      const entry = w.symbols.get(symKey(t));
      if (entry) applyTick(entry.acc, t);
    }
  }

  private onFeedStatus(s: FeedStatus): void {
    const now = this.now();
    if (s.state === "connected") {
      for (const w of this.watches.values()) {
        const last = w.gaps.at(-1);
        if (last && last.to === null) last.to = now;
      }
    } else if (this.feedState === "connected") {
      for (const w of this.watches.values()) w.gaps.push({ from: now, to: null });
    }
    this.feedState = s.state;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/watch.test.ts && bunx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/watch.ts src/watch.test.ts
git commit -m "Add watch manager for live momentum sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: MCP wiring

**Files:**
- Modify: `src/smartapi.ts` (login stores `feedToken`; add `session()`, `relogin()`)
- Create: `src/tools/common.ts`
- Move: `src/tools.ts` → `src/tools/rest.ts` (rename export, use common helpers)
- Create: `src/tools/stream.ts`
- Modify: `index.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:
  - `SmartApi.session(): Promise<FeedSession>`, `SmartApi.relogin(): Promise<FeedSession>`
  - `registerRestTools(server: McpServer, api: SmartApi, enableTrading: boolean): void`
  - `registerStreamTools(server: McpServer, deps: { watches: WatchManager; orders: OrderFeed }): void`
  - `quoteBaseline(api: SmartApi): BaselineFetcher`

- [ ] **Step 1: Add session access to `SmartApi`**

In `src/smartapi.ts`, add the import at the top:

```ts
import type { FeedSession } from "./feed/connection.ts";
```

Add a field next to `private jwt`:

```ts
  private feedToken: string | null = null;
```

Replace the body of `login()` so it also stores the feed token:

```ts
  private login(): Promise<void> {
    this.loginPromise ??= (async () => {
      this.jwt = null;
      const r = await this.raw<{ jwtToken: string; feedToken: string }>(
        "POST",
        "/rest/auth/angelbroking/user/v1/loginByPassword",
        {
          clientcode: this.opts.clientCode,
          password: this.opts.pin,
          totp: totp(this.opts.totpSecret),
        },
      );
      if (!r.status || !r.data?.jwtToken) throw new SmartApiError(`Login failed: ${r.message}`, r.errorcode);
      this.jwt = r.data.jwtToken;
      this.feedToken = r.data.feedToken;
    })().finally(() => {
      this.loginPromise = null;
    });
    return this.loginPromise;
  }

  /** Credentials for the WebSocket feeds; logs in if needed. */
  async session(): Promise<FeedSession> {
    if (!this.jwt) await this.login();
    return this.currentSession();
  }

  /** Forces a fresh login (new JWT and feed token). */
  async relogin(): Promise<FeedSession> {
    await this.login();
    return this.currentSession();
  }

  private currentSession(): FeedSession {
    if (!this.jwt || !this.feedToken) throw new SmartApiError("Login did not return a JWT and feed token");
    return { jwt: this.jwt, feedToken: this.feedToken, apiKey: this.opts.apiKey, clientCode: this.opts.clientCode };
  }
```

- [ ] **Step 2: Extract shared tool helpers**

`src/tools/common.ts`:

```ts
import { z } from "zod";

export const exchange = z.enum(["NSE", "BSE", "NFO", "BFO", "MCX", "CDS", "NCDEX"]);

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
```

- [ ] **Step 3: Move REST tools**

```bash
mkdir -p src/tools && git mv src/tools.ts src/tools/rest.ts
```

In `src/tools/rest.ts`, replace everything from the first line through the end of the `wrap` definition (the block ending `      return fail(e);\n    }\n  };`) with:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SmartApi } from "../smartapi.ts";
import { exchange, READ, wrap, WRITE } from "./common.ts";

const P = "/rest/secure/angelbroking";

const transactionType = z.enum(["BUY", "SELL"]);
const productType = z.enum(["DELIVERY", "CARRYFORWARD", "MARGIN", "INTRADAY", "BO"]);
const orderType = z.enum(["MARKET", "LIMIT", "STOPLOSS_LIMIT", "STOPLOSS_MARKET"]);
const variety = z.enum(["NORMAL", "STOPLOSS", "AMO", "ROBO"]);
const interval = z.enum([
  "ONE_MINUTE",
  "THREE_MINUTE",
  "FIVE_MINUTE",
  "TEN_MINUTE",
  "FIFTEEN_MINUTE",
  "THIRTY_MINUTE",
  "ONE_HOUR",
  "ONE_DAY",
]);
const dateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "Use 'yyyy-MM-dd HH:mm' (IST)")
  .describe("IST timestamp, format 'yyyy-MM-dd HH:mm'");
const expiryType = z.enum(["NEAR", "NEXT", "FAR"]);
```

Then rename the export:

```bash
sed -i '' 's/^export function registerTools(/export function registerRestTools(/' src/tools/rest.ts
```

Run: `grep -n "^const str\|registerRestTools\|^function ok\|^const wrap" src/tools/rest.ts`
Expected: `const str` and `export function registerRestTools` present; no local `ok`/`wrap` definitions.

- [ ] **Step 4: Write the streaming tools**

`src/tools/stream.ts`:

```ts
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
```

- [ ] **Step 5: Wire up `index.ts`**

Replace `index.ts` with:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./src/config.ts";
import { MarketFeed } from "./src/feed/market.ts";
import { OrderFeed } from "./src/feed/orders.ts";
import { SmartApi } from "./src/smartapi.ts";
import { registerRestTools } from "./src/tools/rest.ts";
import { quoteBaseline, registerStreamTools } from "./src/tools/stream.ts";
import { WatchManager } from "./src/watch.ts";

// stdout carries the MCP protocol — log only to stderr.
const log = (msg: string) => console.error(`[angelone] ${msg}`);

const api = new SmartApi(config);
const feedOptions = { getSession: () => api.session(), relogin: () => api.relogin(), log };
const market = new MarketFeed(feedOptions);
const orders = new OrderFeed(feedOptions);
const watches = new WatchManager({ feed: market, fetchBaseline: quoteBaseline(api) });

const server = new McpServer({ name: "angelone", version: "0.2.0" });
registerRestTools(server, api, config.enableTrading);
registerStreamTools(server, { watches, orders });

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  watches.dispose();
  market.close();
  orders.close();
  process.exit(0);
}
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
log(`MCP server ready (trading ${config.enableTrading ? "ENABLED" : "disabled"})`);
```

- [ ] **Step 6: Document the tools**

In `README.md`, insert before `## Trading`:

```markdown
## Live streaming

The server keeps Angel One's WebSocket feeds open while it runs:

- `start_watch` — stream up to 1000 instruments (get tokens from `search_scrip`) and accumulate per-symbol stats.
- `get_watch_summary` — % change over the window and day, price vs VWAP, window volume, buy/sell ratio, uptick ratio. `wait_seconds: 300` returns after a 5-minute window.
- `stop_watch`, `list_watches` — manage watches (max 5; unread watches stop after 30 minutes).
- `get_order_updates` — your own order status changes as they happen.

Ticks only flow during market hours (NSE 09:15–15:30 IST).

```

- [ ] **Step 7: Verify types, tests and tool registration**

Run: `bunx tsc --noEmit && bun test`
Expected: no type errors; all tests pass.

Run:

```bash
(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; sleep 2) | ANGEL_API_KEY=x ANGEL_CLIENT_CODE=x ANGEL_PIN=x ANGEL_TOTP_SECRET=GEZDGNBV bun index.ts 2>/dev/null | tail -1 | bun -e 'const r=JSON.parse(await Bun.stdin.text()); console.log(r.result.tools.length, r.result.tools.map(t=>t.name).filter(n=>/watch|order_updates/.test(n)).join(","))'
```

Expected: `25 start_watch,get_watch_summary,stop_watch,list_watches,get_order_updates`

- [ ] **Step 8: Commit**

```bash
git add -A src index.ts README.md
git commit -m "Expose live streaming watches and order updates as MCP tools

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Live verification

**Files:** none in the repo (scratch script outside it).

- [ ] **Step 1: Write a scratch client**

Save as `<scratchpad>/stream-smoke.ts` (not in the repo):

```ts
import { Client } from "/Users/souvik/Documents/programs/playground/angleon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js";
import { StdioClientTransport } from "/Users/souvik/Documents/programs/playground/angleon/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js";

const c = new Client({ name: "stream-smoke", version: "1" });
await c.connect(
  new StdioClientTransport({
    command: "bun",
    args: ["/Users/souvik/Documents/programs/playground/angleon/index.ts"],
    cwd: "/tmp",
    stderr: "inherit",
  }),
);
const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await c.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
  console.log(`=== ${name} ${r.isError ? "ERROR" : "ok"}\n${r.content[0].text.slice(0, 1500)}`);
  return r.isError ? null : JSON.parse(r.content[0].text);
};

const w = await call("start_watch", {
  symbols: [
    { exchange: "NSE", symboltoken: "3045" },
    { exchange: "NSE", symboltoken: "2885" },
    { exchange: "NSE", symboltoken: "1594" },
    { exchange: "NSE", symboltoken: "99999999" },
  ],
  label: "smoke",
});
await call("list_watches", {});
await call("get_watch_summary", { watch_id: w.watch_id, wait_seconds: 35, limit: 3 });
await call("get_order_updates", { wait_seconds: 5 });
await call("stop_watch", { watch_id: w.watch_id });
await call("list_watches", {});
await c.close();
```

- [ ] **Step 2: Run it against the real account**

Run: `cd /Users/souvik/Documents/programs/playground/angleon && bun <scratchpad>/stream-smoke.ts`

Expected on a non-trading day:
- `start_watch` ok: 3 subscribed with tradingsymbols, token `99999999` rejected.
- stderr shows `smart-stream: connecting` then `smart-stream: connected`.
- `get_watch_summary` ok after ~35s: `feed_status.state` `"connected"`, `total_ticks: 0`, `note` = market-closed note, `gaps: []`.
- `get_order_updates` ok: `feed_status.state` `"connected"` (events may include an initial status frame).
- `stop_watch` ok; final `list_watches` is `[]`; stderr shows `smart-stream: idle`.

Expected on a trading day additionally: `total_ticks > 0` and each symbol's `ltp` within a few rupees of `get_quote` for the same token.

- [ ] **Step 3: Record the outcome**

If anything deviates, stop and debug (superpowers:systematic-debugging) before claiming completion. No commit for this task.
