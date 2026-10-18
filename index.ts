import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./src/config.ts";
import { MarketFeed } from "./src/feed/market.ts";
import { OrderFeed } from "./src/feed/orders.ts";
import { SmartApi } from "./src/smartapi.ts";
import { registerRestTools } from "./src/tools/rest.ts";
import { quoteBaseline, registerStreamTools } from "./src/tools/stream.ts";
import { WatchManager } from "./src/watch.ts";

// stdout carries the MCP protocol — log only to stderr.
const log = (msg: string) => console.error(`[angelone] ${msg}`);

const api = new SmartApi(config);
const feedOptions = { getSession: () => api.session(), relogin: () => api.relogin(), log };
const market = new MarketFeed(feedOptions);
const orders = new OrderFeed(feedOptions);
const watches = new WatchManager({ feed: market, fetchBaseline: quoteBaseline(api) });

const server = new McpServer({ name: "angelone", version: "0.2.0" });
registerRestTools(server, api, config.enableTrading);
registerStreamTools(server, { watches, orders });

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  watches.dispose();
  market.close();
  orders.close();
  process.exit(0);
}
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
log(`MCP server ready (trading ${config.enableTrading ? "ENABLED" : "disabled"})`);
