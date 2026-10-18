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
