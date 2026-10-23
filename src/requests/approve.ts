import { z } from "zod";
import { ACTIONS, executeAction, isAction, safeParseParams, type Api } from "./actions.ts";
import type { Confirm, Decision } from "./confirm.ts";
import type { RequestResult, RequestStatus, RequestStore, TradeRequest } from "./store.ts";

const P = "/rest/secure/angelbroking";

export interface ApproveDeps {
  api: Api;
  store: RequestStore;
  confirm: Confirm;
  now: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const rupees = (n: number) =>
  `Rs ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Last traded price for the dialog; null when the action has no instrument or the lookup fails. */
async function lastPrice(api: Api, params: Record<string, unknown>): Promise<number | null> {
  const { exchange, symboltoken } = params;
  if (typeof exchange !== "string" || typeof symboltoken !== "string") return null;
  try {
    const q = await api.post<{ fetched?: { ltp: number }[] }>(`${P}/market/v1/quote`, {
      mode: "LTP",
      exchangeTokens: { [exchange]: [symboltoken] },
    });
    return q?.fetched?.[0]?.ltp ?? null;
  } catch {
    return null;
  }
}

/** Order status shortly after the call, when the response names the order. */
async function orderDetails(api: Api, response: unknown, sleep: (ms: number) => Promise<void>): Promise<unknown> {
  const uid = (response as { uniqueorderid?: unknown } | null)?.uniqueorderid;
  if (typeof uid !== "string" || !uid) return null;
  await sleep(1000);
  return api.get(`${P}/order/v1/details/${encodeURIComponent(uid)}`).catch(() => null);
}

/** Dialog text: every param, the price context, and Claude's reason. */
export function describe(req: TradeRequest, title: string, params: Record<string, unknown>, ltp: number | null): string {
  const lines = [title, ""];
  for (const [k, v] of Object.entries(params)) if (v !== undefined) lines.push(`${k}: ${v}`);
  const qty = params.quantity ?? params.qty;
  const price = typeof params.price === "number" && params.price > 0 ? params.price : ltp;
  const context: string[] = [];
  if (ltp !== null) context.push(`Last price: ${rupees(ltp)}`);
  if (typeof qty === "number" && price !== null) context.push(`Approx. value: ${rupees(qty * price)}`);
  if (context.length) lines.push("", ...context);
  lines.push("", `Reason: ${req.reason}`, `Request: ${req.id}`);
  return lines.join("\n");
}

/** Shows one request to the user and executes it only on Approve. Every outcome is written as its result file. */
export async function approve(id: string, deps: ApproveDeps): Promise<RequestResult> {
  const { api, store, confirm, now, sleep = Bun.sleep } = deps;
  const req = await store.read(id);
  if (!req) throw new Error(`No request ${id}`);
  const existing = await store.readResult(id);
  if (existing) return existing;

  let ltp: number | null = null;
  const result = (status: RequestStatus, extra: Partial<RequestResult> = {}): RequestResult => ({
    id,
    status,
    decidedAt: now().toISOString(),
    ltp,
    response: null,
    order: null,
    error: null,
    ...extra,
  });
  // Outcomes that never touch the account; if someone else already decided, theirs stands.
  const finish = async (r: RequestResult) => ((await store.claim(r)) ? r : ((await store.readResult(id)) ?? r));

  if (!isAction(req.action)) return finish(result("failed", { error: `Unknown action ${req.action}` }));
  const parsed = safeParseParams(req.action, req.params);
  if (!parsed.success) return finish(result("failed", { error: z.prettifyError(parsed.error) }));
  const params = parsed.data;
  const title = ACTIONS[req.action].title;

  const expiresAt = Date.parse(req.expiresAt);
  const remainingSec = Math.floor((expiresAt - now().getTime()) / 1000);
  if (remainingSec <= 0) return finish(result("expired"));

  ltp = await lastPrice(api, params);
  let decision: Decision;
  try {
    decision = await confirm(`Angel One: ${title}`, describe(req, title, params, ltp), remainingSec);
  } catch (e) {
    return finish(result("failed", { error: message(e) }));
  }
  if (decision === "reject") return finish(result("rejected"));
  if (decision === "timeout" || now().getTime() >= expiresAt) return finish(result("expired"));

  // Claim before calling SmartAPI so the same request can never execute twice.
  const executing = result("executing");
  if (!(await store.claim(executing))) return (await store.readResult(id)) ?? executing;
  let final: RequestResult;
  try {
    const response = await executeAction(api, req.action, params);
    final = result("executed", { response, order: await orderDetails(api, response, sleep) });
  } catch (e) {
    final = result("failed", { error: message(e) });
  }
  await store.writeResult(final);
  return final;
}
