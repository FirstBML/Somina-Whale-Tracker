import { NextRequest } from "next/server";
import { SDK } from "@somnia-chain/reactivity";
import {
  createPublicClient, createWalletClient, webSocket, http,
  keccak256, toBytes, defineChain, parseAbiItem, decodeEventLog
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: {
      http:      ["https://dream-rpc.somnia.network"],
      webSocket: ["wss://dream-rpc.somnia.network/ws"],
    },
  },
});

const WHALE_ABI = [{
  name: "WhaleTransfer", type: "event",
  inputs: [
    { name: "from",      type: "address", indexed: true  },
    { name: "to",        type: "address", indexed: true  },
    { name: "amount",    type: "uint256", indexed: false },
    { name: "timestamp", type: "uint256", indexed: false },
    { name: "token",     type: "string",  indexed: false },
  ],
}] as const;

const HANDLER_ABI = [{
  name: "ReactedToWhaleTransfer", type: "event",
  inputs: [
    { name: "emitter", type: "address", indexed: true  },
    { name: "topic0",  type: "bytes32", indexed: false },
    { name: "from",    type: "address", indexed: false },
    { name: "to",      type: "address", indexed: false },
    { name: "count",   type: "uint256", indexed: false },
  ],
}, {
  name: "AlertThresholdCrossed", type: "event",
  inputs: [
    { name: "reactionCount", type: "uint256", indexed: false },
    { name: "blockNumber",   type: "uint256", indexed: false },
  ],
}] as const;

export type CacheEntry = {
  type: "whale" | "reaction" | "alert";
  receivedAt: number;
  raw: {
    from: string; to: string; amount: string; timestamp: string; token: string;
    txHash: string; blockNumber: string; blockHash: string;
    reactionCount?: string; handlerEmitter?: string;
  };
};

// ── In-memory leaderboard (written to Data Streams asynchronously) ────────────
type LeaderEntry = { totalVolume: bigint; txCount: number; lastSeen: number };
const leaderMap = new Map<string, LeaderEntry>();

function updateLeaderMap(from: string, to: string, amount: bigint, ts: number) {
  for (const addr of [from, to]) {
    const existing = leaderMap.get(addr) ?? { totalVolume: 0n, txCount: 0, lastSeen: 0 };
    leaderMap.set(addr, {
      totalVolume: existing.totalVolume + amount,
      txCount:     existing.txCount + 1,
      lastSeen:    Math.max(existing.lastSeen, ts),
    });
  }
}

// Write to Data Streams (fire-and-forget, non-blocking)
async function persistLeaderEntry(wallet: string, entry: LeaderEntry) {
  try {
    await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000"}/api/streams-leaderboard`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet,
        totalVolume: entry.totalVolume.toString(),
        txCount:     entry.txCount,
        lastSeen:    entry.lastSeen,
      }),
    });
  } catch (e) {
    console.error("streams persist error:", e);
  }
}

// ── Server state ──────────────────────────────────────────────────────────────
const MAX_CACHE = 200;
const alertCache: CacheEntry[] = [];
let trackerSub: { unsubscribe: () => Promise<any> } | null = null;
let handlerSub: { unsubscribe: () => Promise<any> } | null = null;
const encoder     = new TextEncoder();
const controllers = new Set<ReadableStreamDefaultController>();

function broadcast(entry: CacheEntry) {
  const msg = encoder.encode(`data: ${JSON.stringify(entry)}\n\n`);
  controllers.forEach(c => { try { c.enqueue(msg); } catch {} });
}
function push(entry: CacheEntry) {
  alertCache.push(entry);
  if (alertCache.length > MAX_CACHE) alertCache.shift();
  broadcast(entry);
}

// ── Historical event loader ───────────────────────────────────────────────────
async function loadPastEvents() {
  const CONTRACT = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;
  const pub = createPublicClient({ chain: somniaTestnet, transport: http("https://dream-rpc.somnia.network") });

  const CHUNK    = 1000n;
  const LOOKBACK = 50000n;
  const latest   = await pub.getBlockNumber();
  const start    = latest > LOOKBACK ? latest - LOOKBACK : 0n;

  let logs: any[] = [];
  for (let from = start; from < latest; from += CHUNK) {
    const to = from + CHUNK - 1n < latest ? from + CHUNK - 1n : latest;
    try {
      const chunk = await pub.getLogs({
        address: CONTRACT,
        event: parseAbiItem("event WhaleTransfer(address indexed from, address indexed to, uint256 amount, uint256 timestamp, string token)"),
        fromBlock: from, toBlock: to,
      });
      logs = logs.concat(chunk);
    } catch {}
  }

  logs.slice(-MAX_CACHE).forEach(log => {
    try {
      const decoded = decodeEventLog({ abi: WHALE_ABI, data: log.data, topics: log.topics });
      const a = decoded.args as any;
      const amount = BigInt(a.amount);
      const ts     = Number(BigInt(a.timestamp)) * 1000;

      alertCache.push({
        type: "whale",
        receivedAt: Date.now(),
        raw: {
          from:        a.from,
          to:          a.to,
          amount:      `0x${amount.toString(16)}`,
          timestamp:   `0x${BigInt(a.timestamp).toString(16)}`,
          token:       a.token ?? "STT",
          txHash:      log.transactionHash ?? "",
          blockNumber: log.blockNumber?.toString() ?? "",
          blockHash:   log.blockHash ?? "",
        },
      });
      updateLeaderMap(a.from, a.to, amount, ts);
    } catch {}
  });

  console.log(`✅ Loaded ${logs.length} past WhaleTransfer events`);
}

