import { expect, test } from "bun:test";
import { FakeTimers, flush, socketRecorder } from "./fakes.ts";
import { MarketFeed } from "./market.ts";
import { Mode, type Tick } from "./protocol.ts";

const SESSION = { jwt: "jwt", feedToken: "feed", apiKey: "key", clientCode: "C1" };
const SBIN = { exchange: "NSE" as const, token: "3045" };
const RELI = { exchange: "NSE" as const, token: "2885" };

function setup() {
  const timers = new FakeTimers();
  const rec = socketRecorder();
  const feed = new MarketFeed({
    getSession: async () => SESSION,
    relogin: async () => SESSION,
    socketFactory: rec.factory,
    timers,
    now: () => timers.now,
  });
  return { timers, rec, feed };
}

const sentJson = (sent: string[]) => sent.map((s) => JSON.parse(s));

function ltpPacket(token: string, paise: bigint): ArrayBuffer {
  const buf = new ArrayBuffer(51);
  const v = new DataView(buf);
  v.setUint8(0, 1);
  v.setUint8(1, 1);
  new Uint8Array(buf).set(new TextEncoder().encode(token), 2);
  v.setBigInt64(43, paise, true);
  return buf;
}

test("connects on first subscribe with market headers and subscribes once open", async () => {
  const { rec, feed } = setup();
  feed.subscribe([SBIN, RELI], Mode.QUOTE);
  await flush();
  const ws = rec.sockets[0]!;
  expect(ws.url).toBe("wss://smartapisocket.angelone.in/smart-stream");
  expect(ws.headers).toEqual({
    Authorization: "jwt",
    "x-api-key": "key",
    "x-client-code": "C1",
    "x-feed-token": "feed",
  });
  ws.open();
  expect(sentJson(ws.sent)).toEqual([
    { correlationID: "mcp", action: 1, params: { mode: 2, tokenList: [{ exchangeType: 1, tokens: ["3045", "2885"] }] } },
  ]);
});

test("shares subscriptions and unsubscribes only when the last reference goes", async () => {
  const { rec, feed } = setup();
  feed.subscribe([SBIN], Mode.QUOTE);
  await flush();
  const ws = rec.sockets[0]!;
  ws.open();
  feed.subscribe([SBIN], Mode.QUOTE);
  expect(ws.sent).toHaveLength(1);
  feed.subscribe([RELI], Mode.QUOTE);
  expect(ws.sent).toHaveLength(2);
  expect(feed.subscriptionCount()).toBe(2);

  feed.unsubscribe([SBIN], Mode.QUOTE);
  expect(ws.sent).toHaveLength(2);
  feed.unsubscribe([SBIN], Mode.QUOTE);
  expect(sentJson(ws.sent)[2]).toEqual({
    correlationID: "mcp",
    action: 0,
    params: { mode: 2, tokenList: [{ exchangeType: 1, tokens: ["3045"] }] },
  });
  expect(feed.subscriptionCount()).toBe(1);

  feed.unsubscribe([RELI], Mode.QUOTE);
  expect(ws.closed).toBe(true);
  expect(feed.status().state).toBe("idle");
});

test("decodes binary frames and forwards ticks", async () => {
  const { rec, feed } = setup();
  const ticks: Tick[] = [];
  feed.onTick((t) => ticks.push(t));
  feed.subscribe([SBIN], Mode.LTP);
  await flush();
  rec.sockets[0]!.open();
  rec.sockets[0]!.receive(ltpPacket("3045", 81250n));
  expect(ticks).toHaveLength(1);
  expect(ticks[0]).toMatchObject({ exchange: "NSE", token: "3045", ltp: 812.5 });
});

test("records JSON error frames on the status", async () => {
  const { rec, feed } = setup();
  feed.subscribe([SBIN], Mode.QUOTE);
  await flush();
  rec.sockets[0]!.open();
  rec.sockets[0]!.receive(
    JSON.stringify({ correlationID: "mcp", errorCode: "E1002", errorMessage: "Subscription Limit Exceeded" }),
  );
  expect(feed.status().last_error).toBe("market feed: E1002 Subscription Limit Exceeded");
});

test("re-subscribes everything after a reconnect", async () => {
  const { timers, rec, feed } = setup();
  feed.subscribe([SBIN], Mode.QUOTE);
  feed.subscribe([RELI], Mode.LTP);
  await flush();
  rec.sockets[0]!.open();
  rec.sockets[0]!.close();
  timers.advance(1000);
  await flush();
  const ws2 = rec.sockets[1]!;
  ws2.open();
  expect(sentJson(ws2.sent)).toEqual([
    { correlationID: "mcp", action: 1, params: { mode: 2, tokenList: [{ exchangeType: 1, tokens: ["3045"] }] } },
    { correlationID: "mcp", action: 1, params: { mode: 1, tokenList: [{ exchangeType: 1, tokens: ["2885"] }] } },
  ]);
});
