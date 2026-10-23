import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api } from "./actions.ts";
import { approve, type ApproveDeps } from "./approve.ts";
import type { Confirm, Decision } from "./confirm.ts";
import { RequestStore, type TradeRequest } from "./store.ts";

const P = "/rest/secure/angelbroking";
const NOW = new Date("2026-10-23T05:00:00.000Z");
const ID = "20261023-103000-a1b2";

class FakeApi implements Api {
  calls: { method: string; path: string; body?: unknown }[] = [];
  ltp: number | null = 812.4;
  response: unknown = { orderid: "1001", uniqueorderid: "u-1" };
  fail: Error | null = null;
  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: "GET", path });
    return { status: "open", text: "" } as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: "POST", path, body });
    if (path.endsWith("/market/v1/quote")) return { fetched: this.ltp === null ? [] : [{ ltp: this.ltp }] } as T;
    if (this.fail) throw this.fail;
    return this.response as T;
  }
  paths() {
    return this.calls.map((c) => `${c.method} ${c.path}`);
  }
}

let dir: string;
let store: RequestStore;
let api: FakeApi;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "approve-"));
  store = new RequestStore(dir);
  api = new FakeApi();
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const placeParams = {
  tradingsymbol: "SBIN-EQ",
  symboltoken: "3045",
  exchange: "NSE",
  transactiontype: "BUY",
  ordertype: "MARKET",
  producttype: "INTRADAY",
  quantity: 2,
};

async function file(overrides: Partial<TradeRequest> = {}) {
  await store.write({
    id: ID,
    action: "place_order",
    createdAt: NOW.toISOString(),
    expiresAt: new Date(NOW.getTime() + 120_000).toISOString(),
    reason: "Breakout above VWAP",
    params: placeParams,
    ...overrides,
  });
}

function setup(decision: Decision | Error) {
  const shown: { title: string; text: string; timeoutSec: number }[] = [];
  const confirm: Confirm = async (title, text, timeoutSec) => {
    shown.push({ title, text, timeoutSec });
    if (decision instanceof Error) throw decision;
    return decision;
  };
  const deps: ApproveDeps = { api, store, confirm, now: () => NOW, sleep: async () => {} };
  return { shown, deps };
}

test("approve places the order, fetches its status and records it", async () => {
  await file();
  const { shown, deps } = setup("approve");
  const r = await approve(ID, deps);
  expect(r).toMatchObject({
    id: ID,
    status: "executed",
    decidedAt: NOW.toISOString(),
    ltp: 812.4,
    response: { orderid: "1001", uniqueorderid: "u-1" },
    order: { status: "open", text: "" },
    error: null,
  });
  expect(await store.readResult(ID)).toEqual(r);
  expect(api.paths()).toEqual([
    `POST ${P}/market/v1/quote`,
    `POST ${P}/order/v1/placeOrder`,
    `GET ${P}/order/v1/details/u-1`,
  ]);
  expect(shown).toHaveLength(1);
  expect(shown[0]!.title).toBe("Angel One: Place order");
  expect(shown[0]!.timeoutSec).toBe(120);
  for (const line of [
    "tradingsymbol: SBIN-EQ",
    "quantity: 2",
    "variety: NORMAL",
    "Last price: Rs 812.40",
    "Approx. value: Rs 1,624.80",
    "Reason: Breakout above VWAP",
    `Request: ${ID}`,
  ]) {
    expect(shown[0]!.text).toContain(line);
  }
});

test("reject records rejected and sends nothing", async () => {
  await file();
  const r = await approve(ID, setup("reject").deps);
  expect(r.status).toBe("rejected");
  expect(api.paths()).toEqual([`POST ${P}/market/v1/quote`]);
  expect((await store.readResult(ID))?.status).toBe("rejected");
});

test("dialog timeout records expired and sends nothing", async () => {
  await file();
  expect((await approve(ID, setup("timeout").deps)).status).toBe("expired");
  expect(api.paths()).toEqual([`POST ${P}/market/v1/quote`]);
});

test("an already-expired request is never shown", async () => {
  await file({ expiresAt: NOW.toISOString() });
  const { shown, deps } = setup("approve");
  expect((await approve(ID, deps)).status).toBe("expired");
  expect(shown).toHaveLength(0);
  expect(api.calls).toHaveLength(0);
});

test("invalid params fail without a dialog", async () => {
  await file({ params: { ...placeParams, quantity: 0 } });
  const { shown, deps } = setup("approve");
  const r = await approve(ID, deps);
  expect(r.status).toBe("failed");
  expect(r.error).toContain("quantity");
  expect(shown).toHaveLength(0);
  expect(api.calls).toHaveLength(0);
});

test("unknown action fails", async () => {
  await file({ action: "withdraw_funds" });
  const r = await approve(ID, setup("approve").deps);
  expect(r).toMatchObject({ status: "failed", error: "Unknown action withdraw_funds" });
});

test("a dialog that can't open fails and sends nothing", async () => {
  await file();
  const r = await approve(ID, setup(new Error("No approval dialog for platform linux")).deps);
  expect(r).toMatchObject({ status: "failed", error: "No approval dialog for platform linux" });
  expect(api.paths()).toEqual([`POST ${P}/market/v1/quote`]);
});

test("a SmartAPI error after approval is recorded as failed", async () => {
  await file();
  api.fail = new Error("Insufficient funds (AB4008)");
  const r = await approve(ID, setup("approve").deps);
  expect(r).toMatchObject({ status: "failed", error: "Insufficient funds (AB4008)", response: null });
  expect((await store.readResult(ID))?.status).toBe("failed");
});

test("a request that already has a result is not shown again", async () => {
  await file();
  const existing = { id: ID, status: "executing" as const, decidedAt: NOW.toISOString(), ltp: null, response: null, order: null, error: null };
  await store.claim(existing);
  const { shown, deps } = setup("approve");
  expect(await approve(ID, deps)).toEqual(existing);
  expect(shown).toHaveLength(0);
  expect(api.calls).toHaveLength(0);
});

test("actions without an instrument skip the price lookup and order follow-up", async () => {
  await file({ action: "cancel_order", params: { variety: "NORMAL", orderid: "1001" } });
  api.response = { orderid: "1001" };
  const { shown, deps } = setup("approve");
  const r = await approve(ID, deps);
  expect(r).toMatchObject({ status: "executed", ltp: null, order: null });
  expect(api.paths()).toEqual([`POST ${P}/order/v1/cancelOrder`]);
  expect(shown[0]!.text).not.toContain("Last price");
});

test("a missing request throws", async () => {
  await expect(approve(ID, setup("approve").deps)).rejects.toThrow(`No request ${ID}`);
});
