# Order Requests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the MCP server's seven direct write tools with `request_*` tools that file a request on disk, spawn a separate approver process that asks the user in a native Yes/No dialog, and return the recorded outcome.

**Architecture:** The MCP tool validates params, writes `requests/<id>.json`, spawns `bun scripts/approver.ts <id>` detached, and waits for it to exit (up to TTL + grace). The approver re-validates, shows a PowerShell (Windows) or `osascript` (macOS) dialog, and only on Approve claims `requests/<id>.result.json` exclusively and calls SmartAPI. The MCP process no longer contains any code that calls a write endpoint.

**Tech Stack:** Bun 1.3, TypeScript (strict, `noUncheckedIndexedAccess`), zod 4.6, `@modelcontextprotocol/sdk` 1.32, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-23-order-requests-design.md`

## Global Constraints

- Use Bun APIs (`Bun.file`, `Bun.write`, `Bun.spawn`, `Bun.sleep`); `node:fs/promises` only for `mkdir`, `readdir`, exclusive `writeFile(..., { flag: "wx" })`; `node:child_process` only for the detached approver spawn.
- No new dependencies.
- Request TTL: 120 000 ms. MCP wait: TTL + 30 000 ms grace.
- Request id: `YYYYMMDD-HHmmss-<4 hex>` in local time; timestamps inside files are `toISOString()` (UTC).
- Files: `<dir>/<id>.json` (request, written once), `<dir>/<id>.result.json` (written only by the approver), `<dir>/<id>.log` (approver stdout/stderr). `<dir>` = `ANGEL_REQUESTS_DIR` or `<project>/requests`, gitignored.
- Result `status`: `executing` | `executed` | `rejected` | `expired` | `failed`. Read-side adds `pending`.
- Dialog default button is Reject. Title/text reach the dialog through env vars `DIALOG_TITLE` / `DIALOG_TEXT`, never interpolated into the script. Use `Rs`, not `₹`, in dialog text.
- The approver never retries a SmartAPI call.
- Request tools are registered only when `ANGEL_ENABLE_TRADING=true`.
- Match the existing style: 2-space indent, double quotes, short comments only where they explain why; `const P = "/rest/secure/angelbroking";` per file that builds paths.
- Run the whole suite with `bun test` and types with `bunx tsc --noEmit`; both must be clean at the end of every task.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/config.ts` (modify) | Add `requestsDir`. |
| `src/requests/store.ts` (create) | Request/result files: ids, read/write, exclusive claim, listing, read-side status. |
| `src/tools/common.ts` (modify) | Shared enums (moved from `rest.ts`) and `withProgress` (moved from `stream.ts`). |
| `src/requests/actions.ts` (create) | The seven actions: title, endpoint, zod shape, body builder; validate + execute. |
| `src/requests/confirm.ts` (create) | Native Yes/No dialog per platform. |
| `src/requests/approve.ts` (create) | Approver logic: validate → dialog → claim → execute → record. |
| `src/requests/service.ts` (create) | MCP-side: submit/get/list requests; spawn the approver. |
| `scripts/approver.ts` (create) | CLI entry for the approver. |
| `src/tools/requests.ts` (create) | MCP tool registration for `request_*`, `get_request`, `list_requests`. |
| `src/tools/rest.ts` (modify) | Remove the seven write tools and the `enableTrading` parameter. |
| `src/tools/stream.ts` (modify) | Import `withProgress` from `common.ts`. |
| `index.ts` (modify) | Wire the request tools behind `ANGEL_ENABLE_TRADING`. |
| `README.md`, `.env.example`, `.gitignore` (modify) | Docs and config. |

---

### Task 1: Request store

**Files:**
- Modify: `src/config.ts`
- Modify: `.gitignore`
- Create: `src/requests/store.ts`
- Test: `src/requests/store.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `config.requestsDir: string`
  - `type RequestStatus = "executing" | "executed" | "rejected" | "expired" | "failed"`
  - `interface TradeRequest { id: string; action: string; createdAt: string; expiresAt: string; reason: string; params: Record<string, unknown> }`
  - `interface RequestResult { id: string; status: RequestStatus; decidedAt: string; ltp: number | null; response: unknown; order: unknown; error: string | null }`
  - `interface RequestView extends TradeRequest { status: RequestStatus | "pending"; result: RequestResult | null }`
  - `newId(now: Date): string`
  - `view(req: TradeRequest, result: RequestResult | null, now: Date): RequestView`
  - `class RequestStore { readonly dir: string; constructor(dir: string); write(req: TradeRequest): Promise<void>; read(id: string): Promise<TradeRequest | null>; readResult(id: string): Promise<RequestResult | null>; claim(result: RequestResult): Promise<boolean>; writeResult(result: RequestResult): Promise<void>; ids(limit: number): Promise<string[]>; logPath(id: string): string }` — every method that takes an id throws `Invalid request id: <id>` synchronously for ids not matching the id format.

- [ ] **Step 1: Write the failing test**

Create `src/requests/store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/requests/store.test.ts`
Expected: FAIL — `Cannot find module './store.ts'`.

- [ ] **Step 3: Implement**

Create `src/requests/store.ts`:

```ts
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
```

In `src/config.ts`, add this line to the `config` object after `enableTrading`:

```ts
  requestsDir: process.env.ANGEL_REQUESTS_DIR || join(import.meta.dir, "..", "requests"),