// ── SDK subscriptions ─────────────────────────────────────────────────────────
async function ensureSubscriptions() {
  if (trackerSub && handlerSub) return;
  await loadPastEvents();

  const CONTRACT = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS  as `0x${string}`;
  const HANDLER  = process.env.HANDLER_CONTRACT_ADDRESS      as `0x${string}`;
  const account  = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const pubClient = createPublicClient({ chain: somniaTestnet, transport: webSocket("wss://dream-rpc.somnia.network/ws") });
  const walClient = createWalletClient({ account, chain: somniaTestnet, transport: http("https://dream-rpc.somnia.network") });
  const sdk       = new SDK({ public: pubClient, wallet: walClient });

  const WHALE_TOPIC   = keccak256(toBytes("WhaleTransfer(address,address,uint256,uint256,string)"));
  const REACTED_TOPIC = keccak256(toBytes("ReactedToWhaleTransfer(address,bytes32,address,address,uint256)"));
  const ALERT_TOPIC   = keccak256(toBytes("AlertThresholdCrossed(uint256,uint256)"));

  if (!trackerSub) {
    const r1 = await sdk.subscribe({
      ethCalls: [],
      eventContractSources: [CONTRACT],
      topicOverrides: [WHALE_TOPIC],
      onData: (data: any) => {
        try {
          const r = data?.result ?? data;
          const decoded = decodeEventLog({
            abi: WHALE_ABI,
            data: r?.data as `0x${string}`,
            topics: r?.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          const a      = decoded.args as any;
          const amount = BigInt(a.amount);
          const ts     = Number(BigInt(a.timestamp)) * 1000;

          const entry: CacheEntry = {
            type: "whale",
            receivedAt: Date.now(),
            raw: {
              from:        a.from,
              to:          a.to,
              amount:      `0x${amount.toString(16)}`,
              timestamp:   `0x${BigInt(a.timestamp).toString(16)}`,
              token:       a.token ?? "STT",
              txHash:      r?.transactionHash ?? "",
              blockNumber: r?.blockNumber ? BigInt(r.blockNumber).toString() : "",
              blockHash:   r?.blockHash ?? "",
            },
          };

          push(entry);
          updateLeaderMap(a.from, a.to, amount, ts);

          // Async persist both wallets to Data Streams
          for (const wallet of [a.from as string, a.to as string]) {
            const le = leaderMap.get(wallet);
            if (le) persistLeaderEntry(wallet, le);
          }
        } catch (e) { console.error("WhaleTransfer parse error:", e); }
      },
      onError: (e: Error) => console.error("Tracker SDK error:", e),
    });
    if (r1 instanceof Error) throw r1;
    trackerSub = r1;
    console.log("✅ WhaleTracker subscription:", r1.subscriptionId);
  }

  if (!handlerSub && HANDLER) {
    const r2 = await sdk.subscribe({
      ethCalls: [], eventContractSources: [HANDLER], topicOverrides: [REACTED_TOPIC],
      onData: (data: any) => {
        try {
          const r = data?.result ?? data;
          const decoded = decodeEventLog({
            abi: HANDLER_ABI, data: r?.data as `0x${string}`,
            topics: r?.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          const a = decoded.args as any;
          push({
            type: "reaction", receivedAt: Date.now(),
            raw: {
              from: a.from, to: a.to, amount: "0x0",
              timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
              token: "", txHash: r?.transactionHash ?? "",
              blockNumber: r?.blockNumber ? BigInt(r.blockNumber).toString() : "",
              blockHash: r?.blockHash ?? "",
              reactionCount: a.count?.toString() ?? "",
              handlerEmitter: a.emitter ?? "",
            },
          });
        } catch (e) { console.error("Reaction parse error:", e); }
      },
      onError: (e: Error) => console.error("Handler SDK error:", e),
    });

    const r3 = await sdk.subscribe({
      ethCalls: [], eventContractSources: [HANDLER], topicOverrides: [ALERT_TOPIC],
      onData: (data: any) => {
        try {
          const r = data?.result ?? data;
          const decoded = decodeEventLog({
            abi: HANDLER_ABI, data: r?.data as `0x${string}`,
            topics: r?.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          const a = decoded.args as any;
          push({
            type: "alert", receivedAt: Date.now(),
            raw: {
              from: "", to: "", amount: "0x0",
              timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
              token: "", txHash: r?.transactionHash ?? "",
              blockNumber: r?.blockNumber ? BigInt(r.blockNumber).toString() : "",
              blockHash: "", reactionCount: a.reactionCount?.toString() ?? "",
            },
          });
        } catch (e) { console.error("Alert parse error:", e); }
      },
      onError: (e: Error) => console.error("Alert SDK error:", e),
    });

    if (r2 instanceof Error) {
      console.warn("⚠ Handler subscription failed:", r2.message);
    } else {
      handlerSub = r2;
      console.log("✅ WhaleHandler reaction subscription:", r2.subscriptionId);
    }
    if (!(r3 instanceof Error)) console.log("✅ WhaleHandler alert subscription:", r3.subscriptionId);
  } else if (!HANDLER) {
    console.log("ℹ HANDLER_CONTRACT_ADDRESS not set — skipping Phase 2 subscriptions");
  }
}

// ── SSE endpoint ──────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    await ensureSubscriptions();
  } catch (e: any) {
    const msg = encoder.encode(`data: ${JSON.stringify({ type: "error", message: e.message })}\n\n`);
    return new Response(msg, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
  }

  const stream = new ReadableStream({
    start(controller) {
      controllers.add(controller);
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "init", alerts: alertCache })}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));

      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: ping\n\n`)); }
        catch { clearInterval(ping); }
      }, 30000);

      req.signal.addEventListener("abort", () => {
        clearInterval(ping);
        controllers.delete(controller);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}