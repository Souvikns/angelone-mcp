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

## Live streaming

The server keeps Angel One's WebSocket feeds open while it runs:

- `start_watch` — stream up to 1000 instruments (get tokens from `search_scrip`) and accumulate per-symbol stats.
- `get_watch_summary` — % change over the window and day, price vs VWAP, window volume, buy/sell ratio, uptick ratio. `wait_seconds: 300` returns after a 5-minute window.
- `stop_watch`, `list_watches` — manage watches (max 5; unread watches stop after 30 minutes).
- `get_order_updates` — your own order status changes as they happen.

Ticks only flow during market hours (NSE 09:15–15:30 IST).

## Placing orders from the terminal

`scripts/order.ts` places a real order yourself, without going through Claude. It looks up the token and last price, shows the order, and sends it only after you type `YES`:

```sh
bun scripts/order.ts BUY SBIN-EQ 1 --product INTRADAY
bun scripts/order.ts SELL RELIANCE-EQ 5 --product DELIVERY --type LIMIT --price 1250
bun scripts/order.ts BUY SBIN-EQ 1 --product INTRADAY --dry-run   # show the request, send nothing
```

Run it with no arguments for all options. It doesn't depend on `ANGEL_ENABLE_TRADING`.

## Trading

With `ANGEL_ENABLE_TRADING=true`, Claude gets `request_place_order`, `request_modify_order`, `request_cancel_order`, `request_convert_position`, `request_create_gtt_rule`, `request_modify_gtt_rule` and `request_cancel_gtt_rule`. Claude can't change your account directly:

1. The tool writes `requests/<id>.json` with the parameters and Claude's reason, and starts `scripts/approver.ts`.
2. The approver shows a Yes/No dialog (a PowerShell popup on Windows, `osascript` on macOS) with the order, the last price and the reason. The default button is No/Reject.
3. Only Yes/Approve sends it to Angel One. Unanswered requests expire after 2 minutes.
4. The outcome is written to `requests/<id>.result.json` and returned to Claude. `get_request` and `list_requests` read it later; the approver's output is in `requests/<id>.log`.

To re-run the dialog for a pending request yourself: `bun scripts/approver.ts <id>`.

The direct tools these replace are documented in [docs/removed-write-tools.md](docs/removed-write-tools.md).

## Tests

`bun test`
