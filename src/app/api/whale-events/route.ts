import { NextRequest } from "next/server";
import { SDK } from "@somnia-chain/reactivity";
import {
  createPublicClient, createWalletClient, webSocket, http,
  keccak256, toBytes, defineChain, decodeEventLog, parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { enqueue as enqueueLeaderboard } from "../streams-leaderboard/route";
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
    block_timestamp INTEGER,
    token TEXT,
    tx_hash TEXT UNIQUE,
    block_number INTEGER,
    block_hash TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_timestamp ON whale_events(timestamp);
  CREATE INDEX IF NOT EXISTS idx_block_timestamp ON whale_events(block_timestamp);

  CREATE TABLE IF NOT EXISTS block_tx_events (
    id TEXT PRIMARY KEY,
    from_addr TEXT,
    to_addr TEXT,
    amount TEXT,
    is_transfer INTEGER,
    tx_hash TEXT UNIQUE,
    block_number TEXT,
    block_hash TEXT,
    tx_fee TEXT,
    received_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_block_tx_received_at ON block_tx_events(received_at);
`);

// ── Migrations — safe to run on existing DB ───────────────────────────────────
try { db.exec(`ALTER TABLE whale_events ADD COLUMN block_timestamp INTEGER`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_whale_tx_hash ON whale_events(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash != ''`); } catch {}

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

// ============= FIX 1: Set proper whale threshold (1 STT) =============
const WHALE_DISPLAY_THRESHOLD = parseEther("1"); // 1 STT minimum for whale

export type CacheEntry = {
  type: "whale" | "reaction" | "alert" | "momentum" | "block_tx" | "threshold_update" | "whale_pending";
  receivedAt: number;
  raw: {
    from: string; to: string; amount: string; timestamp: string; token: string;
    txHash: string; blockNumber: string; blockHash: string;
    reactionCount?: string; handlerEmitter?: string;
    oldValue?: string; newValue?: string;
    txFee?: string;
  };
};

// ── In-memory leaderboard ───────────────────────────────────────────────────
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

function persistLeaderEntry(wallet: string, entry: LeaderEntry) {
  try {
    enqueueLeaderboard({
      wallet,
      totalVolume: entry.totalVolume.toString(),
      txCount:     entry.txCount,
      lastSeen:    entry.lastSeen,
    });
  } catch (e) {
    console.error("streams persist error:", e);
  }
}

// ── Server state ──────────────────────────────────────────────────────────────
const MAX_CACHE = 5000;
const alertCache: CacheEntry[] = [];
let totalBlockTxsSeen = 0;
let networkLargestSTT = 0;
const BLOCK_TX_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
let trackerSub:   { unsubscribe: () => Promise<any> } | null = null;
let handlerSub:   { unsubscribe: () => Promise<any> } | null = null;
let momentumSub:  { unsubscribe: () => Promise<any> } | null = null;
let blockWatcher: (() => void) | null = null;
let backfillRunning = false;
const encoder     = new TextEncoder();
const controllers = new Set<ReadableStreamDefaultController>();
let nonBlockTxCount = 0;

export type ExplorerStats = {
  txCount24h:   number;
  totalFees24h: number;
  avgFee24h:    number;
  fetchedAt:    number;
};
let explorerStats: ExplorerStats | null = null;

// ============= FIX 2: Separate dedup sets for SDK vs block watcher =============
const seenBlockTxHashes = new Set<string>();
const seenSDKContentKeys = new Set<string>();
const MAX_SEEN_HASHES = 10_000;
const blockHashQueue: string[] = [];
const sdkKeyQueue: string[] = [];

function markBlockSeen(hash: string): boolean {
  if (seenBlockTxHashes.has(hash)) return false;
  if (blockHashQueue.length >= MAX_SEEN_HASHES) {
    seenBlockTxHashes.delete(blockHashQueue.shift()!);
  }
  seenBlockTxHashes.add(hash);
  blockHashQueue.push(hash);
  return true;
}

function markSDKSeen(key: string): boolean {
  if (seenSDKContentKeys.has(key)) return false;
  if (sdkKeyQueue.length >= MAX_SEEN_HASHES) {
    seenSDKContentKeys.delete(sdkKeyQueue.shift()!);
  }
  seenSDKContentKeys.add(key);
  sdkKeyQueue.push(key);
  return true;
}

