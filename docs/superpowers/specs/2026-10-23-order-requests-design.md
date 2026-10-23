# Order requests with out-of-process approval — design

Date: 2026-10-23
Status: approved in brainstorming, pending spec review

## Goal

Claude must never change the account directly. Instead of the seven write tools
(`place_order`, `modify_order`, `cancel_order`, `convert_position`,
`create_gtt_rule`, `modify_gtt_rule`, `cancel_gtt_rule`), Claude files a request.
A separate approver process shows it to the user in a native dialog, executes it
only on an explicit click, and records what happened. The MCP tool waits for that
process and returns the outcome in the same call.

Target machine is a Windows laptop; development happens on macOS, so both need to work.

## Scope

In:
- Request/result files on disk as the interface between the MCP and the approver.
- `scripts/approver.ts`, spawned once per request by the MCP server.
- Native yes/no dialog: PowerShell on Windows, `osascript` on macOS.
- MCP tools to file requests and to read their outcomes later.

Out (YAGNI):
- A long-running approver daemon or HTTP service.
- Auto-approval rules (max quantity, value limits, symbol allowlists).
- Batching several requests into one dialog.
- Linux dialog support.
- Changes to `scripts/order.ts` (stays as the manual CLI path).

## Flow

1. Claude calls e.g. `request_place_order({ ..., reason })`.
2. The tool validates `params` with the action's zod schema, writes
   `requests/<id>.json`, and spawns `bun scripts/approver.ts <id>` (detached, so a
   restart of the MCP server doesn't kill an open dialog).
3. The approver:
   1. Reads and re-validates the request with the same schema. Invalid → `failed`.
   2. If `expiresAt` has passed → `expired`.
   3. Fetches LTP for the instrument where the action has a symbol token (for display only; a failed lookup doesn't block).
   4. Shows the dialog with a timeout of `expiresAt - now`. Default button is Reject.
   5. Reject → `rejected`; timeout → `expired`.
   6. Approve → creates `requests/<id>.result.json` exclusively (`flag: "wx"`) with
      status `executing`. If the file already exists, it stops without calling the API.
   7. Calls SmartAPI. For order actions with an `orderid`/`uniqueorderid` in the
      response, waits ~1s and fetches order details.
   8. Overwrites the result with `executed` (or `failed` with the error).
4. The tool waits for the approver to exit, up to `expiresAt` + 30s, then reads the
   result file and returns it. If there's no result yet it returns
   `{ id, status: "pending" }`, and Claude follows up with `get_request(id)`.

## Files

Folder: `requests/` at the project root, overridable with `ANGEL_REQUESTS_DIR`.
Added to `.gitignore`.

- `<id>.json` — the request. Written once by the MCP tool, never modified.
- `<id>.result.json` — the outcome. Written only by the approver.

A request with no result file is pending; once past `expiresAt` it is reported as
`expired` by the read tools (computed, not written).

Id: `YYYYMMDD-HHmmss-<4 hex>` (local time), so files sort chronologically.

Request:

```json
{
  "id": "20261023-101530-a1b2",
  "action": "place_order",
  "createdAt": "2026-10-23T10:15:30.000+05:30",
  "expiresAt": "2026-10-23T10:17:30.000+05:30",
  "reason": "Breakout above VWAP on rising volume",
  "params": {
    "variety": "NORMAL", "tradingsymbol": "SBIN-EQ", "symboltoken": "3045",
    "exchange": "NSE", "transactiontype": "BUY", "ordertype": "MARKET",
    "producttype": "INTRADAY", "duration": "DAY", "quantity": 1
  }
}
```

`params` has exactly the shape of today's tool input for that action (after zod defaults).

Result:

```json
{
  "id": "20261023-101530-a1b2",
  "status": "executed",
  "decidedAt": "2026-10-23T10:15:52.000+05:30",
  "ltp": 812.4,
  "response": { "orderid": "241023000123456", "uniqueorderid": "..." },
  "order": { "status": "complete", "text": "" },
  "error": null
}
```

`status`: `executing` | `executed` | `rejected` | `expired` | `failed`.
An `executing` result that never finishes means the approver died mid-call; the
user checks the order book. The approver never retries.

## Dialog

Text lists the action, every param that matters for that action, LTP and
approximate value (quantity × price or LTP) when known, and Claude's `reason`.

- Windows: `powershell -NoProfile -Command` with
  `(New-Object -ComObject WScript.Shell).Popup(text, seconds, title, 4 + 48 + 256 + 4096)`
  (Yes/No, warning icon, second button default, topmost). Returns 6 Yes, 7 No, -1 timeout.
- macOS: `osascript -e 'display dialog … buttons {"Reject","Approve"} default button "Reject" giving up after N'`.

Text is passed via an environment variable, not interpolated into the script,
so symbols or reasons can't break quoting.

## Components

- `src/requests/actions.ts` — for each of the seven actions: zod input schema
  (moved from `src/tools/rest.ts`), a `describe(params)` for the dialog, and an
  `execute(api, params)` that makes the SmartAPI call (bodies moved from `rest.ts`).
- `src/requests/store.ts` — `newId`, `writeRequest`, `readRequest`, `readResult`,
  `claimResult` (exclusive create), `writeResult`, `listRequests`. Dir is a parameter.
- `src/requests/confirm.ts` — `confirm(title, text, timeoutSec): Promise<"approve" | "reject" | "timeout">`,
  picking the Windows or macOS implementation from `process.platform`; throws on others.
- `src/requests/approve.ts` — the approver steps above as a function taking
  `{ api, store, confirm, now }`, so tests can inject fakes.
- `scripts/approver.ts` — thin entry: builds real deps, runs `approve(id)`.
- `src/tools/requests.ts` — MCP tools:
  - `request_place_order`, `request_modify_order`, `request_cancel_order`,
    `request_convert_position`, `request_create_gtt_rule`, `request_modify_gtt_rule`,
    `request_cancel_gtt_rule` — each takes the action's params plus a required `reason`.
  - `get_request(id)` — request plus result (or computed pending/expired).
  - `list_requests({ limit })` — newest first, default 20.
- `src/tools/rest.ts` — the seven direct write tools are removed.
- `index.ts` — registers request tools when `ANGEL_ENABLE_TRADING=true`.

The MCP server process keeps no code path that calls a write endpoint.

## Error handling

- Invalid params at the tool → MCP error, nothing written.
- Approver can't spawn → tool returns an error; request stays and expires.
- Approver exits without a result → tool returns `pending`; read tools later report `expired`.
- Dialog unavailable (unsupported platform, PowerShell missing) → `failed` with the reason.
- SmartAPI error → `failed` with the message; never retried.

## Testing

- `actions`: schema defaults and the request bodies produced (numbers as strings), against a fake API.
- `store`: round-trip, exclusive claim fails the second time, list ordering, computed expiry.
- `approve`: approve/reject/timeout/expired/invalid/already-claimed paths with fake
  `confirm`, fake API and fixed clock; executed result includes order details.
- `confirm`: builds the right command per platform (spawn mocked); no real dialog in tests.
- Manual, on Windows during market hours: have Claude request a 1-share LIMIT BUY
  priced well below LTP and click Reject (expect `rejected`, nothing in the order
  book); repeat and click Approve (expect `executed` with an open order); then
  `request_cancel_order` it and approve.

## Docs

`docs/removed-write-tools.md` documents each removed tool (params, endpoint) and its
`request_*` replacement. README "Trading" section rewritten for the request flow and
links to it; `.env.example` gains
`ANGEL_REQUESTS_DIR` and the `ANGEL_ENABLE_TRADING` comment is updated.