```

In `.gitignore`, append:

```
# order requests filed by Claude and their outcomes
/requests/
```

- [ ] **Step 4: Run tests**

Run: `bun test src/requests/store.test.ts && bunx tsc --noEmit`
Expected: 7 pass, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/requests/store.ts src/requests/store.test.ts src/config.ts .gitignore
git commit -m "Add request store for Claude-filed order requests"
```

---

### Task 2: Action definitions

**Files:**
- Modify: `src/tools/common.ts`
- Modify: `src/tools/rest.ts:8-11` (enum consts) and its import line
- Create: `src/requests/actions.ts`
- Test: `src/requests/actions.test.ts`

**Interfaces:**
- Consumes: `exchange` from `src/tools/common.ts`.
- Produces:
  - In `common.ts`: `transactionType`, `productType`, `orderType`, `variety` (zod enums, same values as today in `rest.ts`).
  - `interface Api { get<T = unknown>(path: string): Promise<T>; post<T = unknown>(path: string, body: unknown): Promise<T> }` (`SmartApi` satisfies it)
  - `ACTIONS` — object keyed by `place_order | modify_order | cancel_order | convert_position | create_gtt_rule | modify_gtt_rule | cancel_gtt_rule`, each `{ title: string; endpoint: string; shape: ZodRawShape; schema: ZodObject; body: (params) => unknown }`
  - `type ActionName = keyof typeof ACTIONS`
  - `isAction(name: string): name is ActionName`
  - `parseParams(name: ActionName, raw: unknown): Record<string, unknown>` (throws ZodError)
  - `safeParseParams(name: ActionName, raw: unknown)` (zod safe-parse result of `Record<string, unknown>`)
  - `executeAction(api: Api, name: ActionName, params: Record<string, unknown>): Promise<unknown>`

- [ ] **Step 1: Write the failing test**

Create `src/requests/actions.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/requests/actions.test.ts`
Expected: FAIL — `Cannot find module './actions.ts'`.

- [ ] **Step 3: Move the shared enums**

In `src/tools/common.ts`, below the `exchange` line, add:

```ts
export const transactionType = z.enum(["BUY", "SELL"]);
export const productType = z.enum(["DELIVERY", "CARRYFORWARD", "MARGIN", "INTRADAY", "BO"]);
export const orderType = z.enum(["MARKET", "LIMIT", "STOPLOSS_LIMIT", "STOPLOSS_MARKET"]);
export const variety = z.enum(["NORMAL", "STOPLOSS", "AMO", "ROBO"]);
```

In `src/tools/rest.ts`, delete the four `const transactionType/productType/orderType/variety = z.enum(...)` lines and change the import to:

```ts
import { exchange, orderType, productType, READ, transactionType, variety, wrap, WRITE } from "./common.ts";
```

- [ ] **Step 4: Implement actions**

Create `src/requests/actions.ts`:

