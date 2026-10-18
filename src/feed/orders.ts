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
