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
