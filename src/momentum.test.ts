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
