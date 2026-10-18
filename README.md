# angelone-mcp — Angel One SmartAPI MCP server

A stdio MCP server exposing Angel One SmartAPI (account, portfolio, orders, market data, GTT) to Claude.

## Setup

1. `bun install`
2. `cp .env.example .env` and fill in:
   - `ANGEL_API_KEY` — from https://smartapi.angelone.in/ → My Apps
   - `ANGEL_CLIENT_CODE` — your client ID
   - `ANGEL_PIN` — your MPIN
   - `ANGEL_TOTP_SECRET` — base32 secret from https://smartapi.angelone.in/enable-totp
3. Register it with Claude Code:

   ```sh
   claude mcp add angelone -- bun /absolute/path/to/angelone-mcp/index.ts
   ```

   Or in Claude Desktop's `claude_desktop_config.json`:

   ```json
   { "mcpServers": { "angelone": { "command": "bun", "args": ["/absolute/path/to/angelone-mcp/index.ts"] } } }
   ```

The server reads `.env` from this directory, logs in lazily with an auto-generated TOTP, and re-logs in when the session expires.

## Trading

Order tools (`place_order`, `modify_order`, `cancel_order`, `convert_position`, GTT create/modify/cancel) are only registered when `ANGEL_ENABLE_TRADING=true`. They act on your real account.

## Tests

`bun test`