```ts
import { z } from "zod";
import { exchange, orderType, productType, transactionType, variety } from "../tools/common.ts";

const P = "/rest/secure/angelbroking";

/** The part of SmartApi the request flow needs; tests pass a fake. */
export interface Api {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

// SmartAPI expects numeric order fields as strings.
const str = (v: number | undefined) => (v === undefined ? undefined : String(v));

function action<S extends z.ZodRawShape>(
  title: string,
  endpoint: string,
  shape: S,
  body: (a: z.output<z.ZodObject<S>>) => unknown = (a) => a,
) {
  return { title, endpoint, shape, schema: z.object(shape), body };
}

const gttExchange = z.enum(["NSE", "BSE"]);

export const ACTIONS = {
  place_order: action(
    "Place order",
    `${P}/order/v1/placeOrder`,
    {
      variety: variety.default("NORMAL"),
      tradingsymbol: z.string(),
      symboltoken: z.string(),
      exchange,
      transactiontype: transactionType,
      ordertype: orderType,
      producttype: productType,
      duration: z.enum(["DAY", "IOC"]).default("DAY"),
      quantity: z.number().int().positive(),
      price: z.number().nonnegative().optional().describe("Required for LIMIT / STOPLOSS_LIMIT"),
      triggerprice: z.number().nonnegative().optional().describe("Required for STOPLOSS orders"),
      squareoff: z.number().nonnegative().optional().describe("ROBO only"),
      stoploss: z.number().nonnegative().optional().describe("ROBO only"),
      disclosedquantity: z.number().int().nonnegative().optional(),
      ordertag: z.string().max(20).optional(),
    },
    (a) => ({
      ...a,
      quantity: str(a.quantity),
      price: str(a.price ?? 0),
      triggerprice: str(a.triggerprice),
      squareoff: str(a.squareoff),
      stoploss: str(a.stoploss),
      disclosedquantity: str(a.disclosedquantity),
    }),
  ),
  modify_order: action(
    "Modify order",
    `${P}/order/v1/modifyOrder`,
    {
      variety,
      orderid: z.string(),
      tradingsymbol: z.string(),
      symboltoken: z.string(),
      exchange,
      ordertype: orderType,
      producttype: productType,
      duration: z.enum(["DAY", "IOC"]).default("DAY"),
      quantity: z.number().int().positive(),
      price: z.number().nonnegative(),
      triggerprice: z.number().nonnegative().optional(),
    },
    (a) => ({ ...a, quantity: str(a.quantity), price: str(a.price), triggerprice: str(a.triggerprice) }),
  ),
  cancel_order: action("Cancel order", `${P}/order/v1/cancelOrder`, { variety, orderid: z.string() }),
  convert_position: action("Convert position", `${P}/order/v1/convertPosition`, {
    exchange,
    symboltoken: z.string(),
    tradingsymbol: z.string(),
    oldproducttype: productType,
    newproducttype: productType,
    transactiontype: transactionType,
    quantity: z.number().int().positive(),
    type: z.enum(["DAY", "CARRYFORWARD"]).default("DAY"),
  }),
  create_gtt_rule: action("Create GTT rule", `${P}/gtt/v1/createRule`, {
    tradingsymbol: z.string(),
    symboltoken: z.string(),
    exchange: gttExchange,
    transactiontype: transactionType,
    producttype: z.enum(["DELIVERY", "MARGIN"]),
    price: z.number().positive(),
    qty: z.number().int().positive(),
    triggerprice: z.number().positive(),
    disclosedqty: z.number().int().nonnegative().optional(),
  }),
  modify_gtt_rule: action("Modify GTT rule", `${P}/gtt/v1/modifyRule`, {
    id: z.string(),
    symboltoken: z.string(),
    exchange: gttExchange,
    price: z.number().positive(),
    qty: z.number().int().positive(),
    triggerprice: z.number().positive(),
    disclosedqty: z.number().int().nonnegative().optional(),
  }),
  cancel_gtt_rule: action("Cancel GTT rule", `${P}/gtt/v1/cancelRule`, {
    id: z.string(),
    symboltoken: z.string(),
    exchange: gttExchange,
  }),
};

export type ActionName = keyof typeof ACTIONS;

export function isAction(name: string): name is ActionName {
  return Object.hasOwn(ACTIONS, name);
}

// Each action's schema has its own type; callers only need a plain object back.
const schemaOf = (name: ActionName) => ACTIONS[name].schema as unknown as z.ZodType<Record<string, unknown>>;

/** Validates params for an action, applying defaults and dropping unknown keys. */
export function parseParams(name: ActionName, raw: unknown): Record<string, unknown> {
  return schemaOf(name).parse(raw);
}

export function safeParseParams(name: ActionName, raw: unknown) {
  return schemaOf(name).safeParse(raw);
}

/** Makes the SmartAPI call for already-validated params. */
export function executeAction(api: Api, name: ActionName, params: Record<string, unknown>): Promise<unknown> {
  const def = ACTIONS[name];
  return api.post(def.endpoint, (def.body as (a: Record<string, unknown>) => unknown)(params));
}
```

- [ ] **Step 5: Run tests**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass (existing 49 + new), no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/requests/actions.ts src/requests/actions.test.ts src/tools/common.ts src/tools/rest.ts
git commit -m "Define order actions with schemas and SmartAPI bodies"
```

---

### Task 3: Native confirmation dialog

**Files:**
- Create: `src/requests/confirm.ts`
- Test: `src/requests/confirm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type Decision = "approve" | "reject" | "timeout"`
  - `type Confirm = (title: string, text: string, timeoutSec: number) => Promise<Decision>`
  - `dialogCommand(platform: string, timeoutSec: number): string[]` (throws on unsupported platforms)
  - `parseDecision(platform: string, exitCode: number, stdout: string, stderr: string): Decision` (throws on anything unexpected)
  - `confirm: Confirm` (real implementation using `Bun.spawn`)

- [ ] **Step 1: Write the failing test**

Create `src/requests/confirm.test.ts`:

```ts
import { expect, test } from "bun:test";
import { dialogCommand, parseDecision } from "./confirm.ts";

