// SmartAPI WebSocket 2.0 wire format. Byte offsets follow the official SDK
// (see docs/superpowers/specs/2026-10-18-live-streaming-design.md).

export type Exchange = "NSE" | "NFO" | "BSE" | "BFO" | "MCX" | "NCDEX" | "CDS";

export const EXCHANGE_TYPE: Record<Exchange, number> = {
  NSE: 1,
  NFO: 2,
  BSE: 3,
  BFO: 4,
  MCX: 5,
  NCDEX: 7,
  CDS: 13,
};

const EXCHANGE_BY_TYPE = new Map<number, Exchange>(
  Object.entries(EXCHANGE_TYPE).map(([ex, type]) => [type, ex as Exchange]),
);

export const Mode = { LTP: 1, QUOTE: 2, SNAP_QUOTE: 3 } as const;
export type Mode = (typeof Mode)[keyof typeof Mode];

export interface Tick {
  exchange: Exchange;
  token: string;
  mode: Mode;
  exchangeTs: number;
  ltp: number;
  ltq: number | null;
  atp: number | null;
  volume: number | null;
  buyQty: number | null;
  sellQty: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  oi: number | null;
}

const LTP_SIZE = 51;
const QUOTE_SIZE = 123;
const SNAP_OI_END = 139;

export function decodeTick(input: ArrayBuffer | Uint8Array): Tick | null {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < LTP_SIZE) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mode = v.getUint8(0);
  const exchange = EXCHANGE_BY_TYPE.get(v.getUint8(1));
  if (!exchange || (mode !== Mode.LTP && mode !== Mode.QUOTE && mode !== Mode.SNAP_QUOTE)) return null;

  const divisor = exchange === "CDS" ? 1e7 : 100;
  const int = (offset: number) => Number(v.getBigInt64(offset, true));
  const price = (offset: number) => int(offset) / divisor;
  const token = new TextDecoder().decode(bytes.subarray(2, 27)).split("\0")[0] ?? "";

  const tick: Tick = {
    exchange,
    token,
    mode,
    exchangeTs: int(35),
    ltp: price(43),
    ltq: null,
    atp: null,
    volume: null,
    buyQty: null,
    sellQty: null,
    open: null,
    high: null,
    low: null,
    close: null,
    oi: null,
  };
  if (mode !== Mode.LTP && bytes.length >= QUOTE_SIZE) {
    tick.ltq = int(51);
    tick.atp = price(59);
    tick.volume = int(67);
    tick.buyQty = v.getFloat64(75, true);
    tick.sellQty = v.getFloat64(83, true);
    tick.open = price(91);
    tick.high = price(99);
    tick.low = price(107);
    tick.close = price(115);
  }
  if (mode === Mode.SNAP_QUOTE && bytes.length >= SNAP_OI_END) tick.oi = int(131);
  return tick;
}

export function subscribeMessage(
  action: 0 | 1,
  mode: Mode,
  symbols: { exchange: Exchange; token: string }[],
): string {
  const byType = new Map<number, string[]>();
  for (const s of symbols) {
    const type = EXCHANGE_TYPE[s.exchange];
    const tokens = byType.get(type) ?? [];
    tokens.push(s.token);
    byType.set(type, tokens);
  }
  return JSON.stringify({
    correlationID: "mcp",
    action,
    params: { mode, tokenList: [...byType].map(([exchangeType, tokens]) => ({ exchangeType, tokens })) },
  });
}
