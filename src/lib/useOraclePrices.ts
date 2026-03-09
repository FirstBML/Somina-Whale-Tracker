"use client";
import { useEffect, useState, useRef } from "react";
import { createPublicClient, http, defineChain } from "viem";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
});

// Client created fresh per call so stale connections don't cache old data
function makeClient() {
  return createPublicClient({ chain: somniaTestnet, transport: http() });
}

// ── Protofire Chainlink feeds — Somnia Testnet ────────────────────────────────
const FEEDS = {
  ETH:  "0xd9132c1d762D432672493F640a63B758891B449e",
  BTC:  "0x8CeE6c58b8CbD8afdEaF14e6fCA0876765e161fE",
  USDC: "0xa2515C9480e62B510065917136B08F3f7ad743B4",
} as const;

// ── DIA oracle — Somnia Testnet ───────────────────────────────────────────────
// Additional feeds via DIA (USDT, ARB, SOL, WETH, SOMI)
const DIA_ORACLE   = "0x9206296Ea3aEE3E6bdC07F7AaeF14DfCf33d865D" as const;
const DIA_ADAPTERS: Record<string, `0x${string}`> = {
  WETH: "0x786c7893F8c26b80d42088749562eDb50Ba9601E",
  USDT: "0x67d2C2a87A17b7267a6DBb1A59575C0E9A1D1c3e",
  SOL:  "0xD5Ea6C434582F827303423dA21729bEa4F87D519",
  SOMI: "0xaEAa92c38939775d3be39fFA832A92611f7D6aDe",
};

const AGGREGATOR_ABI = [
  { name: "latestRoundData", type: "function", stateMutability: "view",
    inputs: [], outputs: [
      { name: "roundId",         type: "uint80"  },
      { name: "answer",          type: "int256"  },
      { name: "startedAt",       type: "uint256" },
      { name: "updatedAt",       type: "uint256" },
      { name: "answeredInRound", type: "uint80"  },
    ]},
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
] as const;

// DIA uses getValue(string) → (uint128 price, uint128 timestamp)
const DIA_ABI = [{
  name: "getValue", type: "function", stateMutability: "view",
  inputs: [{ name: "key", type: "string" }],
  outputs: [{ name: "price", type: "uint128" }, { name: "timestamp", type: "uint128" }],
}] as const;

export type OraclePrice = {
  symbol:    string;
  price:     number;      // USD with 2 decimal places
  updatedAt: number;      // unix ms
  source:    "Protofire" | "DIA";
  stale:     boolean;     // true if > 5 min old
};

async function fetchProtofire(symbol: keyof typeof FEEDS): Promise<OraclePrice | null> {
  try {
    const addr = FEEDS[symbol] as `0x${string}`;
    const c = makeClient();
    const [roundData, decimals] = await Promise.all([
      c.readContract({ address: addr, abi: AGGREGATOR_ABI, functionName: "latestRoundData" }),
      c.readContract({ address: addr, abi: AGGREGATOR_ABI, functionName: "decimals" }),
    ]);
    const [, answer, , updatedAt] = roundData as [bigint, bigint, bigint, bigint, bigint];
    const dec = decimals as number;
    const price = Number(answer) / 10 ** dec;
    const updatedMs = Number(updatedAt) * 1000;
    return { symbol, price, updatedAt: updatedMs, source: "Protofire", stale: Date.now() - updatedMs > 5 * 60_000 };
  } catch { return null; }
}

async function fetchDIA(symbol: string, key: string): Promise<OraclePrice | null> {
  try {
    const [price, timestamp] = await makeClient().readContract({
      address: DIA_ORACLE, abi: DIA_ABI, functionName: "getValue", args: [key],
    }) as [bigint, bigint];
    const updatedMs = Number(timestamp) * 1000;
    // DIA returns price with 8 decimals
    return { symbol, price: Number(price) / 1e8, updatedAt: updatedMs, source: "DIA", stale: Date.now() - updatedMs > 5 * 60_000 };
  } catch { return null; }
}

const DIA_KEYS: Record<string, string> = {
  WETH: "ETH/USD",
  USDT: "USDT/USD",
  SOL:  "SOL/USD",
  SOMI: "SOMI/USD",
};

export function useOraclePrices(intervalMs = 10_000) {
  const [prices, setPrices] = useState<Record<string, OraclePrice>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<number>(0);

  async function refresh() {
    try {
      const results = await Promise.allSettled([
        fetchProtofire("ETH"),
        fetchProtofire("BTC"),
        fetchProtofire("USDC"),
        fetchDIA("USDT", "USDT/USD"),
        fetchDIA("SOL",  "SOL/USD"),
        fetchDIA("SOMI", "SOMI/USD"),
      ]);

      const next: Record<string, OraclePrice> = {};
      results.forEach(r => { if (r.status === "fulfilled" && r.value) next[r.value.symbol] = r.value; });
      setPrices(next);
      setLoading(false);
      setLastFetchedAt(Date.now());
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return { prices, loading, error, refresh, lastFetchedAt };
}

// Convenience: get ETH/USD price for server-side USD estimation
export function formatUsd(price: number): string {
  if (price >= 1000) return `$${price.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (price >= 1)    return `$${price.toFixed(2)}`;
  return `$${price.toFixed(4)}`;
}