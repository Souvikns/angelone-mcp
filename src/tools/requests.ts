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
