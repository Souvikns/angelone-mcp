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
