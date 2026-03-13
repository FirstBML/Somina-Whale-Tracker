import { NextRequest } from "next/server";
import { SDK } from "@somnia-chain/reactivity";
import {
  createPublicClient, createWalletClient, webSocket, http,
  keccak256, toBytes, defineChain, parseAbiItem, decodeEventLog, parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import Database from 'better-sqlite3';

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

// Initialize database
const db = new Database('whales.db');

// Create tables on startup
db.exec(`
  CREATE TABLE IF NOT EXISTS whale_events (
    id TEXT PRIMARY KEY,
    type TEXT,
    from_addr TEXT,
    to_addr TEXT,
    amount TEXT,
    timestamp INTEGER,
    token TEXT,
    tx_hash TEXT,
    block_number INTEGER,
    block_hash TEXT
  );
  CREATE INDEX idx_timestamp ON whale_events(timestamp);
`);

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

// ABI matching deployed WhaleTracker.sol
const TRACKER_ABI = [
  {
    name: "reportTransfer", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "from",   type: "address" },
      { name: "to",     type: "address" },
      { name: "amount", type: "uint256" },
      { name: "token",  type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "setThreshold", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "_threshold", type: "uint256" }], outputs: [],
  },
  {
    name: "threshold", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "ThresholdUpdated", type: "event",
    inputs: [
      { name: "oldValue", type: "uint256", indexed: false },
      { name: "newValue", type: "uint256", indexed: false },
    ],
  },
] as const;

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

// Whale detection threshold for the dashboard block watcher.
// Catches any real STT value transfer (> 0). Zero-value contract calls are excluded.
// watchNetwork.ts independently uses its own 1 STT threshold for reportTransfer calls.
const WHALE_DISPLAY_THRESHOLD = 0n; // val > this = whale (so any val > 0 qualifies)

export type CacheEntry = {
  type: "whale" | "reaction" | "alert" | "momentum" | "block_tx" | "threshold_update";
  receivedAt: number;
  raw: {
    from: string; to: string; amount: string; timestamp: string; token: string;
    txHash: string; blockNumber: string; blockHash: string;
    reactionCount?: string; handlerEmitter?: string;
    oldValue?: string; newValue?: string;
    txFee?: string; // actual tx fee in STT (gasUsed × gasPrice from receipt); "~" prefix = estimated
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
const MAX_CACHE = 5000; 
const MAX_BLOCK_TX = 200_000;
const alertCache: CacheEntry[] = [];
let totalBlockTxsSeen = 0;
let networkLargestSTT = 0;
const BLOCK_TX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
let trackerSub:   { unsubscribe: () => Promise<any> } | null = null;
let handlerSub:   { unsubscribe: () => Promise<any> } | null = null;
let momentumSub:  { unsubscribe: () => Promise<any> } | null = null;
let blockWatcher: (() => void) | null = null;
const encoder     = new TextEncoder();
const controllers = new Set<ReadableStreamDefaultController>();

// ── Explorer aggregate stats (Blockscout API, refreshed every 5 min) ─────────
export type ExplorerStats = {
  txCount24h:   number; // total txns last 24h
  totalFees24h: number; // total fees in STT last 24h
  avgFee24h:    number; // avg fee per tx in STT last 24h
  fetchedAt:    number;
};
let explorerStats: ExplorerStats | null = null;

// Dedup — prevents same whale tx appearing twice when startBlockWatcher
// and trackerSub fire concurrently for the same hash. Set is atomic, no race.
const seenWhaleTxHashes = new Set<string>();
const MAX_SEEN_HASHES = 500;
const seenHashQueue: string[] = []; // FIFO for eviction
function markSeen(hash: string): boolean {
  if (seenWhaleTxHashes.has(hash)) return false; // already seen
  if (seenHashQueue.length >= MAX_SEEN_HASHES) {
    seenWhaleTxHashes.delete(seenHashQueue.shift()!);
  }
  seenWhaleTxHashes.add(hash);
  seenHashQueue.push(hash);
  return true; // first time seen
}

// ── File-based block_tx cache — survives server restarts ──────────────────────
const CACHE_FILE = join(process.cwd(), ".whale-block-tx-cache.json");

function loadBlockTxCache() {
  try {
    if (!existsSync(CACHE_FILE)) return;
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    if (!Array.isArray(raw.entries)) return;
    const cutoff = Date.now() - BLOCK_TX_WINDOW_MS;
    const entries: CacheEntry[] = raw.entries.filter((e: CacheEntry) => e.receivedAt >= cutoff);
    alertCache.push(...entries);
    totalBlockTxsSeen = raw.totalSeen ?? entries.length;
    networkLargestSTT = raw.largestSTT ?? 0;
    console.log(`📂 Loaded ${entries.length} block_tx from cache (${raw.entries.length - entries.length} expired)`);
  } catch (e: any) {
    console.warn("⚠ block_tx cache load failed (non-critical):", e.message);
  }
}

function saveBlockTxCache() {
  try {
    // Cap at 10k entries to avoid JSON.stringify stack overflow on large arrays
    const entries = alertCache.filter(e => e.type === "block_tx").slice(-10_000);
    writeFileSync(CACHE_FILE, JSON.stringify({ entries, totalSeen: totalBlockTxsSeen, largestSTT: networkLargestSTT }));
  } catch {}
}

// Save cache every 2 minutes
setInterval(saveBlockTxCache, 2 * 60_000);

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
    // Hard cap: if still over MAX_BLOCK_TX, evict oldest block_tx
    const blockTxCount = alertCache.filter(e => e.type === "block_tx").length;
    if (blockTxCount >= MAX_BLOCK_TX) {
      const idx = alertCache.findIndex(e => e.type === "block_tx");
      if (idx !== -1) alertCache.splice(idx, 1);
    }
  } else {
    if (alertCache.filter(e => e.type !== "block_tx").length >= MAX_CACHE) {
      const idx = alertCache.findIndex(e => e.type !== "block_tx");
      if (idx !== -1) alertCache.splice(idx, 1);
    }
  }
  alertCache.push(entry);
  broadcast(entry);

  if (entry.type !== "block_tx") {  // Skip block_tx to save space
    db.prepare(`
      INSERT OR REPLACE INTO whale_events 
      (id, type, from_addr, to_addr, amount, timestamp, token, tx_hash, block_number, block_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${entry.receivedAt}-${Math.random()}`,
      entry.type,
      entry.raw.from,
      entry.raw.to,
      entry.raw.amount,
      entry.receivedAt,
      entry.raw.token,
      entry.raw.txHash,
      entry.raw.blockNumber,
      entry.raw.blockHash
    );
  }
}

