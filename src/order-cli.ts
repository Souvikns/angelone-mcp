import { parseArgs } from "node:util";

const SIDES = ["BUY", "SELL"] as const;
const EXCHANGES = ["NSE", "BSE", "NFO", "BFO", "MCX", "CDS", "NCDEX"] as const;
const ORDER_TYPES = ["MARKET", "LIMIT", "STOPLOSS_LIMIT", "STOPLOSS_MARKET"] as const;
const PRODUCTS = ["DELIVERY", "INTRADAY", "CARRYFORWARD", "MARGIN"] as const;

export interface OrderRequest {
  side: (typeof SIDES)[number];
  tradingsymbol: string;
  quantity: number;
  exchange: (typeof EXCHANGES)[number];
  ordertype: (typeof ORDER_TYPES)[number];
  producttype: (typeof PRODUCTS)[number];
  price: number | undefined;
  triggerprice: number | undefined;
  symboltoken: string | undefined;
  amo: boolean;
  dryRun: boolean;
}

export const USAGE = `Usage: bun scripts/order.ts <BUY|SELL> <TRADINGSYMBOL> <QTY> --product <${PRODUCTS.join("|")}>
       [--exchange NSE] [--type ${ORDER_TYPES.join("|")}] [--price N] [--trigger N]
       [--token SYMBOLTOKEN] [--amo] [--dry-run]

Example: bun scripts/order.ts BUY SBIN-EQ 1 --product INTRADAY`;

function oneOf<T extends string>(value: string, allowed: readonly T[], name: string): T {
  const v = value.toUpperCase();
  if (!(allowed as readonly string[]).includes(v)) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  return v as T;
}

function positive(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}

export function parseOrderArgs(argv: string[]): OrderRequest {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      exchange: { type: "string", default: "NSE" },
      type: { type: "string", default: "MARKET" },
      product: { type: "string" },
      price: { type: "string" },
      trigger: { type: "string" },
      token: { type: "string" },
      amo: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (positionals.length !== 3) throw new Error(USAGE);
  const [side, symbol, qty] = positionals as [string, string, string];
  if (!values.product) throw new Error("--product is required");

  const quantity = Number(qty);
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("QTY must be a positive whole number");

  const ordertype = oneOf(values.type, ORDER_TYPES, "--type");
  const price = positive(values.price, "--price");
  const triggerprice = positive(values.trigger, "--trigger");
  if ((ordertype === "LIMIT" || ordertype === "STOPLOSS_LIMIT") && price === undefined) {
    throw new Error(`--price is required for ${ordertype}`);
  }
  if (ordertype.startsWith("STOPLOSS") && triggerprice === undefined) {
    throw new Error(`--trigger is required for ${ordertype}`);
  }

  return {
    side: oneOf(side, SIDES, "Side"),
    tradingsymbol: symbol.toUpperCase(),
    quantity,
    exchange: oneOf(values.exchange, EXCHANGES, "--exchange"),
    ordertype,
    producttype: oneOf(values.product, PRODUCTS, "--product"),
    price,
    triggerprice,
    symboltoken: values.token,
    amo: values.amo,
    dryRun: values["dry-run"],
  };
}

/** Request body for SmartAPI placeOrder; numeric fields are sent as strings. */
export function orderBody(o: OrderRequest, symboltoken: string) {
  return {
    variety: o.amo ? "AMO" : o.ordertype.startsWith("STOPLOSS") ? "STOPLOSS" : "NORMAL",
    tradingsymbol: o.tradingsymbol,
    symboltoken,
    exchange: o.exchange,
    transactiontype: o.side,
    ordertype: o.ordertype,
    producttype: o.producttype,
    duration: "DAY",
    quantity: String(o.quantity),
    price: String(o.price ?? 0),
    triggerprice: String(o.triggerprice ?? 0),
  };
}