// ── SQLite-backed block_tx persistence ───────────────────────────────────────
const insertBlockTx = db.prepare(`
  INSERT OR IGNORE INTO block_tx_events
  (id, from_addr, to_addr, amount, is_transfer, tx_hash, block_number, block_hash, tx_fee, received_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function loadBlockTxFromDb() {
  const cutoff = Date.now() - BLOCK_TX_WINDOW_MS;
  const rows = db.prepare(
    `SELECT * FROM block_tx_events WHERE received_at >= ? ORDER BY received_at ASC`
  ).all(cutoff) as any[];
  if (!rows.length) return;
  for (const row of rows) {
    const amountRaw = parseFloat(row.amount ?? "0");
    if (amountRaw > networkLargestSTT) networkLargestSTT = amountRaw;
    alertCache.push({
      type: "block_tx",
      receivedAt: row.received_at,
      raw: {
        from:        row.from_addr,
        to:          row.to_addr,
        amount:      row.amount,
        timestamp:   `0x${Math.floor(row.received_at / 1000).toString(16)}`,
        token:       "STT",
        txHash:      row.tx_hash,
        blockNumber: row.block_number,
        blockHash:   row.block_hash,
        txFee:       row.tx_fee ?? "0",
      },
    });
  }
  totalBlockTxsSeen = rows.length;
  console.log(`📂 Loaded ${rows.length} block_tx from SQLite (last 24h)`);
}

setInterval(() => {
  const cutoff = Date.now() - BLOCK_TX_WINDOW_MS;
  const { changes } = db.prepare(`DELETE FROM block_tx_events WHERE received_at < ?`).run(cutoff);
  if (changes > 0) console.log(`🗑 Evicted ${changes} expired block_tx rows from SQLite`);
}, 6 * 60 * 60_000);

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
    const amt = parseFloat((entry.raw as any)?.amount ?? "0");
    if (amt > networkLargestSTT) networkLargestSTT = amt;

    const cutoff = Date.now() - BLOCK_TX_WINDOW_MS;
    let i = 0;
    while (i < alertCache.length && alertCache[i].type === "block_tx" && alertCache[i].receivedAt < cutoff) i++;
    if (i > 0) alertCache.splice(0, i);

    try {
      insertBlockTx.run(
        `btx-${entry.receivedAt}-${Math.random()}`,
        entry.raw.from,
        entry.raw.to,
        entry.raw.amount,
        amt > 0 ? 1 : 0,
        entry.raw.txHash,
        entry.raw.blockNumber,
        entry.raw.blockHash,
        entry.raw.txFee ?? "0",
        entry.receivedAt,
      );
    } catch {} // IGNORE duplicate tx_hash
  } else {
    if (nonBlockTxCount >= MAX_CACHE) {
      const idx = alertCache.findIndex(e => e.type !== "block_tx");
      if (idx !== -1) { alertCache.splice(idx, 1); nonBlockTxCount--; }
    }
    nonBlockTxCount++;
  }
  alertCache.push(entry);
  broadcast(entry);

  // Only persist confirmed whales (with txHash) to database
  if (entry.type === "whale" && entry.raw.txHash) {
    const blockTs = (() => {
      try { const t = Number(BigInt(entry.raw.timestamp ?? "0x0")) * 1000; return t > 0 ? t : entry.receivedAt; }
      catch { return entry.receivedAt; }
    })();
    
    db.prepare(`
      INSERT OR IGNORE INTO whale_events
      (id, type, from_addr, to_addr, amount, timestamp, block_timestamp, token, tx_hash, block_number, block_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${entry.receivedAt}-${Math.random()}`,
      entry.type,
      entry.raw.from,
      entry.raw.to,
      entry.raw.amount,
      entry.receivedAt,
      blockTs,
      entry.raw.token,
      entry.raw.txHash,
      entry.raw.blockNumber || null,
      entry.raw.blockHash || null,
    );
  }
}

function getHistoricalEvents(timeRangeMs: number): CacheEntry[] {
  const cutoff = Date.now() - timeRangeMs;
  const rows = db.prepare(`
    SELECT * FROM whale_events 
    WHERE block_timestamp > ? 
    ORDER BY block_timestamp DESC 
    LIMIT 1000
  `).all(cutoff);
  
  return rows.map((row: any) => ({
    type: row.type,
    receivedAt: row.timestamp,
    raw: {
      from:        row.from_addr ?? "",
      to:          row.to_addr ?? "",
      amount:      row.amount ?? "0x0",
      timestamp:   `0x${Math.floor(row.block_timestamp / 1000).toString(16)}`,
      token:       row.token ?? "",
      txHash:      row.tx_hash ?? "",
      blockNumber: row.block_number?.toString() ?? "",
      blockHash:   row.block_hash ?? "",
      txFee:       "0",
    }
  })) as CacheEntry[];
}

function seedWhaleEventsFromDb() {
  const SEVEN_DAYS = 7 * 24 * 60 * 60_000;
  const dbWhales   = getHistoricalEvents(SEVEN_DAYS);
  if (!dbWhales.length) {
    console.log("No historical whale events found in database");
    return;
  }
  const seenHashes = new Set(alertCache.map(e => e.raw.txHash).filter(Boolean));
  let seeded = 0;
  for (const entry of dbWhales) {
    if (entry.raw.txHash && seenHashes.has(entry.raw.txHash)) continue;
    alertCache.push(entry);
    if (entry.raw.txHash) {
      seenHashes.add(entry.raw.txHash);
      markBlockSeen(entry.raw.txHash);
    }
    seeded++;
  }
  if (seeded > 0) console.log(`📂 Seeded ${seeded} whale events from SQLite`);
}

async function fetchActualFee(
  pub: ReturnType<typeof createPublicClient>,
  txHash: `0x${string}`,
): Promise<string> {
  try {
    const receipt = await pub.getTransactionReceipt({ hash: txHash });
    const fee = Number(receipt.gasUsed * (receipt.effectiveGasPrice ?? 0n)) / 1e18;
    return fee > 0 ? fee.toFixed(8) : "0";
  } catch { return ""; }
}

function evictExpiredEntries() {
  const cutoff = Date.now() - BLOCK_TX_WINDOW_MS;
  const before = alertCache.length;
  for (let i = alertCache.length - 1; i >= 0; i--) {
    if (alertCache[i].type === "block_tx" && alertCache[i].receivedAt < cutoff) {
      alertCache.splice(i, 1);
    }
  }
  const removed = before - alertCache.length;
  if (removed > 0) console.log(`🗑 Evicted ${removed} expired block_tx entries from cache`);
}

const EXPLORER_BASE = "https://shannon-explorer.somnia.network";

async function fetchExplorerStats(): Promise<void> {
  try {
    const [statsRes, feeRes] = await Promise.allSettled([
      fetch(`${EXPLORER_BASE}/api?module=stats&action=ethsupply`),
      fetch(`${EXPLORER_BASE}/api/v2/stats`),
    ]);

    if (feeRes.status === "fulfilled" && feeRes.value.ok) {
      const data = await feeRes.value.json();
      const txCount  = data.transactions_today ?? data.transaction_count_today ?? 0;
      const gasUsed  = BigInt(data.gas_used_today ?? "0");
      const AVG_GAS_PRICE = 6_000_000_000n;
      const totalFeesWei  = gasUsed * AVG_GAS_PRICE;
      const totalFees24h  = Number(totalFeesWei) / 1e18;
      const avgFee24h     = txCount > 0 ? totalFees24h / txCount : 0;
      explorerStats = { txCount24h: txCount, totalFees24h, avgFee24h, fetchedAt: Date.now() };
      console.log(`📡 Explorer stats: ${txCount.toLocaleString()} txns/24h · ${totalFees24h.toFixed(2)} STT fees`);
      broadcastExplorerStats();
      return;
    }

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

async function loadRecentBlockTxs() {
  if (backfillRunning) {
    console.log("⏭ Backfill already running — skipping duplicate start");
    return;
  }
  backfillRunning = true;
  const pub = createPublicClient({ chain: somniaTestnet, transport: http("https://dream-rpc.somnia.network") });
  try {
    const latest  = await pub.getBlockNumber();
    const LOOKBACK = 36_000n;
    const oldest   = latest > LOOKBACK ? latest - LOOKBACK : 0n;
    const BATCH    = 10;
    const DELAY    = 200;

    const cachedHashes = new Set(
      alertCache.filter(e => e.type === "block_tx").map(e => e.raw.txHash)
    );

    let loaded  = 0;
    let scanned = 0;
    let cursor  = latest;

    console.log(`📊 Backfilling block_tx (1h window, ${cachedHashes.size} already cached)…`);

    while (cursor > oldest) {
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
          if (cachedHashes.has(tx.hash)) continue;

          const val       = tx.value ?? 0n;
          const sttAmount = Number(val) / 1e18;
          const gasP = (tx as any).gasPrice ?? (tx as any).maxFeePerGas ?? 0n;
          const gasL = (tx as any).gas ?? 21000n;
          const feeSTT = (typeof gasP === "bigint" ? Number(gasP * gasL) : 0) / 1e18;

          cachedHashes.add(tx.hash);

          push({
            type: "block_tx", receivedAt: Date.now(),
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
      }

      if (scanned % 1000 === 0) console.log(`📊 Scanned ${scanned} blocks, loaded ${loaded} new txns…`);
      await new Promise(r => setTimeout(r, DELAY));
    }
    console.log(`✅ Block_tx backfill: ${loaded} new txns loaded (${scanned} blocks scanned)`);
  } catch (e: any) {
    console.warn("⚠ Block_tx backfill failed (non-critical):", e.message?.split("\n")[0]);
  } finally {
    backfillRunning = false;
  }
}

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

  let ethUsd = await getEthUsdPrice(httpPub);
  setInterval(async () => { ethUsd = await getEthUsdPrice(httpPub) || ethUsd; }, 120_000);
  console.log(`💰 ETH/USD oracle price: $${ethUsd.toFixed(2)} (Protofire)`);

  setInterval(() => fetchExplorerStats().catch(() => {}), 60_000);

  const unwatch = httpPub.watchBlocks({
    includeTransactions: true,
    pollingInterval: 500,
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
        const blockTs = block.timestamp ? Number(block.timestamp) * 1000 : Date.now();
        const ts = `0x${Math.floor(blockTs / 1000).toString(16)}`;
        const gasP = (tx as any).gasPrice ?? (tx as any).maxFeePerGas ?? 0n;
        const gasL = (tx as any).gas ?? 21000n;
        const estFeeSTT = (typeof gasP === "bigint" ? Number(gasP * gasL) : 0) / 1e18;

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

        // ============= FIX: Only process whales with txHash and above threshold =============
        if (val >= WHALE_DISPLAY_THRESHOLD && txHash && markBlockSeen(txHash)) {
          const entry: CacheEntry = {
            type: "whale", receivedAt: Date.now(),
            raw: {
              from, to,
              amount: `0x${val.toString(16)}`,
              timestamp: ts,
              token: "STT", txHash, blockNumber: blockNum, blockHash: block.hash ?? "",
              txFee: estFeeSTT > 0 ? `~${estFeeSTT.toFixed(8)}` : "0",
            },
          };
          push(entry);
          const usdEstimate = ethUsd > 0 ? sttAmount * ethUsd : 0;
          const label = usdEstimate > 0 ? `~$${Math.round(usdEstimate).toLocaleString()} USD` : `${sttAmount.toFixed(4)} STT`;
          console.log(`🌊 Whale detected: ${label}  ${from.slice(0,8)}→${to.slice(0,8)}  tx:${txHash.slice(0,10)}`);

          if (txHash) {
            fetchActualFee(httpPub, txHash as `0x${string}`).then(actualFee => {
              if (!actualFee) return;
              const idx = alertCache.findIndex(e => e.type === "whale" && e.raw.txHash === txHash);
              if (idx !== -1) {
                alertCache[idx].raw.txFee = actualFee;
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
  console.log(`✅ Real-chain block watcher started (whale threshold: 1 STT | ETH/USD: $${ethUsd.toFixed(2)})`);
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

// ============= FIX 3: Add 'async' keyword here =============
async function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(3000 * Math.pow(2, reconnectAttempts), 30_000);
  reconnectAttempts++;
  console.warn(`⚠ WebSocket closed — reconnecting in ${Math.round(delay/1000)}s (attempt ${reconnectAttempts})...`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await ensureSubscriptions();
      reconnectAttempts = 0;
      console.log("✅ Reconnected.");
    } catch(e: any) {
      console.error("Reconnect failed:", e.message);
      scheduleReconnect();
    }
  }, delay);
}

async function ensureSubscriptions() {
  if (trackerSub && handlerSub && momentumSub && blockWatcher) return;
  loadBlockTxFromDb();
  evictExpiredEntries();
  seedWhaleEventsFromDb();
  nonBlockTxCount = alertCache.filter(e => e.type !== "block_tx").length;
  cacheReadyResolve?.();
  setTimeout(() => loadRecentBlockTxs().catch(() => {}), 10_000);
  fetchExplorerStats().catch(() => {});

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

  // SDK but only for UI signals (no DB persistence) 
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
          const a = decoded.args as any;
          const amount = BigInt(a.amount);
          const ts = Number(BigInt(a.timestamp)) * 1000;

          const txHash = r?.transactionHash ?? "";
          
          // Create content key for deduplication
          const contentKey = `sdk:${a.from}:${a.to}:${amount.toString()}:${a.timestamp}`;
          
          // Skip if we've already seen this SDK event
          if (!markSDKSeen(contentKey)) return;

          // ============= TEMPORARY: Save whales to database for testing =============
          if (txHash) {
            const testEntry: CacheEntry = {
              type: "whale",
              receivedAt: Date.now(),
              raw: {
                from: a.from,
                to: a.to,
                amount: `0x${amount.toString(16)}`,
                timestamp: `0x${BigInt(a.timestamp).toString(16)}`,
                token: a.token ?? "STT",
                txHash,
                blockNumber: r?.blockNumber ? BigInt(r.blockNumber).toString() : "",
                blockHash: r?.blockHash ?? "",
              },
            };
            push(testEntry); // This will save to DB
            console.log(`📝 SAVED WHALE TO DB: ${txHash.slice(0,10)}`);
          }

          // Send pending alert for UI
          const pendingAlert: CacheEntry = {
            type: "whale_pending",
            receivedAt: Date.now(),
            raw: {
              from: a.from,
              to: a.to,
              amount: `0x${amount.toString(16)}`,
              timestamp: `0x${BigInt(a.timestamp).toString(16)}`,
              token: a.token ?? "STT",
              txHash: txHash || "pending",
              blockNumber: "",
              blockHash: "",
            },
          };
          
          // Broadcast pending alert immediately
          const msg = encoder.encode(`data: ${JSON.stringify(pendingAlert)}\n\n`);
          controllers.forEach(c => { try { c.enqueue(msg); } catch {} });
          
          console.log(`⚡ Pending whale detected via SDK: ${a.from.slice(0,8)}→${a.to.slice(0,8)} ${txHash ? `tx:${txHash.slice(0,10)}` : '(pending)'}`);

          // Update leaderboard (volume tracking)
          updateLeaderMap(a.from, a.to, amount, ts);

          for (const wallet of [a.from as string, a.to as string]) {
            const le = leaderMap.get(wallet);
            if (le) persistLeaderEntry(wallet, le);
          }
        } catch (e) { console.error("SDK parse error:", e); }
      },
      onError: (e: Error) => {
        console.error("Tracker SDK error:", (e as any).shortMessage ?? e.message);
        if (e.message?.includes("socket") || e.message?.includes("closed")) { trackerSub = null; handlerSub = null; momentumSub = null; scheduleReconnect(); }
      },
    });
    if (r1 instanceof Error) throw r1;
    trackerSub = r1;
    console.log("✅ WhaleTracker SDK subscription (UI signals only):", r1.subscriptionId);
  }

  // Keep handler subscriptions (these are for reaction/alert/momentum events)
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

  if (!blockWatcher) {
    await startBlockWatcher(CONTRACT, walClient, pubClient);
  }
}

let initStarted = false;
let cacheReady: Promise<void> | null = null;
let cacheReadyResolve: (() => void) | null = null;

(function kickstart() {
  if (initStarted) return;
  initStarted = true;
  cacheReady = new Promise<void>(resolve => { cacheReadyResolve = resolve; });
  ensureSubscriptions().catch(e => {
    initStarted = false;
    cacheReadyResolve?.();
    console.error("Subscription init error:", e.message);
  });
})();

export async function GET(req: NextRequest) {
  if (!initStarted) {
    initStarted = true;
    cacheReady = new Promise<void>(resolve => { cacheReadyResolve = resolve; });
    ensureSubscriptions().catch(e => { initStarted = false; cacheReadyResolve?.(); });
  }

  if (cacheReady) await cacheReady;

  const stream = new ReadableStream({
    start(controller) {
      controllers.add(controller);

      // Send all whale events (newest first, max 500)
      const whaleAlerts = alertCache
        .filter(e => e.type !== "block_tx" && e.type !== "whale_pending")
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, 500);

      // Send block_tx events
      const blockTxAlerts = alertCache
        .filter(e => e.type === "block_tx")
        .sort((a, b) => b.receivedAt - a.receivedAt);

      controller.enqueue(encoder.encode(`data: ${JSON.stringify({
        type: "init",
        alerts: [...whaleAlerts, ...blockTxAlerts],
        totalBlockTxsSeen,
        networkLargestSTT,
        explorerStats,
      })}\n\n`));

      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));

      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: ping\n\n`)); }
        catch { clearInterval(ping); }
      }, 30_000);

      req.signal.addEventListener("abort", () => {
        clearInterval(ping);
        controllers.delete(controller);
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type":  "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection":    "keep-alive",
    },
  });
}