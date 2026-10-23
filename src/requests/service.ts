import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { parseParams, type ActionName } from "./actions.ts";
import { newId, view, type RequestStatus, type RequestStore, type RequestView, type TradeRequest } from "./store.ts";

/** Starts the approver for a request; resolves when it exits. */
export type Launch = (id: string) => Promise<void>;

export interface Submitted {
  id: string;
  waitMs: number;
  /** Resolves when the approver exits or waitMs passes, whichever comes first. */
  settled: Promise<void>;
}

export interface RequestSummary {
  id: string;
  action: string;
  status: RequestStatus | "pending";
  createdAt: string;
  reason: string;
}

export interface RequestServiceOptions {
  store: RequestStore;
  launch: Launch;
  now?: () => Date;
  /** How long the user has to decide. */
  ttlMs?: number;
  /** Extra wait after the deadline for an approved call to finish. */
  graceMs?: number;
}

function withTimeout(work: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export class RequestService {
  private readonly store: RequestStore;
  private readonly launch: Launch;
  private readonly now: () => Date;
  private readonly ttlMs: number;
  private readonly graceMs: number;

  constructor(opts: RequestServiceOptions) {
    this.store = opts.store;
    this.launch = opts.launch;
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? 120_000;
    this.graceMs = opts.graceMs ?? 30_000;
  }

  async submit(action: ActionName, raw: unknown, reason: string): Promise<Submitted> {
    const params = parseParams(action, raw);
    const now = this.now();
    const req: TradeRequest = {
      id: newId(now),
      action,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      reason,
      params,
    };
    await this.store.write(req);
    const waitMs = this.ttlMs + this.graceMs;
    return { id: req.id, waitMs, settled: withTimeout(this.launch(req.id), waitMs) };
  }

  async get(id: string): Promise<RequestView> {
    const req = await this.store.read(id);
    if (!req) throw new Error(`No request ${id}`);
    return view(req, await this.store.readResult(id), this.now());
  }

  async list(limit: number): Promise<RequestSummary[]> {
    const ids = await this.store.ids(limit);
    return Promise.all(
      ids.map(async (id) => {
        const v = await this.get(id);
        return { id: v.id, action: v.action, status: v.status, createdAt: v.createdAt, reason: v.reason };
      }),
    );
  }
}

/**
 * Runs `bun <script> <id>` as its own process with output in <id>.log, so an open
 * dialog or an approved call survives the MCP server restarting.
 */
export function spawnApprover(script: string, store: RequestStore): Launch {
  return (id) =>
    new Promise((resolve, reject) => {
      mkdirSync(store.dir, { recursive: true });
      const log = openSync(store.logPath(id), "a");
      try {
        const child = spawn(process.execPath, [script, id], {
          detached: true,
          windowsHide: true,
          stdio: ["ignore", log, log],
        });
        child.once("error", reject);
        child.once("exit", () => resolve());
      } finally {
        closeSync(log);
      }
    });
}
