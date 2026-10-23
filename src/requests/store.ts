import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RequestStatus = "executing" | "executed" | "rejected" | "expired" | "failed";

export interface TradeRequest {
  id: string;
  action: string;
  createdAt: string;
  expiresAt: string;
  reason: string;
  params: Record<string, unknown>;
}

export interface RequestResult {
  id: string;
  status: RequestStatus;
  decidedAt: string;
  ltp: number | null;
  response: unknown;
  order: unknown;
  error: string | null;
}

export interface RequestView extends TradeRequest {
  status: RequestStatus | "pending";
  result: RequestResult | null;
}

const ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const pad = (n: number) => String(n).padStart(2, "0");

/** Local-time id, e.g. 20261023-101530-a1b2, so files sort chronologically. */
export function newId(now: Date): string {
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${crypto.randomUUID().slice(0, 4)}`;
}

/** Status as a reader sees it: a request with no result is pending until it expires. */
export function view(req: TradeRequest, result: RequestResult | null, now: Date): RequestView {
  const status = result?.status ?? (now.getTime() >= Date.parse(req.expiresAt) ? "expired" : "pending");
  return { ...req, status, result };
}

async function readJson<T>(path: string): Promise<T | null> {
  const file = Bun.file(path);
  return (await file.exists()) ? ((await file.json()) as T) : null;
}

export class RequestStore {
  constructor(readonly dir: string) {}

  // Ids come from tool input, so they must never be able to point outside the folder.
  private path(id: string, suffix: ".json" | ".result.json" | ".log") {
    if (!ID.test(id)) throw new Error(`Invalid request id: ${id}`);
    return join(this.dir, id + suffix);
  }

  logPath(id: string) {
    return this.path(id, ".log");
  }

  async write(req: TradeRequest) {
    const path = this.path(req.id, ".json");
    await mkdir(this.dir, { recursive: true });
    await Bun.write(path, JSON.stringify(req, null, 2));
  }

  read(id: string): Promise<TradeRequest | null> {
    return readJson(this.path(id, ".json"));
  }

  readResult(id: string): Promise<RequestResult | null> {
    return readJson(this.path(id, ".result.json"));
  }

  /** Creates the result file only if none exists; false means another writer decided first. */
  async claim(result: RequestResult): Promise<boolean> {
    const path = this.path(result.id, ".result.json");
    await mkdir(this.dir, { recursive: true });
    try {
      await writeFile(path, JSON.stringify(result, null, 2), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
  }

  async writeResult(result: RequestResult) {
    await Bun.write(this.path(result.id, ".result.json"), JSON.stringify(result, null, 2));
  }

  /** Request ids, newest first. */
  async ids(limit: number): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return names
      .filter((n) => n.endsWith(".json") && ID.test(n.slice(0, -5)))
      .map((n) => n.slice(0, -5))
      .sort()
      .reverse()
      .slice(0, limit);
  }
}
