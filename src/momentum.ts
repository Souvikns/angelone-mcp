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
