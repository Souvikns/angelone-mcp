import { expect, test } from "bun:test";
import { orderBody, parseOrderArgs } from "./order-cli.ts";

const argv = (s: string) => s.split(" ");

test("parses a market order with defaults", () => {
  expect(parseOrderArgs(argv("buy sbin-eq 2 --product intraday"))).toEqual({
    side: "BUY",
    tradingsymbol: "SBIN-EQ",
    quantity: 2,
    exchange: "NSE",
    ordertype: "MARKET",
    producttype: "INTRADAY",
    price: undefined,
    triggerprice: undefined,
    symboltoken: undefined,
    amo: false,
    dryRun: false,
  });
});

test("parses limit, exchange, token and flags", () => {
  const o = parseOrderArgs(
    argv("SELL RELIANCE 5 --product DELIVERY --type LIMIT --price 1210.5 --exchange BSE --token 500325 --amo --dry-run"),
  );
  expect(o).toMatchObject({
    side: "SELL",
    exchange: "BSE",
    ordertype: "LIMIT",
    price: 1210.5,
    symboltoken: "500325",
    amo: true,
    dryRun: true,
  });
});

test("rejects invalid input", () => {
  expect(() => parseOrderArgs(argv("BUY SBIN-EQ"))).toThrow("Usage");
  expect(() => parseOrderArgs(argv("BUY SBIN-EQ 1"))).toThrow("--product is required");
  expect(() => parseOrderArgs(argv("HOLD SBIN-EQ 1 --product INTRADAY"))).toThrow("Side must be one of BUY, SELL");
  expect(() => parseOrderArgs(argv("BUY SBIN-EQ 1.5 --product INTRADAY"))).toThrow("positive whole number");
  expect(() => parseOrderArgs(argv("BUY SBIN-EQ 0 --product INTRADAY"))).toThrow("positive whole number");
  expect(() => parseOrderArgs(argv("BUY SBIN-EQ 1 --product CNC"))).toThrow("--product must be one of");
  expect(() => parseOrderArgs(argv("BUY SBIN-EQ 1 --product INTRADAY --type LIMIT"))).toThrow(
    "--price is required for LIMIT",
  );
  expect(() => parseOrderArgs(argv("BUY SBIN-EQ 1 --product INTRADAY --type STOPLOSS_MARKET"))).toThrow(
    "--trigger is required for STOPLOSS_MARKET",
  );
  expect(() => parseOrderArgs(argv("BUY SBIN-EQ 1 --product INTRADAY --price=-3"))).toThrow(
    "--price must be a positive number",
  );
  expect(() => parseOrderArgs(argv("BUY SBIN-EQ 1 --product INTRADAY --bogus"))).toThrow();
});

test("builds the placeOrder body with string numbers and the right variety", () => {
  expect(orderBody(parseOrderArgs(argv("BUY SBIN-EQ 2 --product INTRADAY")), "3045")).toEqual({
    variety: "NORMAL",
    tradingsymbol: "SBIN-EQ",
    symboltoken: "3045",
    exchange: "NSE",
    transactiontype: "BUY",
    ordertype: "MARKET",
    producttype: "INTRADAY",
    duration: "DAY",
    quantity: "2",
    price: "0",
    triggerprice: "0",
  });
  const sl = parseOrderArgs(argv("SELL SBIN-EQ 1 --product INTRADAY --type STOPLOSS_LIMIT --price 950 --trigger 951"));
  expect(orderBody(sl, "3045")).toMatchObject({ variety: "STOPLOSS", price: "950", triggerprice: "951" });
  expect(orderBody(parseOrderArgs(argv("BUY SBIN-EQ 1 --product DELIVERY --amo")), "3045").variety).toBe("AMO");
});
