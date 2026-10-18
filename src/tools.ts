import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { SmartApi } from "./smartapi.ts";

const P = "/rest/secure/angelbroking";

const exchange = z.enum(["NSE", "BSE", "NFO", "BFO", "MCX", "CDS", "NCDEX"]);
const transactionType = z.enum(["BUY", "SELL"]);
const productType = z.enum(["DELIVERY", "CARRYFORWARD", "MARGIN", "INTRADAY", "BO"]);
const orderType = z.enum(["MARKET", "LIMIT", "STOPLOSS_LIMIT", "STOPLOSS_MARKET"]);
const variety = z.enum(["NORMAL", "STOPLOSS", "AMO", "ROBO"]);
const interval = z.enum([
  "ONE_MINUTE",
  "THREE_MINUTE",
  "FIVE_MINUTE",
  "TEN_MINUTE",
  "FIFTEEN_MINUTE",
  "THIRTY_MINUTE",
  "ONE_HOUR",
  "ONE_DAY",
]);
const dateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "Use 'yyyy-MM-dd HH:mm' (IST)")
  .describe("IST timestamp, format 'yyyy-MM-dd HH:mm'");
const expiryType = z.enum(["NEAR", "NEXT", "FAR"]);

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const WRITE = { readOnlyHint: false, destructiveHint: true, openWorldHint: true } as const;

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data ?? null, null, 2) }] };
}

function fail(e: unknown) {
  return { isError: true, content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }] };
}

const wrap =
  <A>(fn: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return ok(await fn(args));
    } catch (e) {
      return fail(e);
    }
  };

// SmartAPI expects numeric order fields as strings.
const str = (v: number | undefined) => (v === undefined ? undefined : String(v));

