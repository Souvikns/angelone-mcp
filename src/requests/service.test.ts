import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestService, spawnApprover } from "./service.ts";
import { RequestStore, type RequestResult } from "./store.ts";

const NOW = new Date("2026-10-23T05:00:00.000Z");
let dir: string;
let store: RequestStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "service-"));
  store = new RequestStore(dir);
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const rejected = (id: string): RequestResult => ({
  id,
  status: "rejected",
  decidedAt: NOW.toISOString(),
  ltp: null,
  response: null,
  order: null,
  error: null,
});

test("submit validates, files the request and waits for the approver", async () => {
  const launched: string[] = [];
  const svc = new RequestService({
    store,
    now: () => NOW,
    launch: async (id) => {
      launched.push(id);
      await store.claim(rejected(id));
    },
  });
  const s = await svc.submit("cancel_order", { variety: "NORMAL", orderid: "1", junk: true }, "Stop out");
  expect(s.waitMs).toBe(150_000);
  await s.settled;
  expect(launched).toEqual([s.id]);
  expect(await store.read(s.id)).toEqual({
    id: s.id,
    action: "cancel_order",
    createdAt: "2026-10-23T05:00:00.000Z",
    expiresAt: "2026-10-23T05:02:00.000Z",
    reason: "Stop out",
    params: { variety: "NORMAL", orderid: "1" },
  });
  const v = await svc.get(s.id);
  expect(v.status).toBe("rejected");
  expect(v.result?.status).toBe("rejected");
});

test("invalid params throw and nothing is filed", async () => {
  const svc = new RequestService({ store, launch: async () => {} });
  await expect(svc.submit("cancel_order", { variety: "NORMAL" }, "x")).rejects.toThrow();
  expect(await store.ids(10)).toEqual([]);
});

test("settled gives up after ttl + grace and the request reads as pending", async () => {
  const svc = new RequestService({ store, now: () => NOW, ttlMs: 20, graceMs: 10, launch: () => new Promise(() => {}) });
  const s = await svc.submit("cancel_order", { variety: "NORMAL", orderid: "1" }, "x");
  expect(s.waitMs).toBe(30);
  await s.settled;
  expect((await svc.get(s.id)).status).toBe("pending");
});

test("a launch failure rejects settled", async () => {
  const svc = new RequestService({
    store,
    launch: async () => {
      throw new Error("spawn bun ENOENT");
    },
  });
  const s = await svc.submit("cancel_order", { variety: "NORMAL", orderid: "1" }, "x");
  await expect(s.settled).rejects.toThrow("spawn bun ENOENT");
});

test("get throws for an unknown id; list is newest first", async () => {
  let t = NOW.getTime();
  const svc = new RequestService({ store, now: () => new Date((t += 1000)), launch: async () => {} });
  await expect(svc.get("20261023-101530-a1b2")).rejects.toThrow("No request 20261023-101530-a1b2");
  const a = await svc.submit("cancel_order", { variety: "NORMAL", orderid: "1" }, "first");
  const b = await svc.submit("cancel_order", { variety: "NORMAL", orderid: "2" }, "second");
  await store.claim(rejected(a.id));
  expect(await svc.list(10)).toEqual([
    { id: b.id, action: "cancel_order", status: "pending", createdAt: expect.any(String), reason: "second" },
    { id: a.id, action: "cancel_order", status: "rejected", createdAt: expect.any(String), reason: "first" },
  ]);
});

test("spawnApprover runs the script with the id and logs its output", async () => {
  const script = join(dir, "echo.ts");
  await Bun.write(script, "console.log('approver', Bun.argv[2]);");
  const id = "20261023-101530-a1b2";
  await spawnApprover(script, store)(id);
  expect(await Bun.file(store.logPath(id)).text()).toBe(`approver ${id}\n`);
});
