import { expect, test } from "bun:test";
import { backoffDelay, ManagedConnection, type FeedSession } from "./connection.ts";
import { FakeTimers, flush, socketRecorder } from "./fakes.ts";

const SESSION: FeedSession = { jwt: "jwt1", feedToken: "feed", apiKey: "key", clientCode: "C1" };

function setup() {
  const timers = new FakeTimers();
  const rec = socketRecorder();
  const opened: number[] = [];
  const messages: unknown[] = [];
  const calls = { logins: 0, relogins: 0 };
  const conn = new ManagedConnection({
    url: "wss://example.test/feed",
    headers: (s) => ({ token: s.jwt }),
    getSession: async () => {
      calls.logins++;
      return SESSION;
    },
    relogin: async () => {
      calls.relogins++;
      return { ...SESSION, jwt: "jwt2" };
    },
    socketFactory: rec.factory,
    timers,
    now: () => timers.now,
    onOpen: () => opened.push(timers.now),
    onMessage: (d) => messages.push(d),
  });
  return { timers, rec, conn, opened, messages, calls };
}

test("backoff doubles from 1s and caps at 30s", () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(backoffDelay)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
});

test("connects lazily with session headers and reports connected", async () => {
  const { rec, conn, opened } = setup();
  expect(conn.status().state).toBe("idle");
  conn.start();
  await flush();
  const ws = rec.sockets[0]!;
  expect(ws.url).toBe("wss://example.test/feed");
  expect(ws.headers).toEqual({ token: "jwt1" });
  expect(ws.binaryType).toBe("arraybuffer");
  expect(conn.status().state).toBe("connecting");
  ws.open();
  expect(conn.status().state).toBe("connected");
  expect(opened).toHaveLength(1);
  expect(conn.send("hello")).toBe(true);
  expect(ws.sent).toEqual(["hello"]);
});

test("send returns false while not connected", () => {
  const { conn } = setup();
  expect(conn.send("x")).toBe(false);
});

test("forwards messages but swallows pong", async () => {
  const { rec, conn, messages } = setup();
  conn.start();
  await flush();
  rec.sockets[0]!.open();
  rec.sockets[0]!.receive("pong");
  rec.sockets[0]!.receive("data");
  expect(messages).toEqual(["data"]);
});

test("pings every 10s and reconnects a socket silent for over 20s", async () => {
  const { timers, rec, conn } = setup();
  conn.start();
  await flush();
  rec.sockets[0]!.open();
  timers.advance(10_000);
  expect(rec.sockets[0]!.sent).toEqual(["ping"]);
  timers.advance(15_000);
  expect(rec.sockets[0]!.closed).toBe(true);
  expect(conn.status().state).toBe("reconnecting");
  timers.advance(1000);
  await flush();
  expect(rec.sockets).toHaveLength(2);
});

test("any message keeps the socket alive", async () => {
  const { timers, rec, conn } = setup();
  conn.start();
  await flush();
  rec.sockets[0]!.open();
  for (let i = 0; i < 6; i++) {
    timers.advance(10_000);
    rec.sockets[0]!.receive("pong");
  }
  expect(rec.sockets[0]!.closed).toBe(false);
});

test("re-logs in once after two failed opens, then reports error while retrying", async () => {
  const { timers, rec, conn, calls } = setup();
  conn.start();
  await flush();
  rec.sockets[0]!.close();
  expect(conn.status().state).toBe("reconnecting");

  timers.advance(1000);
  await flush();
  rec.sockets[1]!.close();
  timers.advance(2000);
  await flush();
  expect(calls.relogins).toBe(1);
  expect(rec.sockets[2]!.headers).toEqual({ token: "jwt2" });

  rec.sockets[2]!.close();
  expect(conn.status().state).toBe("error");
  expect(conn.status().last_error).toContain("closed before opening");

  for (const delay of [4000, 8000, 16000]) {
    timers.advance(delay);
    await flush();
    rec.sockets.at(-1)!.close();
  }
  expect(rec.sockets).toHaveLength(6);
  timers.advance(29_999);
  await flush();
  expect(rec.sockets).toHaveLength(6);
  timers.advance(1);
  await flush();
  expect(rec.sockets).toHaveLength(7);
  expect(calls.relogins).toBe(1);

  rec.sockets[6]!.open();
  expect(conn.status()).toMatchObject({ state: "connected", last_error: null, reconnect_attempts: 0 });
});

test("stop closes the socket and never reconnects", async () => {
  const { timers, rec, conn } = setup();
  conn.start();
  await flush();
  rec.sockets[0]!.open();
  conn.stop();
  expect(rec.sockets[0]!.closed).toBe(true);
  expect(conn.status().state).toBe("idle");
  timers.advance(60_000);
  await flush();
  expect(rec.sockets).toHaveLength(1);
});

test("noteError records the message and notifies listeners", () => {
  const { conn } = setup();
  const seen: (string | null)[] = [];
  conn.onStatus((s) => seen.push(s.last_error));
  conn.noteError("E1002 limit");
  expect(conn.status().last_error).toBe("E1002 limit");
  expect(seen).toEqual(["E1002 limit"]);
});
