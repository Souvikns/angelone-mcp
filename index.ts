import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "./src/config.ts";
import { SmartApi } from "./src/smartapi.ts";
import { registerTools } from "./src/tools.ts";

// stdout carries the MCP protocol — log only to stderr.
const api = new SmartApi(config);
const server = new McpServer({ name: "angelone", version: "0.1.0" });
registerTools(server, api, config.enableTrading);

await server.connect(new StdioServerTransport());
console.error(`angelone MCP server ready (trading ${config.enableTrading ? "ENABLED" : "disabled"})`);
