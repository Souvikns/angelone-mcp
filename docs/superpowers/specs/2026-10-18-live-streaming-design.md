# Live streaming (WebSocket) — design

Date: 2026-10-18
Status: approved in brainstorming, pending spec review

## Goal

Let Claude answer questions like "which stocks have momentum right now?" by watching
a set of instruments live for a few minutes and reading a computed per-symbol
summary, and let it follow the user's own order status changes.

MCP tools are request → response, so the server holds the WebSocket connections and
aggregates data in memory; tools start watches and read summaries.

## Scope

In:
- SmartAPI WebSocket 2.0 market feed (`wss://smartapisocket.angelone.in/smart-stream`), modes LTP (1), Quote (2), SnapQuote (3).
- Order update feed (`wss://tns.angelone.in/smart-order-update`).
- Watch sessions with momentum metrics; buffered order events.

Out (YAGNI):
- Depth mode (4, 20-level depth).
- Persisting ticks across MCP server restarts; a separate daemon process.
- Server-side alerts / price-condition triggers.
- Symbol universes (NIFTY50 etc.) — Claude picks symbols per request via `search_scrip`.

## Protocol facts (from the official smartapi-javascript SDK)

Both sockets authenticate with headers:
- Market feed: `Authorization: <jwt>`, `x-api-key`, `x-client-code`, `x-feed-token`.
- Order feed: `Authorization: Bearer <jwt>`, `x-api-key`, `x-client-code`, `x-feed-token`.

`feedToken` comes from the existing `loginByPassword` response. Bun's built-in
`WebSocket` accepts a `headers` option, so no extra dependency.

Heartbeat: client sends text `ping` every 10s; server replies `pong`. No message for
20s means the connection is stale.

Subscribe request (JSON text frame):

```json
{ "correlationID": "w1", "action": 1, "params": { "mode": 2, "tokenList": [{ "exchangeType": 1, "tokens": ["3045"] }] } }
```

`action`: 1 subscribe, 0 unsubscribe. Exchange types: NSE→1 (nse_cm), NFO→2 (nse_fo),
BSE→3 (bse_cm), BFO→4 (bse_fo), MCX→5 (mcx_fo), NCDEX→7 (ncx_fo), CDS→13 (cde_fo).
Cap: 1000 tokens per connection.

Binary tick packets, little-endian. Prices are integers in paise (÷100), except CDS (÷10^7).

| Offset | Size | Field | Modes |
|---|---|---|---|
| 0 | 1 | subscription mode | all |
| 1 | 1 | exchange type | all |
| 2 | 25 | token (ASCII, NUL-padded) | all |
| 27 | 8 | sequence number | all |
| 35 | 8 | exchange timestamp (ms) | all |
| 43 | 8 | last traded price | all |
| 51 | 8 | last traded quantity | Quote, Snap |
| 59 | 8 | average traded price | Quote, Snap |
| 67 | 8 | volume traded today (cumulative) | Quote, Snap |
| 75 | 8 | total buy quantity (float64) | Quote, Snap |
| 83 | 8 | total sell quantity (float64) | Quote, Snap |
| 91 | 8 | open | Quote, Snap |
| 99 | 8 | high | Quote, Snap |
| 107 | 8 | low | Quote, Snap |
| 115 | 8 | close (previous day) | Quote, Snap |
| 123 | 8 | last traded timestamp | Snap |
| 131 | 8 | open interest | Snap |
| 139 | 8 | OI change % (float64) | Snap |
| 147 | 200 | best 5 buy / best 5 sell | Snap (not decoded) |
| 347 | 8 | upper circuit | Snap |
| 355 | 8 | lower circuit | Snap |
| 363 | 8 | 52-week high | Snap |
| 371 | 8 | 52-week low | Snap |

Packet sizes: LTP 51, Quote 123, SnapQuote 379 bytes. Text frames (`pong`, JSON errors)
are handled separately.

Order feed messages are JSON objects (e.g. `order-status`, `orderData`); they are
stored as received.

## Components

- `src/feed/protocol.ts` — pure: exchange-type mapping, subscribe/unsubscribe message
  builders, binary tick decoder → `Tick { exchange, token, mode, ltp, ltq?, atp?, volume?, buyQty?, sellQty?, open?, high?, low?, close?, oi?, exchangeTs }`.
- `src/feed/market.ts` — `MarketFeed`: one market WebSocket. Lazy connect on first
  subscription, disconnect when none remain. Ref-counted subscriptions keyed by
  `exchange:token` (highest requested mode wins). Ping every 10s, stale after 20s,
  reconnect with backoff 1s→30s and re-subscribe. Emits ticks and status changes
  (`connected` / `reconnecting` / `error` + reason). Takes a socket factory so tests
  can inject a fake.
- `src/feed/orders.ts` — `OrderFeed`: order WebSocket, connects on first use, keeps a
  ring buffer of the last 500 events with increasing sequence numbers. Same
  heartbeat/reconnect behaviour.
- `src/watch.ts` — `WatchManager`: creates/stops watches, routes ticks to watches,
  keeps per-symbol accumulators, enforces limits, expires idle watches.
- `src/momentum.ts` — pure: accumulator update and summary metric computation.
- `src/smartapi.ts` — stores `feedToken` from login; exposes `session()` returning
  `{ jwt, feedToken, apiKey, clientCode }` after ensuring a login, and `relogin()`.
