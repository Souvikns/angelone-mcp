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
