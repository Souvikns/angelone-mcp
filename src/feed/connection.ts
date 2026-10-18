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
