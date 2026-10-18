import { describe, expect, test } from "bun:test";
import { decodeTick, Mode, subscribeMessage } from "./protocol.ts";

interface PacketFields {
  mode: number;
  exchangeType: number;
  token: string;
  ltp: bigint;
}

// Builds a packet using the byte layout in the spec's offset table.
function packet({ mode, exchangeType, token, ltp }: PacketFields): ArrayBuffer {
  const size = mode === 1 ? 51 : mode === 2 ? 123 : 379;
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  v.setUint8(0, mode);
  v.setUint8(1, exchangeType);
  new Uint8Array(buf).set(new TextEncoder().encode(token), 2);
  v.setBigInt64(27, 7n, true);
  v.setBigInt64(35, 1760000000000n, true);
  v.setBigInt64(43, ltp, true);
  if (mode >= 2) {
    v.setBigInt64(51, 25n, true);
    v.setBigInt64(59, 81234n, true);
    v.setBigInt64(67, 1234567n, true);
    v.setFloat64(75, 5000, true);
    v.setFloat64(83, 2500, true);
    v.setBigInt64(91, 81000n, true);
    v.setBigInt64(99, 82000n, true);
    v.setBigInt64(107, 80500n, true);
    v.setBigInt64(115, 80000n, true);
  }
  if (mode === 3) v.setBigInt64(131, 4500n, true);
  return buf;
}

describe("decodeTick", () => {
  test("LTP packet", () => {
    expect(decodeTick(packet({ mode: 1, exchangeType: 1, token: "3045", ltp: 81250n }))).toEqual({
      exchange: "NSE",
      token: "3045",
      mode: Mode.LTP,
      exchangeTs: 1760000000000,
      ltp: 812.5,
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
    });
  });

  test("Quote packet", () => {
    expect(decodeTick(packet({ mode: 2, exchangeType: 2, token: "49014", ltp: 177370n }))).toEqual({
      exchange: "NFO",
      token: "49014",
      mode: Mode.QUOTE,
      exchangeTs: 1760000000000,
      ltp: 1773.7,
      ltq: 25,
      atp: 812.34,
      volume: 1234567,
      buyQty: 5000,
      sellQty: 2500,
      open: 810,
      high: 820,
      low: 805,
      close: 800,
      oi: null,
    });
  });

  test("SnapQuote packet adds open interest", () => {
    const t = decodeTick(packet({ mode: 3, exchangeType: 1, token: "3045", ltp: 81250n }));
    expect(t?.mode).toBe(Mode.SNAP_QUOTE);
    expect(t?.oi).toBe(4500);
    expect(t?.volume).toBe(1234567);
  });

  test("CDS prices use a 10^7 divisor", () => {
    expect(decodeTick(packet({ mode: 1, exchangeType: 13, token: "1", ltp: 835000000n }))?.ltp).toBe(83.5);
  });

  test("accepts a Uint8Array view", () => {
    const bytes = new Uint8Array(packet({ mode: 1, exchangeType: 3, token: "500325", ltp: 100n }));
    expect(decodeTick(bytes)?.exchange).toBe("BSE");
  });

  test("rejects short packets and unknown exchange or mode", () => {
    expect(decodeTick(new ArrayBuffer(10))).toBeNull();
    expect(decodeTick(packet({ mode: 1, exchangeType: 99, token: "1", ltp: 1n }))).toBeNull();
    expect(decodeTick(packet({ mode: 1, exchangeType: 1, token: "1", ltp: 1n }).slice(0, 50))).toBeNull();
    const badMode = packet({ mode: 1, exchangeType: 1, token: "1", ltp: 1n });
    new DataView(badMode).setUint8(0, 9);
    expect(decodeTick(badMode)).toBeNull();
  });
});

describe("subscribeMessage", () => {
  test("groups tokens by exchange type", () => {
    const msg = subscribeMessage(1, Mode.QUOTE, [
      { exchange: "NSE", token: "3045" },
      { exchange: "NFO", token: "49014" },
      { exchange: "NSE", token: "2885" },
    ]);
    expect(JSON.parse(msg)).toEqual({
      correlationID: "mcp",
      action: 1,
      params: {
        mode: 2,
        tokenList: [
          { exchangeType: 1, tokens: ["3045", "2885"] },
          { exchangeType: 2, tokens: ["49014"] },
        ],
      },
    });
  });

  test("unsubscribe uses action 0", () => {
    expect(JSON.parse(subscribeMessage(0, Mode.LTP, [{ exchange: "BSE", token: "1" }])).action).toBe(0);
  });
});