export function registerTools(server: McpServer, api: SmartApi, enableTrading: boolean) {
  // ---------- Account ----------
  server.registerTool(
    "get_profile",
    { description: "Get the Angel One user profile (name, email, enabled exchanges and products).", annotations: READ },
    wrap(() => api.get(`${P}/user/v1/getProfile`)),
  );

  server.registerTool(
    "get_funds",
    { description: "Get funds and margin (RMS limits): net, available cash, utilised margin, etc.", annotations: READ },
    wrap(() => api.get(`${P}/user/v1/getRMS`)),
  );

  // ---------- Portfolio ----------
  server.registerTool(
    "get_holdings",
    { description: "Get long-term equity holdings (per-stock list).", annotations: READ },
    wrap(() => api.get(`${P}/portfolio/v1/getHolding`)),
  );

  server.registerTool(
    "get_all_holdings",
    { description: "Get holdings with portfolio totals (total value, P&L, P&L %).", annotations: READ },
    wrap(() => api.get(`${P}/portfolio/v1/getAllHolding`)),
  );

  server.registerTool(
    "get_positions",
    { description: "Get today's net and day positions.", annotations: READ },
    wrap(() => api.get(`${P}/order/v1/getPosition`)),
  );

  // ---------- Orders (read) ----------
  server.registerTool(
    "get_order_book",
    { description: "List all orders placed today with their status.", annotations: READ },
    wrap(() => api.get(`${P}/order/v1/getOrderBook`)),
  );

  server.registerTool(
    "get_trade_book",
    { description: "List all trades executed today.", annotations: READ },
    wrap(() => api.get(`${P}/order/v1/getTradeBook`)),
  );

  server.registerTool(
    "get_order_details",
    {
      description: "Get the status of a single order by its uniqueorderid (from the order book or place_order).",
      inputSchema: { uniqueorderid: z.string() },
      annotations: READ,
    },
    wrap(({ uniqueorderid }) => api.get(`${P}/order/v1/details/${encodeURIComponent(uniqueorderid)}`)),
  );

  // ---------- Instruments & market data ----------
  server.registerTool(
    "search_scrip",
    {
      description:
        "Search instruments by name to find tradingsymbol and symboltoken, which every market-data and order tool needs.",
      inputSchema: { exchange, searchscrip: z.string().describe("Search text, e.g. 'SBIN' or 'NIFTY'") },
      annotations: READ,
    },
    wrap((args) => api.post(`${P}/order/v1/searchScrip`, args)),
  );

  server.registerTool(
    "get_quote",
    {
      description:
        "Live market quote for up to 50 instruments. LTP = last price only, OHLC = adds open/high/low/close, FULL = adds depth, volume, circuit limits, 52-week range.",
      inputSchema: {
        mode: z.enum(["LTP", "OHLC", "FULL"]).default("FULL"),
        exchangeTokens: z
          .partialRecord(exchange, z.array(z.string()))
          .describe('Map of exchange to symboltokens, e.g. {"NSE": ["3045", "2885"]}'),
      },
      annotations: READ,
    },
    wrap((args) => api.post(`${P}/market/v1/quote`, args)),
  );

  server.registerTool(
    "get_candle_data",
    {
      description:
        "Historical OHLCV candles. Each row is [timestamp, open, high, low, close, volume]. Max range per call depends on interval (e.g. 30 days for ONE_MINUTE, 2000 days for ONE_DAY).",
      inputSchema: { exchange, symboltoken: z.string(), interval, fromdate: dateTime, todate: dateTime },
      annotations: READ,
    },
    wrap((args) => api.post(`${P}/historical/v1/getCandleData`, args)),
  );

  server.registerTool(
    "get_oi_data",
    {
      description: "Historical open interest for an F&O contract (NFO/BFO/MCX/CDS).",
      inputSchema: { exchange, symboltoken: z.string(), interval, fromdate: dateTime, todate: dateTime },
      annotations: READ,
    },
    wrap((args) => api.post(`${P}/historical/v1/getOIData`, args)),
  );

  server.registerTool(
    "get_option_greeks",
    {
      description: "Option Greeks (delta, gamma, theta, vega, IV) for all strikes of an underlying and expiry.",
      inputSchema: {
        name: z.string().describe("Underlying, e.g. 'NIFTY' or 'TCS'"),
        expirydate: z.string().describe("Expiry as DDMMMYYYY, e.g. '25JAN2024'"),
      },
      annotations: READ,
    },
    wrap((args) => api.post(`${P}/marketData/v1/optionGreek`, args)),
  );

  server.registerTool(
    "get_gainers_losers",
    {
      description: "Top F&O gainers/losers by price or open interest change.",
      inputSchema: {
        datatype: z.enum(["PercOIGainers", "PercOILosers", "PercPriceGainers", "PercPriceLosers"]),
        expirytype: expiryType,
      },
      annotations: READ,
    },
    wrap((args) => api.post(`${P}/marketData/v1/gainersLosers`, args)),
  );

  server.registerTool(
    "get_put_call_ratio",
    { description: "Put-call ratio for F&O underlyings.", annotations: READ },
    wrap(() => api.get(`${P}/marketData/v1/putCallRatio`)),
  );

  server.registerTool(
    "get_oi_buildup",
    {
      description: "F&O contracts showing long/short build-up or unwinding.",
      inputSchema: {
        datatype: z.enum(["Long Built Up", "Short Built Up", "Short Covering", "Long Unwinding"]),
        expirytype: expiryType,
      },
      annotations: READ,
    },
    wrap((args) => api.post(`${P}/marketData/v1/OIBuildup`, args)),
  );

  // ---------- Margin & charges ----------
  server.registerTool(
    "calculate_margin",
    {
      description: "Calculate required margin for a basket of hypothetical positions (does not place orders).",
      inputSchema: {
        positions: z.array(
          z.object({
            exchange,
            token: z.string().describe("symboltoken"),
            qty: z.number().int().positive(),
            price: z.number().nonnegative(),
            productType: productType,
            tradeType: transactionType,
            orderType: z.enum(["MARKET", "LIMIT"]),
          }),
        ),
      },
      annotations: READ,
    },
    wrap((args) => api.post(`${P}/margin/v1/batch`, args)),
  );

  server.registerTool(
    "estimate_charges",
    {
      description: "Estimate brokerage, taxes and other charges for hypothetical orders.",
      inputSchema: {
        orders: z.array(
          z.object({
            product_type: productType,
            transaction_type: transactionType,
            quantity: z.string(),
            price: z.string(),
            exchange,
            symbol_name: z.string(),
            token: z.string(),
          }),
        ),
      },
      annotations: READ,
    },
    wrap((args) => api.post(`${P}/brokerage/v1/estimateCharges`, args)),
  );

  // ---------- GTT (read) ----------
  server.registerTool(
    "list_gtt_rules",
    {
      description: "List GTT (good-till-triggered) rules.",
      inputSchema: {
        status: z
          .array(z.enum(["NEW", "CANCELLED", "ACTIVE", "SENTTOEXCHANGE", "FORALL"]))
          .default(["FORALL"]),
        page: z.number().int().positive().default(1),
        count: z.number().int().positive().max(500).default(50),
      },
      annotations: READ,
    },
    wrap((args) => api.post(`${P}/gtt/v1/ruleList`, args)),
  );

  server.registerTool(
    "get_gtt_rule",
    { description: "Get details of one GTT rule.", inputSchema: { id: z.string() }, annotations: READ },
    wrap((args) => api.post(`${P}/gtt/v1/ruleDetails`, args)),
  );

  if (!enableTrading) return;

  // ---------- Trading (only with ANGEL_ENABLE_TRADING=true) ----------
  server.registerTool(
    "place_order",
    {
      description:
        "PLACES A REAL ORDER with real money. Always confirm the exact order with the user first. Use search_scrip for tradingsymbol/symboltoken.",
      inputSchema: {
        variety: variety.default("NORMAL"),
        tradingsymbol: z.string(),
        symboltoken: z.string(),
        exchange,
        transactiontype: transactionType,
        ordertype: orderType,
        producttype: productType,
        duration: z.enum(["DAY", "IOC"]).default("DAY"),
        quantity: z.number().int().positive(),
        price: z.number().nonnegative().optional().describe("Required for LIMIT / STOPLOSS_LIMIT"),
        triggerprice: z.number().nonnegative().optional().describe("Required for STOPLOSS orders"),
        squareoff: z.number().nonnegative().optional().describe("ROBO only"),
        stoploss: z.number().nonnegative().optional().describe("ROBO only"),
        disclosedquantity: z.number().int().nonnegative().optional(),
        ordertag: z.string().max(20).optional(),
      },
      annotations: WRITE,
    },
    wrap((a) =>
      api.post(`${P}/order/v1/placeOrder`, {
        ...a,
        quantity: str(a.quantity),
        price: str(a.price ?? 0),
        triggerprice: str(a.triggerprice),
        squareoff: str(a.squareoff),
        stoploss: str(a.stoploss),
        disclosedquantity: str(a.disclosedquantity),
      }),
    ),
  );

  server.registerTool(
    "modify_order",
    {
      description: "MODIFIES A REAL OPEN ORDER. Confirm with the user first.",
      inputSchema: {
        variety,
        orderid: z.string(),
        tradingsymbol: z.string(),
        symboltoken: z.string(),
        exchange,
        ordertype: orderType,
        producttype: productType,
        duration: z.enum(["DAY", "IOC"]).default("DAY"),
        quantity: z.number().int().positive(),
        price: z.number().nonnegative(),
        triggerprice: z.number().nonnegative().optional(),
      },
      annotations: WRITE,
    },
    wrap((a) =>
      api.post(`${P}/order/v1/modifyOrder`, {
        ...a,
        quantity: str(a.quantity),
        price: str(a.price),
        triggerprice: str(a.triggerprice),
      }),
    ),
  );

  server.registerTool(
    "cancel_order",
    {
      description: "CANCELS A REAL OPEN ORDER. Confirm with the user first.",
      inputSchema: { variety, orderid: z.string() },
      annotations: WRITE,
    },
    wrap((args) => api.post(`${P}/order/v1/cancelOrder`, args)),
  );

  server.registerTool(
    "convert_position",
    {
      description: "Converts an open position's product type (e.g. INTRADAY to DELIVERY). Confirm with the user first.",
      inputSchema: {
        exchange,
        symboltoken: z.string(),
        tradingsymbol: z.string(),
        oldproducttype: productType,
        newproducttype: productType,
        transactiontype: transactionType,
        quantity: z.number().int().positive(),
        type: z.enum(["DAY", "CARRYFORWARD"]).default("DAY"),
      },
      annotations: WRITE,
    },
    wrap((args) => api.post(`${P}/order/v1/convertPosition`, args)),
  );

  server.registerTool(
    "create_gtt_rule",
    {
      description: "Creates a real GTT rule that places an order when the trigger price is hit. Confirm with the user first.",
      inputSchema: {
        tradingsymbol: z.string(),
        symboltoken: z.string(),
        exchange: z.enum(["NSE", "BSE"]),
        transactiontype: transactionType,
        producttype: z.enum(["DELIVERY", "MARGIN"]),
        price: z.number().positive(),
        qty: z.number().int().positive(),
        triggerprice: z.number().positive(),
        disclosedqty: z.number().int().nonnegative().optional(),
      },
      annotations: WRITE,
    },
    wrap((args) => api.post(`${P}/gtt/v1/createRule`, args)),
  );

  server.registerTool(
    "modify_gtt_rule",
    {
      description: "Modifies a real GTT rule. Confirm with the user first.",
      inputSchema: {
        id: z.string(),
        symboltoken: z.string(),
        exchange: z.enum(["NSE", "BSE"]),
        price: z.number().positive(),
        qty: z.number().int().positive(),
        triggerprice: z.number().positive(),
        disclosedqty: z.number().int().nonnegative().optional(),
      },
      annotations: WRITE,
    },
    wrap((args) => api.post(`${P}/gtt/v1/modifyRule`, args)),
  );

  server.registerTool(
    "cancel_gtt_rule",
    {
      description: "Cancels a real GTT rule. Confirm with the user first.",
      inputSchema: { id: z.string(), symboltoken: z.string(), exchange: z.enum(["NSE", "BSE"]) },
      annotations: WRITE,
    },
    wrap((args) => api.post(`${P}/gtt/v1/cancelRule`, args)),
  );
}
