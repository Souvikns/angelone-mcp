import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, RequestStore, view, type RequestResult, type TradeRequest } from "./store.ts";

let dir: string;
let store: RequestStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "requests-"));
  store = new RequestStore(dir);
});

afterEach(() => rm(dir, { recursive: true, force: true }));

const ID = "20261023-101530-a1b2";

const req = (id: string, expiresAt = "2026-10-23T05:00:00.000Z"): TradeRequest => ({
  id,
  action: "cancel_order",
  createdAt: "2026-10-23T04:58:00.000Z",
  expiresAt,
  reason: "test",
  params: { variety: "NORMAL", orderid: "1" },
});

const result = (id: string, status: RequestResult["status"] = "rejected"): RequestResult => ({
  id,
  status,
  decidedAt: "2026-10-23T04:59:00.000Z",
  ltp: null,
  response: null,
  order: null,
  error: null,
});

test("newId is local time plus 4 hex chars", () => {
  expect(newId(new Date(2026, 9, 23, 10, 15, 30))).toMatch(/^20261023-101530-[0-9a-f]{4}$/);
});

test("request and result round-trip; missing ones read as null", async () => {
  expect(await store.read(ID)).toBeNull();
  await store.write(req(ID));
  expect(await store.read(ID)).toEqual(req(ID));
  expect(await store.readResult(ID)).toBeNull();
  await store.writeResult(result(ID));
  expect(await store.readResult(ID)).toEqual(result(ID));
});

test("claim succeeds only once", async () => {
  expect(await store.claim(result(ID, "executing"))).toBe(true);
  expect(await store.claim(result(ID, "rejected"))).toBe(false);
  expect((await store.readResult(ID))?.status).toBe("executing");
});

test("rejects ids that could escape the folder", () => {
  expect(() => store.read("../secrets")).toThrow("Invalid request id");
  expect(() => store.logPath("..\\x")).toThrow("Invalid request id");
});

test("ids lists requests newest first, ignoring result and other files", async () => {
  for (const id of ["20261023-101530-aaaa", "20261023-101531-bbbb", "20261022-090000-cccc"]) await store.write(req(id));
  await store.writeResult(result("20261023-101530-aaaa"));
  await Bun.write(join(dir, "notes.txt"), "x");
  expect(await store.ids(2)).toEqual(["20261023-101531-bbbb", "20261023-101530-aaaa"]);
});

test("ids is empty when the folder doesn't exist", async () => {
  expect(await new RequestStore(join(dir, "missing")).ids(10)).toEqual([]);
});

test("view: pending before expiry, expired after, result status wins", () => {
  const r = req(ID, "2026-10-23T05:00:00.000Z");
  expect(view(r, null, new Date("2026-10-23T04:59:59Z")).status).toBe("pending");
  expect(view(r, null, new Date("2026-10-23T05:00:00Z")).status).toBe("expired");
  const v = view(r, result(ID, "executed"), new Date("2026-10-23T06:00:00Z"));
  expect(v.status).toBe("executed");
  expect(v.result?.status).toBe("executed");
  expect(v.params).toEqual(r.params);
});
