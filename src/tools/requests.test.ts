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
