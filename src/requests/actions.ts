import { z } from "zod";
import { exchange, orderType, productType, transactionType, variety } from "../tools/common.ts";

const P = "/rest/secure/angelbroking";

/** The part of SmartApi the request flow needs; tests pass a fake. */
export interface Api {
  get<T = unknown>(path: string): Promise<T>;
  post<T = unknown>(path: string, body: unknown): Promise<T>;
}

// SmartAPI expects numeric order fields as strings.
const str = (v: number | undefined) => (v === undefined ? undefined : String(v));

function action<S extends z.ZodRawShape>(
  title: string,
  endpoint: string,
  shape: S,
  body: (a: z.output<z.ZodObject<S>>) => unknown = (a) => a,
) {
  return { title, endpoint, shape, schema: z.object(shape), body };
}

const gttExchange = z.enum(["NSE", "BSE"]);

export const ACTIONS = {
  place_order: action(
    "Place order",
    `${P}/order/v1/placeOrder`,
    {
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
    (a) => ({
      ...a,
      quantity: str(a.quantity),
      price: str(a.price ?? 0),
      triggerprice: str(a.triggerprice),
      squareoff: str(a.squareoff),
      stoploss: str(a.stoploss),
      disclosedquantity: str(a.disclosedquantity),
    }),
  ),
  modify_order: action(
    "Modify order",
    `${P}/order/v1/modifyOrder`,
    {
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
    (a) => ({ ...a, quantity: str(a.quantity), price: str(a.price), triggerprice: str(a.triggerprice) }),
  ),
  cancel_order: action("Cancel order", `${P}/order/v1/cancelOrder`, { variety, orderid: z.string() }),
  convert_position: action("Convert position", `${P}/order/v1/convertPosition`, {
    exchange,
    symboltoken: z.string(),
    tradingsymbol: z.string(),
    oldproducttype: productType,
    newproducttype: productType,
    transactiontype: transactionType,
    quantity: z.number().int().positive(),
    type: z.enum(["DAY", "CARRYFORWARD"]).default("DAY"),
  }),
  create_gtt_rule: action("Create GTT rule", `${P}/gtt/v1/createRule`, {
    tradingsymbol: z.string(),
    symboltoken: z.string(),
    exchange: gttExchange,
    transactiontype: transactionType,
    producttype: z.enum(["DELIVERY", "MARGIN"]),
    price: z.number().positive(),
    qty: z.number().int().positive(),
    triggerprice: z.number().positive(),
    disclosedqty: z.number().int().nonnegative().optional(),
  }),
  modify_gtt_rule: action("Modify GTT rule", `${P}/gtt/v1/modifyRule`, {
    id: z.string(),
    symboltoken: z.string(),
    exchange: gttExchange,
    price: z.number().positive(),
    qty: z.number().int().positive(),
    triggerprice: z.number().positive(),
    disclosedqty: z.number().int().nonnegative().optional(),
  }),
  cancel_gtt_rule: action("Cancel GTT rule", `${P}/gtt/v1/cancelRule`, {
    id: z.string(),
    symboltoken: z.string(),
    exchange: gttExchange,
  }),
};

export type ActionName = keyof typeof ACTIONS;

export function isAction(name: string): name is ActionName {
  return Object.hasOwn(ACTIONS, name);
}

// Each action's schema has its own type; callers only need a plain object back.
const schemaOf = (name: ActionName) => ACTIONS[name].schema as unknown as z.ZodType<Record<string, unknown>>;

/** Validates params for an action, applying defaults and dropping unknown keys. */
export function parseParams(name: ActionName, raw: unknown): Record<string, unknown> {
  return schemaOf(name).parse(raw);
}

export function safeParseParams(name: ActionName, raw: unknown) {
  return schemaOf(name).safeParse(raw);
}

/** Makes the SmartAPI call for already-validated params. */
export function executeAction(api: Api, name: ActionName, params: Record<string, unknown>): Promise<unknown> {
  const def = ACTIONS[name];
  return api.post(def.endpoint, (def.body as (a: Record<string, unknown>) => unknown)(params));
}
