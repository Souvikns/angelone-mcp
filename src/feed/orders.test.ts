import { expect, test } from "bun:test";
import { FakeTimers, flush, socketRecorder } from "./fakes.ts";
import { OrderFeed } from "./orders.ts";

const SESSION = { jwt: "jwt", feedToken: "feed", apiKey: "key", clientCode: "C1" };

function setup(capacity?: number) {
  const timers = new FakeTimers();
  const rec = socketRecorder();
  const feed = new OrderFeed({
    getSession: async () => SESSION,
    relogin: async () => SESSION,
    socketFactory: rec.factory,
    timers,
    now: () => timers.now,
    capacity,
  });
  return { timers, rec, feed };
}

test("uses Bearer auth and buffers events with sequence numbers", async () => {
  const { rec, feed } = setup();
  feed.start();
  await flush();
  const ws = rec.sockets[0]!;
  expect(ws.url).toBe("wss://tns.angelone.in/smart-order-update");
  expect(ws.headers).toEqual({
    Authorization: "Bearer jwt",
    "x-api-key": "key",
    "x-client-code": "C1",
    "x-feed-token": "feed",
  });
  ws.open();
  ws.receive(JSON.stringify({ "order-status": "AB00" }));
  ws.receive("pong");
  ws.receive(JSON.stringify({ orderData: { orderid: "1" } }));
  ws.receive("not json");

  expect(feed.latestSeq()).toBe(3);
  expect(feed.after(0).map((e) => e.data)).toEqual([
    { "order-status": "AB00" },
    { orderData: { orderid: "1" } },
    "not json",
  ]);
  expect(feed.after(2).map((e) => e.seq)).toEqual([3]);
  expect(feed.after(0)[0]!.received_at).toBe("1970-01-01T00:00:00.000Z");
});

test("keeps only the newest events up to capacity", async () => {
  const { rec, feed } = setup(3);
  feed.start();
  await flush();
  rec.sockets[0]!.open();
  for (let i = 1; i <= 5; i++) rec.sockets[0]!.receive(JSON.stringify({ i }));
  expect(feed.after(0).map((e) => e.seq)).toEqual([3, 4, 5]);
});

test("waitForEvent resolves on a new event or on timeout", async () => {
  const { timers, rec, feed } = setup();
  feed.start();
  await flush();
  rec.sockets[0]!.open();

  let resolved = false;
  const p = feed.waitForEvent(0, 5000).then(() => (resolved = true));
  await flush();
  expect(resolved).toBe(false);
  rec.sockets[0]!.receive("{}");
  await p;
  expect(resolved).toBe(true);

  let timedOut = false;
  const q = feed.waitForEvent(1, 5000).then(() => (timedOut = true));
  timers.advance(4999);
  await flush();
  expect(timedOut).toBe(false);
  timers.advance(1);
  await q;
  expect(timedOut).toBe(true);
});

test("waitForEvent returns immediately when newer events exist", async () => {
  const { rec, feed } = setup();
  feed.start();
  await flush();
  rec.sockets[0]!.open();
  rec.sockets[0]!.receive("{}");
  await feed.waitForEvent(0, 60_000);
  expect(feed.latestSeq()).toBe(1);
});
