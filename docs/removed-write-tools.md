# Removed direct write tools

Until 2026-10-23 the MCP server exposed seven tools that changed the Angel One
account directly when `ANGEL_ENABLE_TRADING=true`. They are removed: the MCP
process no longer calls any write endpoint. Claude now files a request with the
matching `request_*` tool, and `scripts/approver.ts` executes it only after you
click Approve in a native dialog. See
[the design](superpowers/specs/2026-10-23-order-requests-design.md).

Each request tool takes the same parameters as the removed tool, plus a required
`reason` shown in the dialog. Numeric fields are sent to SmartAPI as strings.

Base path for all endpoints: `/rest/secure/angelbroking`.

| Removed tool | Replacement | SmartAPI endpoint |
|---|---|---|
| `place_order` | `request_place_order` | `POST /order/v1/placeOrder` |
| `modify_order` | `request_modify_order` | `POST /order/v1/modifyOrder` |
| `cancel_order` | `request_cancel_order` | `POST /order/v1/cancelOrder` |
| `convert_position` | `request_convert_position` | `POST /order/v1/convertPosition` |
| `create_gtt_rule` | `request_create_gtt_rule` | `POST /gtt/v1/createRule` |
| `modify_gtt_rule` | `request_modify_gtt_rule` | `POST /gtt/v1/modifyRule` |
| `cancel_gtt_rule` | `request_cancel_gtt_rule` | `POST /gtt/v1/cancelRule` |

Shared enums:

- `exchange`: `NSE`, `BSE`, `NFO`, `BFO`, `MCX`, `CDS`, `NCDEX`
- `transactiontype`: `BUY`, `SELL`
- `producttype`: `DELIVERY`, `CARRYFORWARD`, `MARGIN`, `INTRADAY`, `BO`
- `ordertype`: `MARKET`, `LIMIT`, `STOPLOSS_LIMIT`, `STOPLOSS_MARKET`
- `variety`: `NORMAL`, `STOPLOSS`, `AMO`, `ROBO`

## place_order

Placed a real order. Get `tradingsymbol` and `symboltoken` from `search_scrip`.

| Param | Type | Notes |
|---|---|---|
| `variety` | variety | Default `NORMAL` |
| `tradingsymbol` | string | e.g. `SBIN-EQ` |
| `symboltoken` | string | e.g. `3045` |
| `exchange` | exchange | |
| `transactiontype` | transactiontype | |
| `ordertype` | ordertype | |
| `producttype` | producttype | |
| `duration` | `DAY` \| `IOC` | Default `DAY` |
| `quantity` | positive integer | |
| `price` | number ≥ 0, optional | Required for `LIMIT` / `STOPLOSS_LIMIT`; sent as `0` when omitted |
| `triggerprice` | number ≥ 0, optional | Required for `STOPLOSS` orders |
| `squareoff` | number ≥ 0, optional | `ROBO` only |
| `stoploss` | number ≥ 0, optional | `ROBO` only |
| `disclosedquantity` | integer ≥ 0, optional | |
| `ordertag` | string ≤ 20 chars, optional | |

Response contains `orderid` and `uniqueorderid`; status comes from `get_order_details`.

## modify_order

Modified an open order.

| Param | Type | Notes |
|---|---|---|
| `variety` | variety | Required |
| `orderid` | string | From the order book |
| `tradingsymbol` | string | |
| `symboltoken` | string | |
| `exchange` | exchange | |
| `ordertype` | ordertype | |
| `producttype` | producttype | |
| `duration` | `DAY` \| `IOC` | Default `DAY` |
| `quantity` | positive integer | |
| `price` | number ≥ 0 | Required |
| `triggerprice` | number ≥ 0, optional | |

## cancel_order

Cancelled an open order.

| Param | Type |
|---|---|
| `variety` | variety |
| `orderid` | string |

## convert_position

Changed an open position's product type, e.g. `INTRADAY` to `DELIVERY`.

| Param | Type | Notes |
|---|---|---|
| `exchange` | exchange | |
| `symboltoken` | string | |
| `tradingsymbol` | string | |
| `oldproducttype` | producttype | |
| `newproducttype` | producttype | |
| `transactiontype` | transactiontype | |
| `quantity` | positive integer | |
| `type` | `DAY` \| `CARRYFORWARD` | Default `DAY` |

## create_gtt_rule

Created a good-till-triggered rule that places an order when the trigger price is hit.

| Param | Type |
|---|---|
| `tradingsymbol` | string |
| `symboltoken` | string |
| `exchange` | `NSE` \| `BSE` |
| `transactiontype` | transactiontype |
| `producttype` | `DELIVERY` \| `MARGIN` |
| `price` | positive number |
| `qty` | positive integer |
| `triggerprice` | positive number |
| `disclosedqty` | integer ≥ 0, optional |

## modify_gtt_rule

Modified a GTT rule.

| Param | Type |
|---|---|
| `id` | string (rule id from `list_gtt_rules`) |
| `symboltoken` | string |
| `exchange` | `NSE` \| `BSE` |
| `price` | positive number |
| `qty` | positive integer |
| `triggerprice` | positive number |
| `disclosedqty` | integer ≥ 0, optional |

## cancel_gtt_rule

Cancelled a GTT rule.

| Param | Type |
|---|---|
| `id` | string |
| `symboltoken` | string |
| `exchange` | `NSE` \| `BSE` |
