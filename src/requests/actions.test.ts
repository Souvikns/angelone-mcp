import { beforeEach, expect, test } from "bun:test";
import { ACTIONS, executeAction, isAction, parseParams, safeParseParams, type Api } from "./actions.ts";

class FakeApi implements Api {
  calls: { method: string; path: string; body?: unknown }[] = [];
  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: "GET", path });
    return null as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: "POST", path, body });
    return { orderid: "1001" } as T;
  }
}

let api: FakeApi;
beforeEach(() => {
  api = new FakeApi();
});

const P = "/rest/secure/angelbroking";
const order = {
  tradingsymbol: "SBIN-EQ",
  symboltoken: "3045",
  exchange: "NSE",
  transactiontype: "BUY",
  ordertype: "LIMIT",
  producttype: "INTRADAY",
  quantity: 2,
  price: 801.5,
};

test("all seven actions are defined", () => {
  expect(Object.keys(ACTIONS).sort()).toEqual([
    "cancel_gtt_rule",
    "cancel_order",
    "convert_position",
    "create_gtt_rule",
    "modify_gtt_rule",
    "modify_order",
    "place_order",
  ]);
});

test("place_order applies defaults, drops unknown keys and sends numbers as strings", async () => {
  const params = parseParams("place_order", { ...order, junk: 1 });
  expect(params).toEqual({ ...order, variety: "NORMAL", duration: "DAY" });
  expect(await executeAction(api, "place_order", params)).toEqual({ orderid: "1001" });
  expect(api.calls).toEqual([
    {
      method: "POST",
      path: `${P}/order/v1/placeOrder`,
      body: { ...order, variety: "NORMAL", duration: "DAY", quantity: "2", price: "801.5" },
    },
  ]);
});

test("a market order without a price sends price 0", async () => {
  const params = parseParams("place_order", { ...order, ordertype: "MARKET", price: undefined });
  await executeAction(api, "place_order", params);
  expect(api.calls[0]?.body).toMatchObject({ price: "0", quantity: "2" });
});

test("modify_order sends quantity, price and trigger as strings", async () => {
  const params = parseParams("modify_order", {
    variety: "STOPLOSS",
    orderid: "1001",
    tradingsymbol: "SBIN-EQ",
    symboltoken: "3045",
    exchange: "NSE",
    ordertype: "STOPLOSS_LIMIT",
    producttype: "INTRADAY",
    quantity: 1,
    price: 800,
    triggerprice: 799.5,
  });
  await executeAction(api, "modify_order", params);
  expect(api.calls[0]).toMatchObject({
    path: `${P}/order/v1/modifyOrder`,
    body: { quantity: "1", price: "800", triggerprice: "799.5", duration: "DAY" },
  });
});

test("cancel and GTT actions pass params through unchanged", async () => {
  await executeAction(api, "cancel_order", parseParams("cancel_order", { variety: "NORMAL", orderid: "1001" }));
  const gtt = { id: "77", symboltoken: "3045", exchange: "NSE" };
  await executeAction(api, "cancel_gtt_rule", parseParams("cancel_gtt_rule", gtt));
  expect(api.calls).toEqual([
    { method: "POST", path: `${P}/order/v1/cancelOrder`, body: { variety: "NORMAL", orderid: "1001" } },
    { method: "POST", path: `${P}/gtt/v1/cancelRule`, body: gtt },
  ]);
});

test("invalid params are rejected", () => {
  expect(() => parseParams("place_order", { ...order, quantity: 0 })).toThrow();
  expect(safeParseParams("create_gtt_rule", { exchange: "NFO" }).success).toBe(false);
});

test("isAction only accepts defined actions", () => {
  expect(isAction("place_order")).toBe(true);
  expect(isAction("toString")).toBe(false);
  expect(isAction("get_funds")).toBe(false);
});