test("windows uses a topmost WScript popup with No as default, reading text from env", () => {
  const cmd = dialogCommand("win32", 95.7);
  expect(cmd.slice(0, 4)).toEqual(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
  expect(cmd[4]).toBe(
    "(New-Object -ComObject WScript.Shell).Popup($env:DIALOG_TEXT, 95, $env:DIALOG_TITLE, 4 + 48 + 256 + 4096)",
  );
});

test("macOS uses display dialog with Reject as default and a give-up timeout", () => {
  const script = dialogCommand("darwin", 120).join(" ");
  expect(script.startsWith("osascript -e ")).toBe(true);
  expect(script).toContain('display dialog (system attribute "DIALOG_TEXT")');
  expect(script).toContain('with title (system attribute "DIALOG_TITLE")');
  expect(script).toContain('buttons {"Reject", "Approve"} default button "Reject"');
  expect(script).toContain("giving up after 120");
});

test("timeouts are whole seconds, at least 1", () => {
  expect(dialogCommand("darwin", 0.4).join(" ")).toContain("giving up after 1");
});

test("other platforms have no dialog", () => {
  expect(() => dialogCommand("linux", 60)).toThrow("No approval dialog for platform linux");
});

test("maps dialog output to a decision", () => {
  expect(parseDecision("win32", 0, "6\r\n", "")).toBe("approve");
  expect(parseDecision("win32", 0, "7\r\n", "")).toBe("reject");
  expect(parseDecision("win32", 0, "-1\r\n", "")).toBe("timeout");
  expect(parseDecision("darwin", 0, "Approve\n", "")).toBe("approve");
  expect(parseDecision("darwin", 0, "Reject\n", "")).toBe("reject");
  expect(parseDecision("darwin", 0, "timeout\n", "")).toBe("timeout");
});

test("anything unexpected is an error, never an approval", () => {
  expect(() => parseDecision("win32", 1, "", "COM failure")).toThrow("Approval dialog failed (exit 1): COM failure");
  expect(() => parseDecision("win32", 0, "1\r\n", "")).toThrow("Approval dialog failed");
  expect(() => parseDecision("darwin", 0, "6\n", "")).toThrow("Approval dialog failed");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/requests/confirm.test.ts`
Expected: FAIL — `Cannot find module './confirm.ts'`.

- [ ] **Step 3: Implement**

Create `src/requests/confirm.ts`:

```ts
export type Decision = "approve" | "reject" | "timeout";
export type Confirm = (title: string, text: string, timeoutSec: number) => Promise<Decision>;

/**
 * Command for a native Yes/No dialog. Title and text are read from the DIALOG_TITLE and
 * DIALOG_TEXT env vars, so symbols or reasons can't break the script's quoting.
 */
export function dialogCommand(platform: string, timeoutSec: number): string[] {
  const secs = Math.max(1, Math.floor(timeoutSec));
  if (platform === "win32") {
    // 4 Yes/No + 48 warning icon + 256 second button (No) is default + 4096 topmost.
    // Prints 6 for Yes, 7 for No, -1 on timeout.
    return [
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(New-Object -ComObject WScript.Shell).Popup($env:DIALOG_TEXT, ${secs}, $env:DIALOG_TITLE, 4 + 48 + 256 + 4096)`,
    ];
  }
  if (platform === "darwin") {
    return [
      "osascript",
      "-e",
      `set r to display dialog (system attribute "DIALOG_TEXT") with title (system attribute "DIALOG_TITLE") buttons {"Reject", "Approve"} default button "Reject" with icon caution giving up after ${secs}`,
      "-e",
      'if gave up of r then return "timeout"',
      "-e",
      "return button returned of r",
    ];
  }
  throw new Error(`No approval dialog for platform ${platform}; requests can only be approved on Windows or macOS`);
}

const ANSWERS: Record<string, Record<string, Decision>> = {
  win32: { "6": "approve", "7": "reject", "-1": "timeout" },
  darwin: { Approve: "approve", Reject: "reject", timeout: "timeout" },
};

export function parseDecision(platform: string, exitCode: number, stdout: string, stderr: string): Decision {
  const decision = exitCode === 0 ? ANSWERS[platform]?.[stdout.trim()] : undefined;
  if (decision) return decision;
  throw new Error(`Approval dialog failed (exit ${exitCode}): ${(stderr || stdout).trim().slice(0, 300)}`);
}

export const confirm: Confirm = async (title, text, timeoutSec) => {
  const proc = Bun.spawn(dialogCommand(process.platform, timeoutSec), {
    env: { ...process.env, DIALOG_TITLE: title, DIALOG_TEXT: text },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return parseDecision(process.platform, code, stdout, stderr);
};
```

- [ ] **Step 4: Run tests**

Run: `bun test src/requests/confirm.test.ts && bunx tsc --noEmit`
Expected: 6 pass, no type errors.

- [ ] **Step 5: Manual check on macOS (dialog really appears)**

Run:

```bash
bun -e 'import { confirm } from "./src/requests/confirm.ts"; console.log(await confirm("Angel One: test", "Click Reject", 30))'
```

Expected: a dialog with Reject/Approve appears; clicking Reject prints `reject`; rerun and wait 30 s prints `timeout`.

- [ ] **Step 6: Commit**

```bash
git add src/requests/confirm.ts src/requests/confirm.test.ts
git commit -m "Add native Yes/No approval dialog for Windows and macOS"
```

---

### Task 4: Approver logic

**Files:**
- Create: `src/requests/approve.ts`
- Test: `src/requests/approve.test.ts`

**Interfaces:**
- Consumes: `ACTIONS`, `isAction`, `safeParseParams`, `executeAction`, `Api` (Task 2); `Confirm`, `Decision` (Task 3); `RequestStore`, `RequestResult`, `RequestStatus`, `TradeRequest` (Task 1).
- Produces:
  - `interface ApproveDeps { api: Api; store: RequestStore; confirm: Confirm; now: () => Date; sleep?: (ms: number) => Promise<void> }`
  - `approve(id: string, deps: ApproveDeps): Promise<RequestResult>` — throws `No request <id>` if the request file is missing; otherwise always leaves a result file and returns it.
  - `describe(req: TradeRequest, title: string, params: Record<string, unknown>, ltp: number | null): string`

- [ ] **Step 1: Write the failing test**

Create `src/requests/approve.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/requests/approve.test.ts`
Expected: FAIL — `Cannot find module './approve.ts'`.

- [ ] **Step 3: Implement**

Create `src/requests/approve.ts`:

```ts
import { z } from "zod";
import { ACTIONS, executeAction, isAction, safeParseParams, type Api } from "./actions.ts";
import type { Confirm, Decision } from "./confirm.ts";
import type { RequestResult, RequestStatus, RequestStore, TradeRequest } from "./store.ts";

const P = "/rest/secure/angelbroking";

export interface ApproveDeps {
  api: Api;
  store: RequestStore;
  confirm: Confirm;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const rupees = (n: number) =>
  `Rs ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Last traded price for the dialog; null when the action has no instrument or the lookup fails. */
async function lastPrice(api: Api, params: Record<string, unknown>): Promise<number | null> {
  const { exchange, symboltoken } = params;
  if (typeof exchange !== "string" || typeof symboltoken !== "string") return null;
  try {
    const q = await api.post<{ fetched?: { ltp: number }[] }>(`${P}/market/v1/quote`, {
      mode: "LTP",
      exchangeTokens: { [exchange]: [symboltoken] },
    });
    return q?.fetched?.[0]?.ltp ?? null;
  } catch {
    return null;
  }
}

/** Order status shortly after the call, when the response names the order. */
async function orderDetails(api: Api, response: unknown, sleep: (ms: number) => Promise<void>): Promise<unknown> {
  const uid = (response as { uniqueorderid?: unknown } | null)?.uniqueorderid;
  if (typeof uid !== "string" || !uid) return null;
  await sleep(1000);
  return api.get(`${P}/order/v1/details/${encodeURIComponent(uid)}`).catch(() => null);
}

/** Dialog text: every param, the price context, and Claude's reason. */
export function describe(req: TradeRequest, title: string, params: Record<string, unknown>, ltp: number | null): string {
  const lines = [title, ""];
  for (const [k, v] of Object.entries(params)) if (v !== undefined) lines.push(`${k}: ${v}`);
  const qty = params.quantity ?? params.qty;
  const price = typeof params.price === "number" && params.price > 0 ? params.price : ltp;
  const context: string[] = [];
  if (ltp !== null) context.push(`Last price: ${rupees(ltp)}`);
  if (typeof qty === "number" && price !== null) context.push(`Approx. value: ${rupees(qty * price)}`);
  if (context.length) lines.push("", ...context);
  lines.push("", `Reason: ${req.reason}`, `Request: ${req.id}`);
  return lines.join("\n");
}

/** Shows one request to the user and executes it only on Approve. Every outcome is written as its result file. */
export async function approve(id: string, deps: ApproveDeps): Promise<RequestResult> {
  const { api, store, confirm, now, sleep = Bun.sleep } = deps;
  const req = await store.read(id);
  if (!req) throw new Error(`No request ${id}`);
  const existing = await store.readResult(id);
  if (existing) return existing;

  let ltp: number | null = null;
  const result = (status: RequestStatus, extra: Partial<RequestResult> = {}): RequestResult => ({
    id,
    status,
    decidedAt: now().toISOString(),
    ltp,
    response: null,
    order: null,
    error: null,
    ...extra,
  });
  // Outcomes that never touch the account; if someone else already decided, theirs stands.
  const finish = async (r: RequestResult) => ((await store.claim(r)) ? r : ((await store.readResult(id)) ?? r));

  if (!isAction(req.action)) return finish(result("failed", { error: `Unknown action ${req.action}` }));
  const parsed = safeParseParams(req.action, req.params);
  if (!parsed.success) return finish(result("failed", { error: z.prettifyError(parsed.error) }));
  const params = parsed.data;
  const title = ACTIONS[req.action].title;

  const expiresAt = Date.parse(req.expiresAt);
  const remainingSec = Math.floor((expiresAt - now().getTime()) / 1000);
  if (remainingSec <= 0) return finish(result("expired"));

  ltp = await lastPrice(api, params);
  let decision: Decision;
  try {
    decision = await confirm(`Angel One: ${title}`, describe(req, title, params, ltp), remainingSec);
  } catch (e) {
    return finish(result("failed", { error: message(e) }));
  }
  if (decision === "reject") return finish(result("rejected"));
  if (decision === "timeout" || now().getTime() >= expiresAt) return finish(result("expired"));

  // Claim before calling SmartAPI so the same request can never execute twice.
  const executing = result("executing");
  if (!(await store.claim(executing))) return (await store.readResult(id)) ?? executing;
  let final: RequestResult;
  try {
    const response = await executeAction(api, req.action, params);
    final = result("executed", { response, order: await orderDetails(api, response, sleep) });
  } catch (e) {
    final = result("failed", { error: message(e) });
  }
  await store.writeResult(final);
  return final;
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/requests/approve.test.ts && bunx tsc --noEmit`
Expected: 11 pass, no type errors. If `Approx. value: Rs 1,624.80` fails on formatting, print `(1624.8).toLocaleString("en-IN", { minimumFractionDigits: 2 })` under `bun -e` and fix the expected string, not the code.

- [ ] **Step 5: Commit**

```bash
git add src/requests/approve.ts src/requests/approve.test.ts
git commit -m "Add approver: dialog, exclusive claim, execute, record outcome"
```

---

### Task 5: Request service, approver spawn and CLI

**Files:**
- Create: `src/requests/service.ts`
- Create: `scripts/approver.ts`
- Test: `src/requests/service.test.ts`

**Interfaces:**
- Consumes: `parseParams`, `ActionName` (Task 2); `RequestStore`, `newId`, `view`, `RequestView`, `RequestStatus`, `TradeRequest` (Task 1); `approve` (Task 4); `confirm` (Task 3); `config.requestsDir` (Task 1).
- Produces:
  - `type Launch = (id: string) => Promise<void>` — resolves when the approver exits; rejects if it can't start.
  - `interface Submitted { id: string; waitMs: number; settled: Promise<void> }` — `settled` resolves when the approver exits or `waitMs` passes, whichever is first; rejects if the launch fails.
  - `interface RequestSummary { id: string; action: string; status: RequestStatus | "pending"; createdAt: string; reason: string }`
  - `class RequestService { constructor(opts: { store: RequestStore; launch: Launch; now?: () => Date; ttlMs?: number; graceMs?: number }); submit(action: ActionName, raw: unknown, reason: string): Promise<Submitted>; get(id: string): Promise<RequestView>; list(limit: number): Promise<RequestSummary[]> }` — defaults: `now = () => new Date()`, `ttlMs = 120_000`, `graceMs = 30_000`.
  - `spawnApprover(script: string, store: RequestStore): Launch`

- [ ] **Step 1: Write the failing test**

Create `src/requests/service.test.ts`:

```ts
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
  const svc = new RequestService({ store, launch: async () => { throw new Error("spawn bun ENOENT"); } });
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/requests/service.test.ts`
Expected: FAIL — `Cannot find module './service.ts'`.

- [ ] **Step 3: Implement the service**

Create `src/requests/service.ts`:

```ts
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
```

- [ ] **Step 4: Implement the approver CLI**

Create `scripts/approver.ts`:

```ts
// Shows one Claude-filed request in a native dialog and executes it only if you click Approve.
// The MCP server spawns this per request; you can also run it by hand: bun scripts/approver.ts <request-id>
import { config } from "../src/config.ts";
import { approve } from "../src/requests/approve.ts";
import { confirm } from "../src/requests/confirm.ts";
import { RequestStore } from "../src/requests/store.ts";
import { SmartApi } from "../src/smartapi.ts";

const id = Bun.argv[2];
if (!id) {
  console.error("Usage: bun scripts/approver.ts <request-id>");
  process.exit(1);
}

try {
  const result = await approve(id, {
    api: new SmartApi(config),
    store: new RequestStore(config.requestsDir),
    confirm,
    now: () => new Date(),
  });
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
```

- [ ] **Step 5: Run tests**

Run: `bun test && bunx tsc --noEmit`
Expected: all pass, no type errors.

- [ ] **Step 6: Manual end-to-end check of the approver on macOS (no order sent)**

```bash
mkdir -p requests
cat > requests/20261023-120000-abcd.json <<EOF
{ "id": "20261023-120000-abcd", "action": "cancel_order",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "expiresAt": "$(date -u -v+2M +%Y-%m-%dT%H:%M:%S.000Z)",
  "reason": "Manual approver test - click Reject",
  "params": { "variety": "NORMAL", "orderid": "0" } }
EOF
bun scripts/approver.ts 20261023-120000-abcd
```

Expected: a dialog showing `Cancel order`, `orderid: 0`, the reason. Click **Reject**. Output JSON has `"status": "rejected"`, and `requests/20261023-120000-abcd.result.json` exists. Then `rm requests/20261023-120000-abcd*`.

- [ ] **Step 7: Commit**

```bash
git add src/requests/service.ts src/requests/service.test.ts scripts/approver.ts
git commit -m "Add request service and approver entry point"
```

---

### Task 6: MCP tools, remove direct write tools, docs

**Files:**
- Modify: `src/tools/common.ts` (add `withProgress`, `ProgressExtra`)
- Modify: `src/tools/stream.ts` (remove its `withProgress`/`ProgressExtra`, import from common)
- Create: `src/tools/requests.ts`
- Modify: `src/tools/rest.ts` (remove write tools and `enableTrading` param)
- Modify: `index.ts`
- Modify: `README.md`, `.env.example`
- Test: `src/tools/requests.test.ts`

**Interfaces:**
- Consumes: `ACTIONS`, `ActionName` (Task 2); `RequestService`, `spawnApprover` (Task 5); `RequestStore` (Task 1); `config.requestsDir`, `config.enableTrading`.
- Produces:
  - `withProgress<T>(work: Promise<T>, totalMs: number, extra: ProgressExtra, message: string): Promise<T>` and `interface ProgressExtra` exported from `src/tools/common.ts`.
  - `registerRequestTools(server: McpServer, requests: RequestService): void`
  - `registerRestTools(server: McpServer, api: SmartApi): void` (no third parameter).

- [ ] **Step 1: Write the failing test**

Create `src/tools/requests.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestService } from "../requests/service.ts";
import { RequestStore } from "../requests/store.ts";
import type { SmartApi } from "../smartapi.ts";
import { registerRequestTools } from "./requests.ts";
import { registerRestTools } from "./rest.ts";

const WRITE_TOOLS = [
  "place_order",
  "modify_order",
  "cancel_order",
  "convert_position",
  "create_gtt_rule",
  "modify_gtt_rule",
  "cancel_gtt_rule",
];

let dir: string;
let store: RequestStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tools-"));
  store = new RequestStore(dir);
});

afterEach(() => rm(dir, { recursive: true, force: true }));

async function connect(register: (s: McpServer) => void) {
  const server = new McpServer({ name: "test", version: "0" });
  register(server);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const json = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0]!.text);

test("rest tools no longer include any direct write tool", async () => {
  const client = await connect((s) => registerRestTools(s, {} as SmartApi));
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names).toContain("get_order_book");
  for (const n of WRITE_TOOLS) expect(names).not.toContain(n);
});

test("request tools file a request, wait for the approver and return the outcome", async () => {
  const svc = new RequestService({
    store,
    launch: async (id) => {
      await store.claim({
        id,
        status: "rejected",
        decidedAt: new Date().toISOString(),
        ltp: null,
        response: null,
        order: null,
        error: null,
      });
    },
  });
  const client = await connect((s) => registerRequestTools(s, svc));
  const names = (await client.listTools()).tools.map((t) => t.name);
  expect(names.sort()).toEqual([...WRITE_TOOLS.map((n) => `request_${n}`), "get_request", "list_requests"].sort());

  const filed = json(
    await client.callTool({
      name: "request_cancel_order",
      arguments: { variety: "NORMAL", orderid: "1", reason: "Stop out" },
    }),
  );
  expect(filed).toMatchObject({
    action: "cancel_order",
    status: "rejected",
    reason: "Stop out",
    params: { variety: "NORMAL", orderid: "1" },
  });

  const got = json(await client.callTool({ name: "get_request", arguments: { id: filed.id } }));
  expect(got.status).toBe("rejected");

  const listed = json(await client.callTool({ name: "list_requests", arguments: {} }));
  expect(listed).toEqual([expect.objectContaining({ id: filed.id, status: "rejected", reason: "Stop out" })]);
});

test("a request without a reason is refused and nothing is filed", async () => {
  const svc = new RequestService({ store, launch: async () => {} });
  const client = await connect((s) => registerRequestTools(s, svc));
  const r = await client
    .callTool({ name: "request_cancel_order", arguments: { variety: "NORMAL", orderid: "1" } })
    .catch(() => ({ isError: true }));
  expect((r as { isError?: boolean }).isError).toBe(true);
  expect(await store.ids(10)).toEqual([]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/tools/requests.test.ts`
Expected: FAIL — `Cannot find module './requests.ts'`.

- [ ] **Step 3: Move `withProgress` to common.ts**

In `src/tools/stream.ts`, cut the `ProgressExtra` interface and the `withProgress` function (with its doc comment) and the `PROGRESS_EVERY_MS` constant, and paste them into `src/tools/common.ts` with `export` added to `interface ProgressExtra` and `function withProgress`. Move the `import type { ServerNotification } from "@modelcontextprotocol/sdk/types.js";` line to `common.ts` too. In `stream.ts`, change the common import to:

```ts
import { exchange, READ, run, withProgress, wrap } from "./common.ts";
```

Run: `bun test && bunx tsc --noEmit` — expect everything still passing except the new `requests.test.ts`.

- [ ] **Step 4: Implement the request tools**

Create `src/tools/requests.ts`:

```ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ACTIONS, type ActionName } from "../requests/actions.ts";
import type { RequestService } from "../requests/service.ts";
import { READ, run, withProgress, wrap } from "./common.ts";

// Filing a request doesn't change the account; the user's click in the dialog does.
const REQUEST = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;

const reason = z
  .string()
  .min(1)
  .describe("Why you want this, in one sentence. Shown to the user in the approval dialog.");

export function registerRequestTools(server: McpServer, requests: RequestService) {
  for (const name of Object.keys(ACTIONS) as ActionName[]) {
    const def = ACTIONS[name];
    server.registerTool(
      `request_${name}`,
      {
        description: `Ask the user to approve: ${def.title}. Opens a Yes/No dialog on their screen and waits up to 2.5 minutes for their answer; only on Yes does a separate approver process make the real SmartAPI call. Returns the request with status executed, rejected, expired, failed, or pending (still undecided; check later with get_request). Get tradingsymbol/symboltoken from search_scrip.`,
        inputSchema: { ...(def.shape as z.ZodRawShape), reason },
        annotations: REQUEST,
      },
      (args, extra) =>
        run(async () => {
          const { reason, ...params } = args;
          const filed = await requests.submit(name, params, String(reason));
          await withProgress(filed.settled, filed.waitMs, extra, "waiting for the user to approve");
          return requests.get(filed.id);
        }),
    );
  }

  server.registerTool(
    "get_request",
    {
      description: "Status and outcome of an order request filed with a request_* tool.",
      inputSchema: { id: z.string() },
      annotations: READ,
    },
    wrap(({ id }) => requests.get(id)),
  );

  server.registerTool(
    "list_requests",
    {
      description: "Recent order requests, newest first, with their status.",
      inputSchema: { limit: z.number().int().positive().max(100).default(20) },
      annotations: READ,
    },
    wrap(({ limit }) => requests.list(limit)),
  );
}
```

- [ ] **Step 5: Remove the direct write tools**

In `src/tools/rest.ts`:
- Delete everything from the `if (!enableTrading) return;` line through the end of the `cancel_gtt_rule` registration (keep the function's closing `}`).
- Delete the `// SmartAPI expects numeric order fields as strings.` comment and the `str` helper.
- Change the signature to `export function registerRestTools(server: McpServer, api: SmartApi) {`.
- Change the import to `import { exchange, productType, READ, transactionType, wrap } from "./common.ts";`.
- In `get_order_details`, change the description's `(from the order book or place_order)` to `(from the order book or request_place_order)`.

In `src/tools/common.ts`, delete the now-unused `WRITE` export.

- [ ] **Step 6: Wire it in index.ts**

In `index.ts`, add imports:

```ts
import { join } from "node:path";
import { RequestService, spawnApprover } from "./src/requests/service.ts";
import { RequestStore } from "./src/requests/store.ts";
import { registerRequestTools } from "./src/tools/requests.ts";
```

Replace `registerRestTools(server, api, config.enableTrading);` with:

```ts
registerRestTools(server, api);
if (config.enableTrading) {
  // Claude only files requests; scripts/approver.ts asks you and makes the call.
  const store = new RequestStore(config.requestsDir);
  const launch = spawnApprover(join(import.meta.dir, "scripts", "approver.ts"), store);
  registerRequestTools(server, new RequestService({ store, launch }));
}
```

Change the ready log line to:

```ts
log(`MCP server ready (order requests ${config.enableTrading ? "ENABLED" : "disabled"})`);
```

- [ ] **Step 7: Run tests and type check**

Run: `bun test && bunx tsc --noEmit && grep -rn "placeOrder\|modifyOrder\|cancelOrder\|convertPosition\|createRule\|modifyRule\|cancelRule" index.ts src/tools`
Expected: all tests pass, no type errors, and the grep prints nothing (no write endpoint reachable from the MCP's tool code).

- [ ] **Step 8: Docs**

In `.env.example`, replace the `ANGEL_ENABLE_TRADING` comment and line with:

```
# Set to true to let Claude file order requests (request_* tools). Nothing is sent
# until you click Yes/Approve in the dialog that scripts/approver.ts shows.
ANGEL_ENABLE_TRADING=false
# Optional: folder for order requests, results and approver logs (default: ./requests)
# ANGEL_REQUESTS_DIR=
```

In `README.md`, replace the whole `## Trading` section with:

```markdown
## Trading

With `ANGEL_ENABLE_TRADING=true`, Claude gets `request_place_order`, `request_modify_order`, `request_cancel_order`, `request_convert_position`, `request_create_gtt_rule`, `request_modify_gtt_rule` and `request_cancel_gtt_rule`. Claude can't change your account directly:

1. The tool writes `requests/<id>.json` with the parameters and Claude's reason, and starts `scripts/approver.ts`.
2. The approver shows a Yes/No dialog (a PowerShell popup on Windows, `osascript` on macOS) with the order, the last price and the reason. The default button is No/Reject.
3. Only Yes/Approve sends it to Angel One. Unanswered requests expire after 2 minutes.
4. The outcome is written to `requests/<id>.result.json` and returned to Claude. `get_request` and `list_requests` read it later; the approver's output is in `requests/<id>.log`.

To re-run the dialog for a pending request yourself: `bun scripts/approver.ts <id>`.

The direct tools these replace are documented in [docs/removed-write-tools.md](docs/removed-write-tools.md).
```

- [ ] **Step 9: Commit**

```bash
git add src/tools/common.ts src/tools/stream.ts src/tools/requests.ts src/tools/requests.test.ts src/tools/rest.ts index.ts README.md .env.example
git commit -m "Replace direct write tools with approval-gated order requests"
```

---

### Task 7: Manual verification on Windows

**Files:** none (verification only; fix-ups get their own commits).

- [ ] **Step 1: Set up on the Windows laptop**

```powershell
git pull
bun install
bun test
```

Set `ANGEL_ENABLE_TRADING=true` in `.env`, then restart the MCP client so it reloads the server.

- [ ] **Step 2: Dialog smoke test (no order)**

```powershell
bun -e "import { confirm } from './src/requests/confirm.ts'; console.log(await confirm('Angel One: test', 'Click No', 30))"
```

Expected: a topmost Yes/No popup appears. No prints `reject`; waiting 30 s prints `timeout`. If no popup appears, remove `windowsHide: true` from the `Bun.spawn` call in `src/requests/confirm.ts`, retest, and commit that change.

- [ ] **Step 3: Reject path, during market hours**

Ask Claude: "Request a 1-share LIMIT BUY of SBIN-EQ on NSE, INTRADAY, at a price 10% below LTP." Click **No**.
Expected: the tool returns `status: "rejected"`; `get_order_book` shows no new order; `requests\<id>.result.json` exists.

- [ ] **Step 4: Approve path**

Repeat and click **Yes**.
Expected: `status: "executed"`, `response.orderid` is set, and `order.status` shows an open order. It also appears in `get_order_book`.

- [ ] **Step 5: Cancel it through a request**

Ask Claude to `request_cancel_order` that order id and click **Yes**.
Expected: `status: "executed"`; the order book shows the order cancelled.

- [ ] **Step 6: Detached-process check**

File one more request, and while its dialog is open, restart the MCP client. Click **No**.
Expected: `requests\<id>.result.json` is written with `rejected`, and after the restart `get_request(<id>)` returns it.