// ── NEW: Function to get historical events from database ───────────────────
function getHistoricalEvents(timeRangeMs: number): CacheEntry[] {
  const cutoff = Date.now() - timeRangeMs;
  const rows = db.prepare(`
    SELECT * FROM whale_events 
    WHERE timestamp > ? 
    ORDER BY timestamp DESC 
    LIMIT 1000
  `).all(cutoff);
  
  // Convert DB rows back to CacheEntry format
  return rows.map((row: any) => ({
    type: row.type,
    receivedAt: row.timestamp,
    raw: {
      from: row.from_addr,
      to: row.to_addr,
      amount: row.amount,
      timestamp: `0x${Math.floor(row.timestamp/1000).toString(16)}`,
      token: row.token,
      txHash: row.tx_hash,
      blockNumber: row.block_number.toString(),
      blockHash: row.block_hash,
      txFee: "0", // Default value since we don't store this
    }
  })) as CacheEntry[];
}

// ── Actual fee from receipt ──────────────────────────────────────────────────
// Fetches the real fee (gasUsed × effectiveGasPrice) for a transaction.
// Much more accurate than gasLimit × gasPrice which overestimates by ~30–50%.
async function fetchActualFee(
  pub: ReturnType<typeof createPublicClient>,
  txHash: `0x${string}`,
): Promise<string> {
  try {
    const receipt = await pub.getTransactionReceipt({ hash: txHash });
    const fee = Number(receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n)) / 1e18;
    return fee > 0 ? fee.toFixed(8) : "0";
  } catch { return ""; } // empty = unknown, not estimated
}

// ── Startup 30-day eviction ──────────────────────────────────────────────────
// Purges entries older than 30 days from alertCache. Called at startup so stale
// cached data never pollutes a fresh session.
function evictExpiredEntries() {
  const cutoff = Date.now() - BLOCK_TX_WINDOW_MS;
  const before = alertCache.length;
  for (let i = alertCache.length - 1; i >= 0; i--) {
    if (alertCache[i].receivedAt < cutoff) alertCache.splice(i, 1);
  }
  const removed = before - alertCache.length;
  if (removed > 0) console.log(`🗑 Evicted ${removed} entries older than 30d on startup`);
}