- `src/tools/rest.ts` — existing REST tools moved from `src/tools.ts` unchanged.
- `src/tools/stream.ts` — the new tools.

## Tools

| Tool | Input | Output |
|---|---|---|
| `start_watch` | `symbols: [{ exchange, symboltoken }]` (1–1000), `mode: "QUOTE" \| "LTP"` (default QUOTE), `label?` | `watch_id`, `subscribed[]` (with tradingsymbol), `rejected[]` with reason |
| `get_watch_summary` | `watch_id`, `wait_seconds` 0–600 (default 0), `sort_by: "change" \| "volume" \| "vs_vwap" \| "buy_sell_ratio"` (default change), `limit` (default all) | `elapsed_seconds`, `feed_status`, `gaps[]`, `note?`, `symbols[]` |
| `stop_watch` | `watch_id` | `{ stopped: true }` |
| `list_watches` | — | `[{ watch_id, label, age_seconds, symbols }]` |
| `get_order_updates` | `since?` (sequence number), `wait_seconds` 0–300 (default 0) | `events[]`, `next_since`, `feed_status` |

`wait_seconds` on `get_watch_summary` waits until `watch start + wait_seconds`
(returns immediately if already past). On `get_order_updates` it waits until at least
one event newer than `since` arrives or the timeout passes. While waiting, the server
sends MCP progress notifications every 15s when the client supplied a progress token.

### Per-symbol summary

| Field | Meaning |
|---|---|
| `tradingsymbol`, `exchange`, `token` | identity (tradingsymbol from the baseline quote) |
| `ltp` | latest price |
| `change_pct_window` | (ltp − first price in window) / first price × 100 |
| `change_pct_day` | (ltp − previous close) / previous close × 100 |
| `vwap_window` | Σ(price × Δvolume) / ΣΔvolume over the window (QUOTE mode) |
| `ltp_vs_vwap_pct` | (ltp − vwap_window) / vwap_window × 100 |
| `volume_window` | latest cumulative volume − first cumulative volume seen in window |
| `volume_per_min` | volume_window / elapsed minutes |
| `buy_sell_ratio` | latest total buy qty / total sell qty |
| `uptick_ratio` | upticks / (upticks + downticks) |
| `high_window`, `low_window` | extremes of ltp in window |
| `ticks` | ticks received |

QUOTE-only fields are `null` in LTP mode. Baseline price before the first tick comes
from the REST quote taken in `start_watch`.

## Data flow

1. `start_watch` validates limits, fetches a REST quote (LTP mode, batches of 50,
   sequential) for tradingsymbols and baseline prices, creates the watch, and
   subscribes via `MarketFeed`.
2. `MarketFeed` decodes each binary frame and emits a `Tick`; `WatchManager` routes it
   by `exchange:token` to every watch containing the symbol and updates accumulators.
3. `get_watch_summary` optionally waits, then computes metrics with `momentum.ts`,
   sorts, truncates to `limit`, and marks the watch as read (resets idle timer).
4. `stop_watch` / idle expiry releases subscriptions; the feed disconnects when none remain.
5. `get_order_updates` lazily connects `OrderFeed` and returns buffered events after `since`.

## Limits

- 1000 subscribed instruments across all watches (unique `exchange:token`).
- 5 concurrent watches.
- Watches not read for 30 minutes stop automatically.
- `start_watch` rejects before subscribing when a limit would be exceeded.

## Error handling

- Market closed: no ticks; pong keeps the socket alive. Summary includes
  `note: "no ticks received — market may be closed (NSE 09:15–15:30 IST)"` when a
  watch has zero ticks after ≥30s.
- Disconnect: reconnect with backoff 1s, 2s, 4s… capped at 30s; re-subscribe all.
  Each watch records `gaps: [{ from, to }]` covering disconnected periods.
- Auth failure (401 on upgrade or socket closed before open twice in a row): call
  `SmartApi.relogin()` for a fresh JWT and feedToken, reconnect once; if that fails,
  status becomes `error` with the reason. Status is shown in summaries and order updates.
- JSON error frames from the server: logged to stderr and stored as `feed_status.last_error`.
- Unknown token: never ticks; shows `ticks: 0`.
- Shutdown: on stdin close / SIGINT / SIGTERM, close both sockets and exit.

## Testing

Unit (`bun test`, no network):
- `protocol.test.ts`: hand-built LTP/Quote/SnapQuote buffers per the offset table;
  every decoded field, paise→rupee, CDS divisor, NUL-padded token; subscribe JSON.
- `momentum.test.ts`: scripted tick sequences → change %, VWAP, window volume from
  cumulative volume, uptick ratio, sorting.
- `watch.test.ts` with a fake feed: shared subscriptions ref-counted, unsubscribe on
  stop, 5-watch and 1000-token limits, idle expiry (injected clock), gap recording.
- `market.test.ts` with a fake socket: reconnect backoff, re-subscribe on reconnect,
  status transitions, relogin on auth failure.

Live (manual, against the user's account):
- Today (Sunday): both sockets authenticate and stay up via ping/pong; subscribe is
  accepted; summary returns zero ticks with the market-closed note.
- Next trading day: 1–2 minute watch on ~10 liquid NSE stocks; decoded prices match
  `get_quote`.

No orders are placed during testing.
