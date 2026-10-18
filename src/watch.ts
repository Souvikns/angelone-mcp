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
