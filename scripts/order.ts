// Places a real Angel One order from the terminal, only after you type YES.
import { config } from "../src/config.ts";
import { orderBody, parseOrderArgs, type OrderRequest } from "../src/order-cli.ts";
import { SmartApi } from "../src/smartapi.ts";

const P = "/rest/secure/angelbroking";

async function resolveToken(api: SmartApi, o: OrderRequest): Promise<string> {
  if (o.symboltoken) return o.symboltoken;
  const rows = await api.post<{ tradingsymbol: string; symboltoken: string }[] | null>(`${P}/order/v1/searchScrip`, {
    exchange: o.exchange,
    searchscrip: o.tradingsymbol,
  });
  const hit = rows?.find((r) => r.tradingsymbol.toUpperCase() === o.tradingsymbol);
  if (hit) return hit.symboltoken;
  const close = (rows ?? []).slice(0, 10).map((r) => r.tradingsymbol);
  throw new Error(
    `No exact match for ${o.tradingsymbol} on ${o.exchange}. Close matches: ${close.join(", ") || "none"}`,
  );
}

const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  let order: OrderRequest;
  try {
    order = parseOrderArgs(Bun.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }

  const api = new SmartApi(config);
  const token = await resolveToken(api, order);
  const quote = await api.post<{ fetched?: { ltp: number }[] }>(`${P}/market/v1/quote`, {
    mode: "LTP",
    exchangeTokens: { [order.exchange]: [token] },
  });
  const ltp = quote?.fetched?.[0]?.ltp;
  const body = orderBody(order, token);
  const unitPrice = order.price ?? ltp;

  console.log(`\n  ${order.side} ${order.quantity} × ${order.tradingsymbol} (${order.exchange}, token ${token})`);
  console.log(`  ${order.ordertype} · ${order.producttype} · ${body.variety}`);
  if (order.price !== undefined) console.log(`  Limit price ${rupees(order.price)}`);
  if (order.triggerprice !== undefined) console.log(`  Trigger price ${rupees(order.triggerprice)}`);
  if (ltp !== undefined) console.log(`  Last price ${rupees(ltp)}`);
  if (unitPrice !== undefined) console.log(`  Approx. value ${rupees(unitPrice * order.quantity)}`);
  console.log("");

  if (order.dryRun) {
    console.log("Dry run, nothing sent. Request body:");
    console.log(JSON.stringify(body, null, 2));
    return;
  }

  if (prompt("Type YES to place this real order:") !== "YES") {
    console.log("Cancelled. No order placed.");
    return;
  }

  const placed = await api.post<{ orderid: string; uniqueorderid?: string }>(`${P}/order/v1/placeOrder`, body);
  console.log(`Order sent. orderid ${placed.orderid}`);
  if (placed.uniqueorderid) {
    await Bun.sleep(1000);
    const d = await api
      .get<{ status: string; text: string }>(`${P}/order/v1/details/${placed.uniqueorderid}`)
      .catch(() => null);
    if (d) console.log(`Status: ${d.status}${d.text ? ` — ${d.text}` : ""}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