// ── Explorer aggregate stats (Blockscout /api) ───────────────────────────────
// Blockscout exposes module=stats endpoints. We pull the daily transaction count
// and fee totals. Falls back gracefully if the API is unavailable.
const EXPLORER_BASE = "https://shannon-explorer.somnia.network";

async function fetchExplorerStats(): Promise<void> {
  try {
    // Blockscout stats API — returns network-wide daily stats
    const [statsRes, feeRes] = await Promise.allSettled([
      fetch(`${EXPLORER_BASE}/api?module=stats&action=ethsupply`),
      fetch(`${EXPLORER_BASE}/api/v2/stats`),
    ]);

    // Try v2 stats endpoint (newer Blockscout)
    if (feeRes.status === "fulfilled" && feeRes.value.ok) {
      const data = await feeRes.value.json();
      // Blockscout v2 /api/v2/stats returns: { transactions_today, gas_used_today, ... }
      const txCount  = data.transactions_today ?? data.transaction_count_today ?? 0;
      const gasUsed  = BigInt(data.gas_used_today ?? "0");
      // Somnia avg gas price ≈ 6 Gwei = 6e9 wei
      const AVG_GAS_PRICE = 6_000_000_000n;
      const totalFeesWei  = gasUsed * AVG_GAS_PRICE;
      const totalFees24h  = Number(totalFeesWei) / 1e18;
      const avgFee24h     = txCount > 0 ? totalFees24h / txCount : 0;
      explorerStats = { txCount24h: txCount, totalFees24h, avgFee24h, fetchedAt: Date.now() };
      console.log(`📡 Explorer stats: ${txCount.toLocaleString()} txns/24h · ${totalFees24h.toFixed(2)} STT fees`);
      broadcastExplorerStats();
      return;
    }

    // Fallback: derive from our own block watcher counters
    const blockTxs24h = alertCache.filter(
      e => e.type === "block_tx" && e.receivedAt >= Date.now() - 24 * 60 * 60_000
    );
    if (blockTxs24h.length > 0) {
      const totalFees24h = blockTxs24h.reduce((s, e) => {
        const f = parseFloat(e.raw.txFee?.replace("~","") ?? "0");
        return s + (isNaN(f) ? 0 : f);
      }, 0);
      explorerStats = {
        txCount24h:   totalBlockTxsSeen,
        totalFees24h,
        avgFee24h:    blockTxs24h.length > 0 ? totalFees24h / blockTxs24h.length : 0,
        fetchedAt:    Date.now(),
      };
      broadcastExplorerStats();
    }
  } catch (e: any) {
    console.warn("⚠ Explorer stats fetch failed (non-critical):", e.message?.split("\n")[0]);
  }
}

function broadcastExplorerStats() {
  if (!explorerStats) return;
  const msg = encoder.encode(`data: ${JSON.stringify({ type: "explorer_stats", stats: explorerStats })}\n\n`);
  controllers.forEach(c => { try { c.enqueue(msg); } catch {} });
}

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

