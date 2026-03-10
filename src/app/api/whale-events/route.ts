import { NextRequest } from "next/server";
import { SDK } from "@somnia-chain/reactivity";
import {
  createPublicClient, createWalletClient, webSocket, http,
  keccak256, toBytes, defineChain, parseAbiItem, decodeEventLog, parseEther,
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

const MOMENTUM_ABI = [{
  name: "WhaleMomentumDetected", type: "event",
  inputs: [
    { name: "burstCount",  type: "uint256", indexed: false },
    { name: "blockNumber", type: "uint256", indexed: false },
  ],
}] as const;

// ABI for calling reportTransfer on WhaleTracker
const TRACKER_ABI = [{
  name: "reportTransfer",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [
    { name: "from",   type: "address" },
    { name: "to",     type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [],
}] as const;

// Protofire ETH/USD feed on Somnia testnet
const ETH_USD_FEED = "0xd9132c1d762D432672493F640a63B758891B449e" as const;
const AGGREGATOR_ABI = [{
  name: "latestRoundData", type: "function", stateMutability: "view",
  inputs: [], outputs: [
    { name: "roundId",         type: "uint80"  },
    { name: "answer",          type: "int256"  },
    { name: "startedAt",       type: "uint256" },
    { name: "updatedAt",       type: "uint256" },
    { name: "answeredInRound", type: "uint80"  },
  ],
}, {
  name: "decimals", type: "function", stateMutability: "view",
  inputs: [], outputs: [{ type: "uint8" }],
}] as const;

// USD whale threshold — triggers when transfer value ≥ this in USD
const USD_WHALE_THRESHOLD = 100_000; // $100k
// STT fallback threshold (no USD feed available for native STT)
const WATCH_THRESHOLD = parseEther("0.001"); // lowered for testnet testing

export type CacheEntry = {
  type: "whale" | "reaction" | "alert" | "momentum" | "block_tx";
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
const MAX_CACHE    = 200;  // whale/reaction/alert/momentum events
const MAX_BLOCK_TX = 500;  // raw block transactions
const alertCache: CacheEntry[] = [];
let totalBlockTxsSeen = 0;
let networkLargestSTT = 0;  // running max STT, never resets
const BLOCK_TX_WINDOW_MS = 5 * 60 * 1000;
let trackerSub:   { unsubscribe: () => Promise<any> } | null = null;
let handlerSub:   { unsubscribe: () => Promise<any> } | null = null;
let momentumSub:  { unsubscribe: () => Promise<any> } | null = null;
let blockWatcher: (() => void) | null = null;  // unwatch fn
let reporting = false; // serialise reportTransfer calls to avoid nonce collisions
const encoder     = new TextEncoder();
const controllers = new Set<ReadableStreamDefaultController>();

function broadcast(entry: CacheEntry) {
  const payload = entry.type === "block_tx"
    ? { ...entry, totalBlockTxsSeen, networkLargestSTT }
    : entry;
  const msg = encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  controllers.forEach(c => { try { c.enqueue(msg); } catch {} });
}
function push(entry: CacheEntry) {
  if (entry.type === "block_tx") {
    totalBlockTxsSeen++;
    const amt = Number((entry.raw as any)?.amount ?? 0);
    if (amt > networkLargestSTT) networkLargestSTT = amt;
    // Evict entries older than window to keep memory bounded
    const cutoff = Date.now() - BLOCK_TX_WINDOW_MS;
    let i = 0;
    while (i < alertCache.length && alertCache[i].type === "block_tx" && alertCache[i].receivedAt < cutoff) i++;
    if (i > 0) alertCache.splice(0, i);
  } else {
    if (alertCache.filter(e => e.type !== "block_tx").length >= MAX_CACHE) {
      const idx = alertCache.findIndex(e => e.type !== "block_tx");
      if (idx !== -1) alertCache.splice(idx, 1);
    }
  }
  alertCache.push(entry);
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

// ── Real-chain block watcher ──────────────────────────────────────────────────
async function getEthUsdPrice(pub: ReturnType<typeof createPublicClient>): Promise<number> {
  try {
    const [roundData, decimals] = await Promise.all([
      pub.readContract({ address: ETH_USD_FEED, abi: AGGREGATOR_ABI, functionName: "latestRoundData" }),
      pub.readContract({ address: ETH_USD_FEED, abi: AGGREGATOR_ABI, functionName: "decimals" }),
    ]);
    const [, answer] = roundData as [bigint, bigint, bigint, bigint, bigint];
    return Number(answer) / 10 ** (decimals as number);
  } catch { return 0; }
}

async function startBlockWatcher(
  CONTRACT: `0x${string}`,
  walClient: ReturnType<typeof createWalletClient>,
  pubClient: ReturnType<typeof createPublicClient>,
) {
  const httpPub = createPublicClient({ chain: somniaTestnet, transport: http("https://dream-rpc.somnia.network") });

  // Cache ETH price — refresh every 2 min
  let ethUsd = await getEthUsdPrice(httpPub);
  setInterval(async () => { ethUsd = await getEthUsdPrice(httpPub) || ethUsd; }, 120_000);
  console.log(`💰 ETH/USD oracle price: $${ethUsd.toFixed(2)} (Protofire)`);

  // WebSocket for real-time block notifications (Somnia = 0.1s blocks, HTTP polling too slow)
  const wsPub = createPublicClient({
    chain: somniaTestnet,
    transport: webSocket("wss://dream-rpc.somnia.network/ws"),
  });

  const unwatch = wsPub.watchBlocks({
    includeTransactions: true,
    onBlock: async (block) => {
      for (const tx of block.transactions) {
        if (typeof tx !== "object") continue;
        const val  = tx.value ?? 0n;
        const from = tx.from as `0x${string}`;
        const to   = (tx.to ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
        const sttAmount = Number(val) / 1e18;
        const txHash = tx.hash ?? "";
        const blockNum = block.number?.toString() ?? "";
        const ts = `0x${Math.floor(Date.now() / 1000).toString(16)}`;

        // Push ALL transactions as block_tx for network monitoring
        if (tx.hash) {
          push({
            type: "block_tx", receivedAt: Date.now(),
            raw: {
              from, to,
              amount: sttAmount > 0 ? sttAmount.toFixed(6) : "0",
              timestamp: ts, token: "STT",
              txHash, blockNumber: blockNum, blockHash: block.hash ?? "",
            },
          });
        }

        // Only report whale-threshold transactions to the contract
        if (val < WATCH_THRESHOLD) continue;
        if (reporting) continue;
        reporting = true;

        // Push whale event IMMEDIATELY to dashboard — don't wait for RE round-trip
        push({
          type: "whale", receivedAt: Date.now(),
          raw: {
            from, to,
            amount: `0x${val.toString(16)}`,
            timestamp: `0x${Math.floor(Date.now()/1000).toString(16)}`,
            token: "STT", txHash, blockNumber: blockNum, blockHash: block.hash ?? "",
          },
        });

        try {
          const hash = await walClient.writeContract({
            address:      CONTRACT,
            abi:          TRACKER_ABI,
            functionName: "reportTransfer",
            args:         [from, to, val],
            chain:        somniaTestnet,
            account:      walClient.account!,
          });
          const usdEstimate = ethUsd > 0 ? sttAmount * ethUsd : 0;
          const label = usdEstimate > 0
            ? `~$${Math.round(usdEstimate).toLocaleString()} USD`
            : `${Math.round(sttAmount).toLocaleString()} STT`;
          console.log(`🌊 Real whale detected: ${label}  ${from.slice(0,8)}→${to.slice(0,8)}  tx:${hash.slice(0,10)}`);
        } catch (e: any) {
          if (!e?.message?.includes("below threshold")) {
            console.error("reportTransfer error:", e?.message?.split("\n")[0]);
          }
        } finally {
          reporting = false;
        }
      }
    },
    onError: (e) => console.error("Block watcher error:", e.message),
  });

  blockWatcher = unwatch;
  console.log(`✅ Real-chain block watcher started (STT threshold: ${Number(WATCH_THRESHOLD)/1e18} STT | ETH/USD: $${ethUsd.toFixed(2)})`);
}

// Auto-reconnect after WebSocket drop (debounced 3s)
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  console.warn("⚠ WebSocket closed — reconnecting in 3s...");
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try { await ensureSubscriptions(); console.log("✅ Reconnected."); }
    catch(e: any) { console.error("Reconnect failed:", e.message); scheduleReconnect(); }
  }, 3000);
}

// ── SDK subscriptions ─────────────────────────────────────────────────────────
async function ensureSubscriptions() {
  if (trackerSub && handlerSub && momentumSub && blockWatcher) return;
  await loadPastEvents();

  const CONTRACT = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS  as `0x${string}`;
  const HANDLER  = process.env.HANDLER_CONTRACT_ADDRESS      as `0x${string}`;
  const account  = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const pubClient = createPublicClient({ chain: somniaTestnet, transport: webSocket("wss://dream-rpc.somnia.network/ws") });
  const walClient = createWalletClient({ account, chain: somniaTestnet, transport: http("https://dream-rpc.somnia.network") });
  const sdk       = new SDK({ public: pubClient, wallet: walClient });

  const WHALE_TOPIC    = keccak256(toBytes("WhaleTransfer(address,address,uint256,uint256,string)"));
  const REACTED_TOPIC  = keccak256(toBytes("ReactedToWhaleTransfer(address,bytes32,address,address,uint256)"));
  const ALERT_TOPIC    = keccak256(toBytes("AlertThresholdCrossed(uint256,uint256)"));
  const MOMENTUM_TOPIC = keccak256(toBytes("WhaleMomentumDetected(uint256,uint256)"));

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
      onError: (e: Error) => {
        console.error("Tracker SDK error:", (e as any).shortMessage ?? e.message);
        if (e.message?.includes("socket") || e.message?.includes("closed")) { trackerSub = null; handlerSub = null; momentumSub = null; scheduleReconnect(); }
      },
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
      onError: (e: Error) => {
        console.error("Handler SDK error:", (e as any).shortMessage ?? e.message);
        if (e.message?.includes("socket") || e.message?.includes("closed")) { trackerSub = null; handlerSub = null; momentumSub = null; scheduleReconnect(); }
      },
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
      onError: (e: Error) => {
        console.error("Alert SDK error:", (e as any).shortMessage ?? e.message);
        if (e.message?.includes("socket") || e.message?.includes("closed")) { trackerSub = null; handlerSub = null; momentumSub = null; scheduleReconnect(); }
      },
    });

    if (r2 instanceof Error) {
      console.warn("⚠ Handler subscription failed:", r2.message);
    } else {
      handlerSub = r2;
      console.log("✅ WhaleHandler reaction subscription:", r2.subscriptionId);
    }
    if (!(r3 instanceof Error)) console.log("✅ WhaleHandler alert subscription:", r3.subscriptionId);

    // ── Momentum subscription ────────────────────────────────────────────────
    const r4 = await sdk.subscribe({
      ethCalls: [], eventContractSources: [HANDLER], topicOverrides: [MOMENTUM_TOPIC],
      onData: (data: any) => {
        try {
          const r = data?.result ?? data;
          const decoded = decodeEventLog({
            abi: MOMENTUM_ABI, data: r?.data as `0x${string}`,
            topics: r?.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          const a = decoded.args as any;
          push({
            type: "momentum", receivedAt: Date.now(),
            raw: {
              from: "", to: "", amount: "0x0",
              timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
              token: "", txHash: r?.transactionHash ?? "",
              blockNumber: r?.blockNumber ? BigInt(r.blockNumber).toString() : "",
              blockHash: "", reactionCount: a.burstCount?.toString() ?? "",
            },
          });
        } catch (e) { console.error("Momentum parse error:", e); }
      },
      onError: (e: Error) => {
        console.error("Momentum SDK error:", (e as any).shortMessage ?? e.message);
        if (e.message?.includes("socket") || e.message?.includes("closed")) { trackerSub = null; handlerSub = null; momentumSub = null; scheduleReconnect(); }
      },
    });
    if (!(r4 instanceof Error)) {
      momentumSub = r4;
      console.log("✅ WhaleMomentumDetected subscription:", r4.subscriptionId);
    }
  } else if (!HANDLER) {
    console.log("ℹ HANDLER_CONTRACT_ADDRESS not set — skipping Phase 2 subscriptions");
  }

  // Start real-chain watcher regardless of handler status
  if (!blockWatcher) {
    await startBlockWatcher(CONTRACT, walClient, pubClient);
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
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "init", alerts: alertCache, totalBlockTxsSeen, networkLargestSTT })}\n\n`));
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