// ── Historical block_tx backfill ──────────────────────────────────────────────
// Runs in background (non-blocking). Scans newest→oldest so MAX_BLOCK_TX fills
// with the most recent transactions first — ensures QUICK filters show real data.
async function loadRecentBlockTxs() {
  const pub = createPublicClient({ chain: somniaTestnet, transport: http("https://dream-rpc.somnia.network") });
  try {
    const latest  = await pub.getBlockNumber();
    // 30 days at 10 blocks/s = 25,920,000 blocks. Backfill stops early at MAX_BLOCK_TX
    // so in practice only the most recent data fills the buffer — LOOKBACK just sets
    // the maximum historical window the watcher will attempt to cover.
    const LOOKBACK = 25_920_000n;
    const oldest   = latest > LOOKBACK ? latest - LOOKBACK : 0n;
    const BATCH    = 100;  // 100 concurrent block fetches per batch
    const DELAY    = 100;  // ms between batches

    // Build a Set of already-cached tx hashes for O(1) dedup
    const cachedHashes = new Set(
      alertCache.filter(e => e.type === "block_tx").map(e => e.raw.txHash)
    );

    let loaded  = 0;
    let scanned = 0;
    let cursor  = latest;

    console.log(`📊 Backfilling block_tx (7d window, ${cachedHashes.size} already cached)…`);

    while (cursor > oldest) {
      if (alertCache.filter(e => e.type === "block_tx").length >= MAX_BLOCK_TX) {
        console.log(`📊 block_tx cache full at ${MAX_BLOCK_TX}`);
        break;
      }

      const batch: bigint[] = [];
      for (let i = 0; i < BATCH && cursor > oldest; i++, cursor--) batch.push(cursor);
      scanned += batch.length;

      const results = await Promise.allSettled(
        batch.map(n => pub.getBlock({ blockNumber: n, includeTransactions: true }))
      );
      for (const r of results) {
        if (r.status !== "fulfilled" || !r.value?.transactions?.length) continue;
        const block = r.value;
        const blockTs = Number(block.timestamp) * 1000;

        for (const tx of block.transactions as any[]) {
          if (typeof tx !== "object" || !tx.hash) continue;
          if (cachedHashes.has(tx.hash)) continue; // skip already-loaded

          const val       = tx.value ?? 0n;
          const sttAmount = Number(val) / 1e18;
          const gasP = (tx as any).gasPrice ?? (tx as any).maxFeePerGas ?? 0n;
          const gasL = (tx as any).gas ?? 21000n;
          const feeSTT = (typeof gasP === "bigint" ? Number(gasP * gasL) : 0) / 1e18;

          totalBlockTxsSeen++;
          if (sttAmount > networkLargestSTT) networkLargestSTT = sttAmount;
          cachedHashes.add(tx.hash);

          if (alertCache.filter(e => e.type === "block_tx").length < MAX_BLOCK_TX) {
            alertCache.push({
              type: "block_tx", receivedAt: blockTs,
              raw: {
                from:        (tx.from ?? "") as string,
                to:          (tx.to  ?? "0x0000000000000000000000000000000000000000") as string,
                amount:      sttAmount > 0 ? sttAmount.toFixed(8) : "0",
                timestamp:   `0x${Math.floor(blockTs / 1000).toString(16)}`,
                token:       "STT", txHash: tx.hash,
                blockNumber: block.number?.toString() ?? "",
                blockHash:   block.hash ?? "",
                txFee:       feeSTT > 0 ? `~${feeSTT.toFixed(8)}` : "0",
              },
            });
            loaded++;
          }

          // Also push as historical whale event for the Live Feed (value-only, cap 2000)
          if (val > 0n && alertCache.filter(e => e.type === "whale").length < 2000) {
            alertCache.push({
              type: "whale", receivedAt: blockTs,
              raw: {
                from:        (tx.from ?? "") as string,
                to:          (tx.to  ?? "0x0000000000000000000000000000000000000000") as string,
                amount:      sttAmount.toFixed(8),
                timestamp:   `0x${Math.floor(blockTs / 1000).toString(16)}`,
                token:       "STT", txHash: tx.hash,
                blockNumber: block.number?.toString() ?? "",
                blockHash:   block.hash ?? "",
                txFee:       feeSTT > 0 ? `~${feeSTT.toFixed(8)}` : "0",
              },
            });
          }
        }
      }

      if (scanned % 50_000 === 0) console.log(`📊 Scanned ${scanned} blocks, loaded ${loaded} new txns…`);
      await new Promise(r => setTimeout(r, DELAY));
    }
    console.log(`✅ Block_tx backfill: ${loaded} new txns loaded (${scanned} blocks scanned)`);
    saveBlockTxCache(); // persist immediately after backfill
  } catch (e: any) {
    console.warn("⚠ Block_tx backfill failed (non-critical):", e.message?.split("\n")[0]);
  }
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

  // Refresh explorer aggregate stats every 5 minutes
  setInterval(() => fetchExplorerStats().catch(() => {}), 5 * 60_000);

  // Fast HTTP polling for full blocks — WebSocket watchBlocks on Somnia only gets headers,
  // then viem fetches full block separately which can't keep up at 0.1s block times.
  // HTTP polling at 500ms fetches full blocks with transactions in one call, reliably.
  const unwatch = httpPub.watchBlocks({
    includeTransactions: true,
    pollingInterval: 500,   // 500ms — fast enough to catch most blocks without flooding
    onBlock: async (block) => {
      if (!block?.transactions) return;
      for (const tx of block.transactions) {
        if (typeof tx !== "object") continue;
        const val  = tx.value ?? 0n;
        const from = tx.from as `0x${string}`;
        const to   = (tx.to ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
        const sttAmount = Number(val) / 1e18;
        const txHash = tx.hash ?? "";
        const blockNum = block.number?.toString() ?? "";
        const ts = `0x${Math.floor(Date.now() / 1000).toString(16)}`;
        // Estimate tx fee: gasPrice × gasLimit / 1e18 (max, not actual used gas)
        const gasP = (tx as any).gasPrice ?? (tx as any).maxFeePerGas ?? 0n;
        const gasL = (tx as any).gas ?? 21000n;
        // "~" prefix = estimated (gasPrice × gasLimit). Actual fee uses gasUsed from receipt.
        const estFeeSTT = (typeof gasP === "bigint" ? Number(gasP * gasL) : 0) / 1e18;

        // Push ALL transactions as block_tx for network monitoring (estimated fee)
        if (tx.hash) {
          push({
            type: "block_tx", receivedAt: Date.now(),
            raw: {
              from, to,
              amount: sttAmount > 0 ? sttAmount.toFixed(8) : "0",
              timestamp: ts, token: "STT",
              txHash, blockNumber: blockNum, blockHash: block.hash ?? "",
              txFee: estFeeSTT > 0 ? `~${estFeeSTT.toFixed(8)}` : "0",
            },
          });
        }

        // Only push as whale if actual STT value transferred (> 0).
        // Fetch actual receipt fee async — update entry when available.
        if (val > WHALE_DISPLAY_THRESHOLD && txHash && markSeen(txHash)) {
          const entry: CacheEntry = {
            type: "whale", receivedAt: Date.now(),
            raw: {
              from, to,
              amount: `0x${val.toString(16)}`,
              timestamp: `0x${Math.floor(Date.now()/1000).toString(16)}`,
              token: "STT", txHash, blockNumber: blockNum, blockHash: block.hash ?? "",
              txFee: estFeeSTT > 0 ? `~${estFeeSTT.toFixed(8)}` : "0",
            },
          };
          push(entry);
          const usdEstimate = ethUsd > 0 ? sttAmount * ethUsd : 0;
          const label = usdEstimate > 0 ? `~$${Math.round(usdEstimate).toLocaleString()} USD` : `${sttAmount.toFixed(4)} STT`;
          console.log(`🌊 Whale detected: ${label}  ${from.slice(0,8)}→${to.slice(0,8)}  tx:${txHash.slice(0,10)}`);

          // Fetch actual fee from receipt in background — updates entry in-place + re-broadcasts
          if (txHash) {
            fetchActualFee(httpPub, txHash as `0x${string}`).then(actualFee => {
              if (!actualFee) return; // receipt not available
              // Find and patch the entry in alertCache
              const idx = alertCache.findIndex(e => e.type === "whale" && e.raw.txHash === txHash);
              if (idx !== -1) {
                alertCache[idx].raw.txFee = actualFee;
                // Broadcast updated entry
                const msg = encoder.encode(`data: ${JSON.stringify({ ...alertCache[idx], type: "whale_fee_update", txHash, txFee: actualFee })}\n\n`);
                controllers.forEach(c => { try { c.enqueue(msg); } catch {} });
              }
            }).catch(() => {});
          }
        }
      }
    },
    onError: (e) => console.error("Block watcher error:", e.message),
  });

  blockWatcher = unwatch;
  console.log(`✅ Real-chain block watcher started (whale threshold: any STT value > 0 | ETH/USD: $${ethUsd.toFixed(2)})`);
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
  loadBlockTxCache();               // sync — fast disk read, pre-fills cache immediately
  evictExpiredEntries();            // sync — purge anything older than 30d from cache
  loadPastEvents().catch(() => {}); // async — scans chain for past whale events
  loadRecentBlockTxs().catch(() => {}); // async — backfills block_tx
  fetchExplorerStats().catch(() => {}); // async — pull 24h aggregate stats from explorer

  const CONTRACT = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS  as `0x${string}`;
  const HANDLER  = process.env.HANDLER_CONTRACT_ADDRESS      as `0x${string}`;
  const account  = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const pubClient = createPublicClient({ chain: somniaTestnet, transport: webSocket("wss://dream-rpc.somnia.network/ws") });
  const walClient = createWalletClient({ account, chain: somniaTestnet, transport: http("https://dream-rpc.somnia.network") });
  const sdk       = new SDK({ public: pubClient, wallet: walClient });

  const WHALE_TOPIC     = keccak256(toBytes("WhaleTransfer(address,address,uint256,uint256,string)"));
  const REACTED_TOPIC   = keccak256(toBytes("ReactedToWhaleTransfer(address,bytes32,address,address,uint256)"));
  const ALERT_TOPIC     = keccak256(toBytes("AlertThresholdCrossed(uint256,uint256)"));
  const MOMENTUM_TOPIC  = keccak256(toBytes("WhaleMomentumDetected(uint256,uint256)"));
  const THRESHOLD_TOPIC = keccak256(toBytes("ThresholdUpdated(uint256,uint256)"));

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

          const txHash = r?.transactionHash ?? "";
          const entry: CacheEntry = {
            type: "whale",
            receivedAt: Date.now(),
            raw: {
              from:        a.from,
              to:          a.to,
              amount:      `0x${amount.toString(16)}`,
              timestamp:   `0x${BigInt(a.timestamp).toString(16)}`,
              token:       a.token ?? "STT",
              txHash,
              blockNumber: r?.blockNumber ? BigInt(r.blockNumber).toString() : "",
              blockHash:   r?.blockHash ?? "",
            },
          };

          // If startBlockWatcher already pushed this tx, skip the SSE push
          // but still update leaderboard (it has the correct on-chain data).
          if (txHash && !markSeen(txHash)) {
            updateLeaderMap(a.from, a.to, amount, ts);
          } else {
            push(entry);
            updateLeaderMap(a.from, a.to, amount, ts);
          }

          // Always persist leaderboard regardless of dedup
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

    // ── ThresholdUpdated subscription — broadcast to dashboard ───────────────
    await sdk.subscribe({
      ethCalls: [], eventContractSources: [CONTRACT], topicOverrides: [THRESHOLD_TOPIC],
      onData: (data: any) => {
        try {
          const r = data?.result ?? data;
          const decoded = decodeEventLog({
            abi: TRACKER_ABI, data: r?.data as `0x${string}`,
            topics: r?.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          const a = decoded.args as any;
          const newVal = Number(a.newValue) / 1e18;
          const oldVal = Number(a.oldValue) / 1e18;
          console.log(`⚙ Threshold updated: ${oldVal} → ${newVal} STT`);
          broadcast({
            type: "threshold_update", receivedAt: Date.now(),
            raw: { from:"", to:"", amount:"0", timestamp:"0x0", token:"", txHash:"", blockNumber:"", blockHash:"", oldValue: oldVal.toString(), newValue: newVal.toString() },
          });
        } catch (e) { console.error("ThresholdUpdated parse error:", e); }
      },
      onError: (e: Error) => console.error("Threshold SDK error:", e.message),
    });
  } else if (!HANDLER) {
    console.log("ℹ HANDLER_CONTRACT_ADDRESS not set — skipping Phase 2 subscriptions");
  }

  // Start real-chain watcher regardless of handler status
  if (!blockWatcher) {
    await startBlockWatcher(CONTRACT, walClient, pubClient);
  }
}

// ── SSE endpoint ──────────────────────────────────────────────────────────────
// Start subscriptions immediately when the module loads — not on first SSE request.
// This means by the time the browser connects, cache + subscriptions are already running.
let initStarted = false;
(function kickstart() {
  if (initStarted) return;
  initStarted = true;
  ensureSubscriptions().catch(e => {
    initStarted = false;
    console.error("Subscription init error:", e.message);
  });
})();

export async function GET(req: NextRequest) {
  // ensureSubscriptions already running from module load.
  // If it failed and initStarted reset to false, try again here.
  if (!initStarted) {
    initStarted = true;
    ensureSubscriptions().catch(e => { initStarted = false; });
  }

  // ── NEW: Get 7 days of historical data from database ────────────────────
  const timeRange = 7 * 24 * 60 * 60 * 1000; // 7 days
  const historicalEvents = getHistoricalEvents(timeRange);
  
  // Combine with current cache (avoid duplicates by txHash)
  const allAlerts = [...historicalEvents, ...alertCache];
  
  // Optional: Remove duplicates by txHash if needed
  const uniqueAlerts = Array.from(
    new Map(allAlerts.map(item => [item.raw.txHash, item])).values()
  );

  const stream = new ReadableStream({
    start(controller) {
      controllers.add(controller);
      
      // ── MODIFIED: Send combined historical + current data ─────────────────
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ 
        type: "init", 
        alerts: uniqueAlerts,  // Now includes 7 days of history!
        totalBlockTxsSeen, 
        networkLargestSTT, 
        explorerStats 
      })}\n\n`));
      
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