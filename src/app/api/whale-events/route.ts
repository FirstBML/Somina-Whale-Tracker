import { NextRequest } from "next/server";
import { SDK } from "@somnia-chain/reactivity";
import {
  createPublicClient, createWalletClient, webSocket, http,
  keccak256, toBytes, defineChain, decodeEventLog, parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { enqueue as enqueueLeaderboard } from "../streams-leaderboard/route";
import Database from 'better-sqlite3';
import {
  processEvent as analyticsProcessEvent,
  seedFromHistory as analyticsSeed,
  setThresholdMeta as analyticsSetThreshold,
  getMetrics as analyticsGetMetrics,
  getShockData as analyticsGetShock,
} from "../../../lib/analyticsEngine";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://dream-rpc.somnia.network"],
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
  tx_hash TEXT,
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

// ── Migrations — safe to run on existing DB ─────────────────────────────────

try { db.exec(`ALTER TABLE whale_events ADD COLUMN block_timestamp INTEGER`); } catch {}
try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_whale_tx_hash ON whale_events(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash != ''`); } catch {}

// Remove old table-level UNIQUE on tx_hash if it exists (SQLite requires table rebuild).
// We detect the old schema by checking if the CREATE TABLE sql contains "tx_hash TEXT UNIQUE".
try {
  const schema = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='whale_events'`).get() as any)?.sql ?? "";
  if (schema.includes("tx_hash TEXT UNIQUE")) {
    console.log("🔧 Migrating whale_events: removing old tx_hash UNIQUE constraint...");
    db.exec(`
BEGIN;
CREATE TABLE IF NOT EXISTS whale_events_new (
  id TEXT PRIMARY KEY,
  type TEXT,
  from_addr TEXT,
  to_addr TEXT,
  amount TEXT,
  timestamp INTEGER,
  block_timestamp INTEGER,
  token TEXT,
  tx_hash TEXT,
  block_number INTEGER,
  block_hash TEXT,
  tx_fee TEXT,
  linked_tx_hash TEXT,
  signal_reason TEXT
);
INSERT OR IGNORE INTO whale_events_new SELECT * FROM whale_events;
DROP TABLE whale_events;
ALTER TABLE whale_events_new RENAME TO whale_events;
CREATE INDEX IF NOT EXISTS idx_timestamp ON whale_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_block_timestamp ON whale_events(block_timestamp);
CREATE UNIQUE INDEX IF NOT EXISTS idx_whale_tx_hash ON whale_events(tx_hash) WHERE tx_hash IS NOT NULL AND tx_hash != '';
COMMIT;
    `);
    console.log("✅ Migration complete — whale_events tx_hash UNIQUE constraint removed");
  }
} catch (e: any) { console.error("⚠ Migration failed (non-critical):", e.message?.split("\n")[0]); }

const WHALE_ABI = [{
  name: "WhaleTransfer", type: "event",
  inputs: [
    { name: "from", type: "address", indexed: true },
    { name: "to", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "timestamp", type: "uint256", indexed: false },
    { name: "token", type: "string", indexed: false },
  ],
}] as const;

const HANDLER_ABI = [{
  name: "ReactedToWhaleTransfer", type: "event",
  inputs: [
    { name: "emitter", type: "address", indexed: true },
    { name: "topic0", type: "bytes32", indexed: false },
    { name: "from", type: "address", indexed: false },
    { name: "to", type: "address", indexed: false },
    { name: "count", type: "uint256", indexed: false },
  ],
}, {
  name: "AlertThresholdCrossed", type: "event",
  inputs: [
    { name: "reactionCount", type: "uint256", indexed: false },
    { name: "blockNumber", type: "uint256", indexed: false },
  ],
}] as const;

const MOMENTUM_ABI = [{
  name: "WhaleMomentumDetected", type: "event",
  inputs: [
    { name: "burstCount", type: "uint256", indexed: false },
    { name: "blockNumber", type: "uint256", indexed: false },
  ],
}] as const;

const TRACKER_ABI = [
  {
    name: "reportTransfer", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "token", type: "string" },
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
    { name: "roundId", type: "uint80" },
    { name: "answer", type: "int256" },
    { name: "startedAt", type: "uint256" },
    { name: "updatedAt", type: "uint256" },
    { name: "answeredInRound", type: "uint80" },
  ],
}, {
  name: "decimals", type: "function", stateMutability: "view",
  inputs: [], outputs: [{ type: "uint8" }],
}] as const;

// Threshold for whale detection — lowered for testnet where most activity is small amounts.
// 0.001 STT captures the vast majority of real transfers on Somnia testnet.
// Raise this on mainnet (e.g. parseEther("100")) to filter only significant transfers.
const WHALE_DISPLAY_THRESHOLD = parseEther("0.001"); // 0.001 STT minimum for whale

export type CacheEntry = {
  // whale_pending removed — only confirmed on-chain data is accepted
  type: "whale" | "reaction" | "alert" | "momentum" | "block_tx" | "threshold_update";
  receivedAt: number;
  raw: {
    from: string; to: string; amount: string; timestamp: string; token: string;
    txHash: string; blockNumber: string; blockHash: string;
    reactionCount?: string; handlerEmitter?: string;
    oldValue?: string; newValue?: string;
    txFee?: string;
    // For derived signals: links back to the confirmed whale tx that triggered this
    linkedTxHash?: string;
    signalReason?: string; // human-readable explanation
  };
};

// ── In-memory leaderboard ────────────────────────────────────────────────────

type LeaderEntry = { totalVolume: bigint; txCount: number; lastSeen: number };
const leaderMap = new Map<string, LeaderEntry>();

function updateLeaderMap(from: string, to: string, amount: bigint, ts: number) {
  for (const addr of [from, to]) {
    const existing = leaderMap.get(addr) ?? { totalVolume: 0n, txCount: 0, lastSeen: 0 };
    leaderMap.set(addr, {
      totalVolume: existing.totalVolume + amount,
      txCount: existing.txCount + 1,
      lastSeen: Math.max(existing.lastSeen, ts),
    });
  }
}

function persistLeaderEntry(wallet: string, entry: LeaderEntry) {
  try {
    enqueueLeaderboard({
      wallet,
      totalVolume: entry.totalVolume.toString(),
      txCount: entry.txCount,
      lastSeen: entry.lastSeen,
    });
  } catch (e) {
    console.error("streams persist error:", e);
  }
}

// ── Server state ─────────────────────────────────────────────────────────────

const MAX_CACHE = 5000;
const alertCache: CacheEntry[] = [];
let totalBlockTxsSeen = 0;
let networkLargestSTT = 0;
const BLOCK_TX_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

let trackerSub: { unsubscribe: () => Promise<any> } | null = null;
let handlerSub: { unsubscribe: () => Promise<any> } | null = null;
let momentumSub: { unsubscribe: () => Promise<any> } | null = null;
let blockWatcher: (() => void) | null = null;
let backfillRunning = false;

const encoder = new TextEncoder();
const controllers = new Set<ReadableStreamDefaultController>();
let nonBlockTxCount = 0;

export type ExplorerStats = {
  txCount24h: number;
  totalFees24h: number;
  avgFee24h: number;
  fetchedAt: number;
};

let explorerStats: ExplorerStats | null = null;

// ── Dedup sets for SDK vs block watcher ──────────────────────────────────────

const seenBlockTxHashes = new Set<string>();
const seenSDKContentKeys = new Set<string>();
const MAX_SEEN_HASHES = 50_000; // covers 24h of whale txns with room to spare
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

// ──  Dedup set for derived signals (reactions/alerts/momentum) ──
// Previously, push() would broadcast every reaction/alert/momentum even if an
// identical one had already been sent. This set prevents that.
const seenSignalKeys = new Set<string>();
const MAX_SEEN_SIGNALS = 5_000;
const signalKeyQueue: string[] = [];

function markSignalSeen(key: string): boolean {
  if (seenSignalKeys.has(key)) return false;
  if (signalKeyQueue.length >= MAX_SEEN_SIGNALS) {
    seenSignalKeys.delete(signalKeyQueue.shift()!);
  }
  seenSignalKeys.add(key);
  signalKeyQueue.push(key);
  return true;
}

function getSignalKey(entry: CacheEntry): string {
  if (entry.type === "reaction") {
    // ── Key on linkedTxHash only — one reaction per whale ──────────────
    // The Reactivity precompile delivers 3 separate ReactedToWhaleTransfer
    // events per whale (each with an incrementing `count`). Using reactionCount
    // in the key meant all three passed dedup since each count is unique.
    // We only want to show ONE reaction per whale tx on the frontend.
    return `reaction:${entry.raw.linkedTxHash ?? entry.receivedAt}`;
  }
  // alert, momentum — linked to a specific whale tx + type
  return `${entry.type}:${entry.raw.linkedTxHash ?? ""}:${Math.floor(entry.receivedAt / 5000)}`; // 5s bucket
}

// ── SQLite-backed block_tx persistence ───────────────────────────────────────

const insertBlockTx = db.prepare(`
  INSERT OR IGNORE INTO block_tx_events
  (id, from_addr, to_addr, amount, is_transfer, tx_hash, block_number, block_hash, tx_fee, received_at, block_timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

function loadBlockTxFromDb() {
  // Clear existing block_tx entries from cache before reloading — prevents duplicates on reconnect
  for (let i = alertCache.length - 1; i >= 0; i--) {
    if (alertCache[i].type === "block_tx") alertCache.splice(i, 1);
  }
  const cutoff = Date.now() - BLOCK_TX_WINDOW_MS;
  const rows = db.prepare(
    `SELECT * FROM block_tx_events WHERE received_at >= ? ORDER BY received_at ASC`
  ).all(cutoff) as any[];

  if (!rows.length) return;

  for (const row of rows) {
    const amountRaw = parseFloat(row.amount ?? "0");
    if (amountRaw > networkLargestSTT) networkLargestSTT = amountRaw;
    
    // Normalize block timestamp to milliseconds
    let blockTsMs = row.block_timestamp ?? row.received_at;
    
    // If timestamp is in seconds (< 100 billion, i.e., before year 5000), convert to ms
    // Also handle case where it's stored as number (SQLite stores as integer)
    if (blockTsMs && blockTsMs > 0) {
      // Check if it looks like seconds (10-11 digits) rather than milliseconds (13 digits)
      // Timestamps in seconds: 1734567890 (10 digits) or 17345678901 (11 digits)
      // Timestamps in milliseconds: 1734567890123 (13 digits)
      if (blockTsMs < 100_000_000_00) {
        blockTsMs = blockTsMs * 1000;
      }
    } else {
      blockTsMs = row.received_at;
    }
    
    alertCache.push({
      type: "block_tx",
      receivedAt: row.received_at,
      raw: {
        from: row.from_addr,
        to: row.to_addr,
        amount: row.amount,
        timestamp: `0x${Math.floor(blockTsMs / 1000).toString(16)}`,
        token: "STT",
        txHash: row.tx_hash,
        blockNumber: row.block_number,
        blockHash: row.block_hash,
        txFee: row.tx_fee ?? "0",
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
    
    // Normalize block timestamp for storage
    let blockTsMs = entry.receivedAt;
    try {
      const hexTs = entry.raw.timestamp ?? "0x0";
      const parsed = Number(BigInt(hexTs));
      // If timestamp is in seconds (< 100 billion, i.e., before year 5000), convert to ms
      blockTsMs = parsed < 100_000_000_00 ? parsed * 1000 : parsed;
      if (blockTsMs <= 0) blockTsMs = entry.receivedAt;
    } catch { blockTsMs = entry.receivedAt; }
    
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
        blockTsMs,  // Store normalized block timestamp
      );
    } catch {} // IGNORE duplicate tx_hash
  } else {
    // ── Whale txHash dedup — DO NOT re-check markBlockSeen here ──────────────
    // The block watcher calls markBlockSeen(txHash) BEFORE calling push(), so
    // calling it again here would always return false and silently drop the whale:
    //   block watcher → markBlockSeen(hash) → true → push(whale)
    //   push() → markBlockSeen(hash) → FALSE (already seen!) → return   ← BUG
    // Hot-reload dedup is handled by pre-seeding seenBlockTxHashes from alertCache
    // in ensureSubscriptions(). The injectSimulatedWhale path calls markBlockSeen
    // before push(), so simulated whales are also safe.
    //
    // ──  Dedup reactions/alerts/momentum BEFORE adding to cache ────────
    // Without this, the same reaction is broadcast every time the block watcher
    // fires or the backfill re-processes the same block. The INSERT OR IGNORE
    // in SQLite stops DB duplicates but the in-memory broadcast happened before
    // that check, causing the frontend flood.
    if (entry.type === "reaction" || entry.type === "alert" || entry.type === "momentum") {
      const signalKey = getSignalKey(entry);
      if (!markSignalSeen(signalKey)) {
        // Already broadcast — skip entirely (don't add to cache, don't broadcast)
        return;
      }
    }

    if (nonBlockTxCount >= MAX_CACHE) {
      const idx = alertCache.findIndex(e => e.type !== "block_tx");
      if (idx !== -1) { alertCache.splice(idx, 1); nonBlockTxCount--; }
    }
    nonBlockTxCount++;
  }

  alertCache.push(entry);
  analyticsProcessEvent(entry.type, entry.raw, entry.receivedAt);
  broadcast(entry);
  
  // ── Persist whale events with normalized timestamps ──────────────────────────
  if (entry.type === "whale" && entry.raw.txHash) {
    // Normalize block timestamp to milliseconds
    let blockTsMs = entry.receivedAt;
    try {
      const hexTs = entry.raw.timestamp ?? "0x0";
      const parsed = Number(BigInt(hexTs));
      // If timestamp is in seconds (< 100 billion, i.e., before year 5000), convert to ms
      blockTsMs = parsed < 100_000_000_00 ? parsed * 1000 : parsed;
      if (blockTsMs <= 0) blockTsMs = entry.receivedAt;
    } catch { blockTsMs = entry.receivedAt; }
    
    db.prepare(`
      INSERT OR IGNORE INTO whale_events
      (id, type, from_addr, to_addr, amount, timestamp, block_timestamp, token, tx_hash, block_number, block_hash, tx_fee, linked_tx_hash, signal_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `${entry.receivedAt}-${Math.random()}`,
      entry.type,
      entry.raw.from,
      entry.raw.to,
      entry.raw.amount,
      entry.receivedAt,
      blockTsMs,  // ← Store normalized block timestamp in milliseconds
      entry.raw.token,
      entry.raw.txHash,
      entry.raw.blockNumber || null,
      entry.raw.blockHash || null,
      entry.raw.txFee || null,
      entry.raw.linkedTxHash || null,
      entry.raw.signalReason || null,
    );
  }

  // ── Persist reactions/alerts/momentum with normalized timestamps ─────────────
  if ((entry.type === "reaction" || entry.type === "alert" || entry.type === "momentum") && entry.raw.linkedTxHash) {
    // Normalize timestamp to milliseconds
    let sigTsMs = entry.receivedAt;
    try {
      const hexTs = entry.raw.timestamp ?? "0x0";
      const parsed = Number(BigInt(hexTs));
      sigTsMs = parsed < 100_000_000_00 ? parsed * 1000 : parsed;
      if (sigTsMs <= 0) sigTsMs = entry.receivedAt;
    } catch { sigTsMs = entry.receivedAt; }
    
    try {
      db.prepare(`
        INSERT OR IGNORE INTO whale_events
        (id, type, from_addr, to_addr, amount, timestamp, block_timestamp, token, tx_hash, block_number, block_hash, tx_fee, linked_tx_hash, signal_reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `${entry.type}-${entry.receivedAt}-${Math.random()}`,
        entry.type,
        entry.raw.from,
        entry.raw.to,
        entry.raw.amount || "0x0",
        entry.receivedAt,
        sigTsMs,  // ← Store normalized timestamp in milliseconds
        entry.raw.token || "",
        entry.raw.txHash || null,
        entry.raw.blockNumber || null,
        entry.raw.blockHash || null,
        entry.raw.txFee || null,
        entry.raw.linkedTxHash,
        entry.raw.signalReason || null,
      );
    } catch {} // IGNORE duplicates
  }
}
function getHistoricalEvents(timeRangeMs: number): CacheEntry[] {
  const cutoff = Date.now() - timeRangeMs;
  // Use OR condition: include row if EITHER timestamp column is within range.
  // This handles old rows (only have `timestamp`), new rows (have `block_timestamp`),
  // and migrated rows (have both). Also covers NULL values safely.
  const rows = db.prepare(`
SELECT *,
COALESCE(block_timestamp, timestamp) AS display_ts
FROM whale_events
WHERE (timestamp > ? OR block_timestamp > ?)
ORDER BY COALESCE(block_timestamp, timestamp) DESC
LIMIT 5000
`).all(cutoff, cutoff);

  return rows.map((row: any) => ({
    type: row.type,
    receivedAt: row.timestamp,
    raw: {
      from: row.from_addr ?? "",
      to: row.to_addr ?? "",
      amount: row.amount ?? "0x0",
      timestamp: `0x${Math.floor(((row.display_ts as number) ?? row.timestamp) / 1000).toString(16)}`,
      token: row.token ?? "",
      txHash: row.tx_hash ?? "",
      blockNumber: row.block_number?.toString() ?? "",
      blockHash: row.block_hash ?? "",
      txFee: row.tx_fee ?? "0",
      linkedTxHash: row.linked_tx_hash ?? "",
      signalReason: row.signal_reason ?? "",
    }
  })) as CacheEntry[];
}

// ── seedWhaleEventsFromDb seeds ALL event types (including reactions) ──
// The original code only deduped by txHash, which caused reaction/alert/momentum entries
// (which have no txHash) to be skipped. Now uses a composite key that works for all types.
function seedWhaleEventsFromDb() {
  const dbEvents = getHistoricalEvents(BLOCK_TX_WINDOW_MS); // 24h window

  // Diagnostic: count total rows in whale_events regardless of filter
  const totalRows = (db.prepare(`SELECT COUNT(*) as n FROM whale_events`).get() as any)?.n ?? 0;
  console.log(`📊 whale_events total rows: ${totalRows}, visible in 24h window: ${dbEvents.length}`);

  if (!dbEvents.length) {
    console.log("No historical whale events found in database");
    return;
  }

  // Build dedup key that works for all event types (not just tx-hash-based whales)
  function seedKey(e: CacheEntry): string {
    if (e.type === "whale" && e.raw.txHash) return `whale:${e.raw.txHash}`;
    if (e.type === "reaction") return `reaction:${e.raw.linkedTxHash ?? e.receivedAt}`;
    return `${e.type}:${e.raw.linkedTxHash ?? ""}:${e.receivedAt}`;
  }

  const seenKeys = new Set(alertCache.map(seedKey));
  let seeded = 0;

  for (const entry of dbEvents) {
    const key = seedKey(entry);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    alertCache.push(entry);

    // Pre-seed the backend dedup sets so live events don't re-broadcast seeded history
    if (entry.raw.txHash) markBlockSeen(entry.raw.txHash);
    if (entry.type === "reaction" || entry.type === "alert" || entry.type === "momentum") {
      markSignalSeen(getSignalKey(entry));
    }

    seeded++;
  }

  if (seeded > 0) console.log(`📂 Seeded ${seeded} events from SQLite (whales + reactions + alerts + momentum)`);
}

// ── Promote qualifying block_tx_events → whale_events ────────────────────────
// Historical block_tx rows that meet the whale threshold but were never promoted
// (written before the blockWatcher derived-whale logic existed) get promoted here.
// Runs once at startup. Safe to re-run — INSERT OR IGNORE skips existing rows.
function promoteBlockTxToWhaleEvents() {
  const threshold = Number(WHALE_DISPLAY_THRESHOLD) / 1e18; // e.g. 1.0 STT
  const cutoff = Date.now() - BLOCK_TX_WINDOW_MS; // 24h — matches block_tx retention window

  const candidates = db.prepare(`
SELECT * FROM block_tx_events
WHERE is_transfer = 1
AND CAST(amount AS REAL) >= ?
AND tx_hash IS NOT NULL AND tx_hash != ''
AND received_at >= ?
ORDER BY received_at ASC
`).all(threshold, cutoff) as any[];

  if (!candidates.length) return;

  const insertWhale = db.prepare(`
INSERT OR IGNORE INTO whale_events
(id, type, from_addr, to_addr, amount, timestamp, block_timestamp, token, tx_hash, block_number, block_hash, tx_fee)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

  let promoted = 0;
  for (const row of candidates) {
    const sttWei = `0x${Math.round(parseFloat(row.amount) * 1e18).toString(16)}`;
    try {
      insertWhale.run(
        `promoted-${row.tx_hash}`,
        "whale",
        row.from_addr, row.to_addr,
        sttWei,
        row.received_at,
        row.received_at,
        "STT",
        row.tx_hash,
        row.block_number || null,
        row.block_hash || null,
        row.tx_fee || null,  // carry fee from block_tx so Whale Fees KPI is populated
      );
      promoted++;
    } catch {} // IGNORE = already exists
  }

  if (promoted > 0) console.log(`🐋 Promoted ${promoted} historical block_tx → whale_events (threshold: ${threshold} STT)`);
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
      const txCount = data.transactions_today ?? data.transaction_count_today ?? 0;
      const gasUsed = BigInt(data.gas_used_today ?? "0");
      const AVG_GAS_PRICE = 6_000_000_000n;
      const totalFeesWei = gasUsed * AVG_GAS_PRICE;
      const totalFees24h = Number(totalFeesWei) / 1e18;
      const avgFee24h = txCount > 0 ? totalFees24h / txCount : 0;
      explorerStats = { txCount24h: txCount, totalFees24h, avgFee24h, fetchedAt: Date.now() };
      // ── Only log when value actually changes — suppress the 60s spam ────────
      if (!explorerStats || explorerStats.txCount24h !== txCount) {
        console.log(`📡 Explorer stats updated: ${txCount.toLocaleString()} txns/24h · ${totalFees24h.toFixed(2)} STT fees`);
      }
      broadcastExplorerStats();
      return;
    }

    const blockTxs24h = alertCache.filter(
      e => e.type === "block_tx" && e.receivedAt >= Date.now() - 24 * 60 * 60_000
    );
    if (blockTxs24h.length > 0) {
      const totalFees24h = blockTxs24h.reduce((s, e) => {
        const f = parseFloat(e.raw.txFee?.replace("~", "") ?? "0");
        return s + (isNaN(f) ? 0 : f);
      }, 0);
      explorerStats = {
        txCount24h: totalBlockTxsSeen,
        totalFees24h,
        avgFee24h: blockTxs24h.length > 0 ? totalFees24h / blockTxs24h.length : 0,
        fetchedAt: Date.now(),
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

let metricsBroadcastTimer: ReturnType<typeof setInterval> | null = null;

function startMetricsBroadcast() {
  if (metricsBroadcastTimer) return;
  metricsBroadcastTimer = setInterval(() => {
    if (!controllers.size) return;
    const msg = encoder.encode(`data: ${JSON.stringify({
      type: "metrics_update",
      metrics: analyticsGetMetrics(),
      shock: analyticsGetShock(),
    })}\n\n`);
    controllers.forEach(c => { try { c.enqueue(msg); } catch {} });
  }, 2_000);
}

// Re-broadcast full init payload to all connected clients.
// Called after backfill completes so clients that connected during startup
// get the complete dataset without needing to reconnect.
function broadcastFullInit() {
  if (!controllers.size) return;

  const whaleAlerts = alertCache
  .filter(e => e.type !== "block_tx")  // exclude block_tx, keep everything else
  .sort((a, b) => b.receivedAt - a.receivedAt)
  .slice(0, 5000);  

  const blockTxAlerts = alertCache
    .filter(e => e.type === "block_tx")
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, 5_000); // cap — full data available via /api/network-activity

  const dbLatestBlock = (() => {
    try {
      const row = db.prepare(`SELECT MAX(block_number) as n FROM whale_events`).get() as any;
      return row?.n ? Number(row.n) : 0;
    } catch { return 0; }
  })();

  const msg = encoder.encode(`data: ${JSON.stringify({
    type: "init",
    alerts: [...whaleAlerts, ...blockTxAlerts],
    totalBlockTxsSeen,
    networkLargestSTT,
    explorerStats,
    metrics: analyticsGetMetrics(),
    shock: analyticsGetShock(),
    whaleThresholdSTT: Number(WHALE_DISPLAY_THRESHOLD) / 1e18,
    whalePercentile: 75,
    dbLatestBlock,
  })}\n\n`);

  controllers.forEach(c => { try { c.enqueue(msg); } catch {} });
  console.log(`📡 Re-broadcast init: ${whaleAlerts.length} whale/reaction/signal events, ${blockTxAlerts.length} block_txs to ${controllers.size} client(s)`);
}

async function loadRecentBlockTxs() {
  if (backfillRunning) {
    console.log("⏭ Backfill already running — skipping duplicate start");
    return;
  }
  backfillRunning = true;
  const pub = createPublicClient({ chain: somniaTestnet, transport: http("https://dream-rpc.somnia.network") });
  try {
    const latest = await pub.getBlockNumber();
    const LOOKBACK = 36_000n;
    const oldest = latest > LOOKBACK ? latest - LOOKBACK : 0n;
    const BATCH = 10;
    const DELAY = 200;

    const cachedHashes = new Set(
      alertCache.filter(e => e.type === "block_tx").map(e => e.raw.txHash)
    );

    let loaded = 0;
    let scanned = 0;
    let cursor = latest;

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

          const val = tx.value ?? 0n;
          const sttAmount = Number(val) / 1e18;
          const gasP = (tx as any).gasPrice ?? (tx as any).maxFeePerGas ?? 0n;
          const gasL = (tx as any).gas ?? 21000n;
          const feeSTT = (typeof gasP === "bigint" ? Number(gasP * gasL) : 0) / 1e18;

          cachedHashes.add(tx.hash);
          push({
            type: "block_tx", receivedAt: Date.now(),
            raw: {
              from: (tx.from ?? "") as string,
              to: (tx.to ?? "0x0000000000000000000000000000000000000000") as string,
              amount: sttAmount > 0 ? sttAmount.toFixed(8) : "0",
              timestamp: `0x${Math.floor(blockTs / 1000).toString(16)}`,
              token: "STT", txHash: tx.hash,
              blockNumber: block.number?.toString() ?? "",
              blockHash: block.hash ?? "",
              txFee: feeSTT > 0 ? `~${feeSTT.toFixed(8)}` : "0",
            },
          });
          loaded++;

          // ── Whale detection in backfill — same integrity gate as live watcher ──
          if (val >= WHALE_DISPLAY_THRESHOLD && tx.hash && block.number && block.timestamp) {
            if (markBlockSeen(tx.hash)) {
              const ts = `0x${Math.floor(blockTs / 1000).toString(16)}`;
              const blockNum = block.number.toString();
              push({
                type: "whale", receivedAt: blockTs, // use block time as receivedAt for correct window filtering
                raw: {
                  from: (tx.from ?? "") as string,
                  to: (tx.to ?? "0x0000000000000000000000000000000000000000") as string,
                  amount: `0x${val.toString(16)}`,
                  timestamp: ts,
                  token: "STT", txHash: tx.hash,
                  blockNumber: blockNum, blockHash: block.hash ?? "",
                  txFee: feeSTT > 0 ? `~${feeSTT.toFixed(8)}` : "0",
                },
              });
            }
          }
        }
      }

      if (scanned % 1000 === 0) console.log(`📊 Scanned ${scanned} blocks, loaded ${loaded} new txns…`);
      await new Promise(r => setTimeout(r, DELAY));
    }

    console.log(`✅ Block_tx backfill: ${loaded} new txns loaded (${scanned} blocks scanned)`);
    promoteBlockTxToWhaleEvents();
    seedWhaleEventsFromDb();

    // Broadcast updated init to all connected clients so they get the full backfilled dataset
    broadcastFullInit();
    
    // Also broadcast metrics update after backfill
    if (controllers.size > 0) {
      const updatedMetrics = analyticsGetMetrics();
      const updatedShock = analyticsGetShock();
      
      const updateMsg = {
        type: "metrics_update",
        metrics: updatedMetrics,
        shock: updatedShock,
      };
      
      const msg = encoder.encode(`data: ${JSON.stringify(updateMsg)}\n\n`);
      controllers.forEach(c => { try { c.enqueue(msg); } catch {} });
      
      console.log(`📢 Broadcast backfill update: metrics and shock data to ${controllers.size} clients`);
    }
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
        const val = tx.value ?? 0n;
        const from = tx.from as `0x${string}`;
        const to = (tx.to ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
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

        // ── INTEGRITY GATE: whale must have txHash + blockNumber + blockTimestamp ──
        if (val >= WHALE_DISPLAY_THRESHOLD && txHash && blockNum && blockTs) {
          if (!markBlockSeen(txHash)) continue; // already processed

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

          const label = `${sttAmount.toFixed(4)} STT`;
          console.log(`🌊 Confirmed whale: ${label} ${from.slice(0,8)}→${to.slice(0,8)} block:${blockNum} tx:${txHash.slice(0,10)}`);

          // Resolve actual fee asynchronously
          fetchActualFee(httpPub, txHash as `0x${string}`).then(actualFee => {
            if (!actualFee) return;
            const idx = alertCache.findIndex(e => e.type === "whale" && e.raw.txHash === txHash);
            if (idx !== -1) {
              alertCache[idx].raw.txFee = actualFee;
              const msg = encoder.encode(`data: ${JSON.stringify({
                ...alertCache[idx], type: "whale_fee_update", txHash, txFee: actualFee })}\n\n`);
              controllers.forEach(c => { try { c.enqueue(msg); } catch {} });
            }
          }).catch(() => {});

          // ── DERIVED SIGNALS from confirmed whale ─────────────────────────────

          // Momentum: ≥3 confirmed whale txns from same wallet within 60s
          const MOMENTUM_WINDOW = 60_000;
          const recentFromSame = alertCache.filter(e =>
            e.type === "whale" &&
            e.raw.from === from &&
            Date.now() - e.receivedAt <= MOMENTUM_WINDOW
          );

          if (recentFromSame.length >= 2) { // this tx makes it 3+
            const burstCount = recentFromSame.length + 1;
            const reason = `${burstCount} confirmed txns ≥${Number(WHALE_DISPLAY_THRESHOLD)/1e18} STT from ${from.slice(0,10)} within ${MOMENTUM_WINDOW/1000}s`;
            push({
              type: "momentum", receivedAt: Date.now(),
              raw: {
                from, to, amount: "0x0",
                timestamp: ts, token: "",
                txHash, blockNumber: blockNum, blockHash: block.hash ?? "",
                reactionCount: burstCount.toString(),
                linkedTxHash: txHash,
                signalReason: reason,
              },
            });
            console.log(`🔥 Momentum derived: ${reason}`);
          }

          // Alert: every confirmed whale above the display threshold generates an alert
          // Previously hardcoded to 1 STT — on testnet where most whales are 0.5 STT
          // this meant the Alerts KPI was always zero. Now aligned with WHALE_DISPLAY_THRESHOLD.
          const ALERT_THRESHOLD = WHALE_DISPLAY_THRESHOLD;
          if (val >= ALERT_THRESHOLD) {
            const reason = `${sttAmount.toFixed(4)} STT transfer confirmed in block ${blockNum}`;
            push({
              type: "alert", receivedAt: Date.now(),
              raw: {
                from, to, amount: "0x0",
                timestamp: ts, token: "",
                txHash, blockNumber: blockNum, blockHash: block.hash ?? "",
                linkedTxHash: txHash,
                signalReason: reason,
              },
            });
            console.log(`🚨 Alert derived: ${reason}`);
          }

          // Update leaderboard
          updateLeaderMap(from, to, val, blockTs);
          for (const wallet of [from, to]) {
            const le = leaderMap.get(wallet);
            if (le) persistLeaderEntry(wallet, le);
          }
        }
      }
    },
    onError: (e) => console.error("Block watcher error:", e.message),
  });

  blockWatcher = unwatch;
  console.log(`✅ Block watcher started (whale threshold: ${Number(WHALE_DISPLAY_THRESHOLD)/1e18} STT | alert threshold: ${Number(WHALE_DISPLAY_THRESHOLD)/1e18} STT | ETH/USD: $${ethUsd.toFixed(2)})`);
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;

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

  // Clear non-block_tx entries before reseeding — prevents duplicates on WebSocket reconnect
  for (let i = alertCache.length - 1; i >= 0; i--) {
    if (alertCache[i].type !== "block_tx") alertCache.splice(i, 1);
  }

  // Reset the signal dedup set on reconnect so historical events re-seed correctly
  seenSignalKeys.clear();
  signalKeyQueue.length = 0;

  // ========== STEP 1: Load block_tx from DB ==========
  loadBlockTxFromDb();
  evictExpiredEntries();
  
  // ========== STEP 2: Promote qualifying block_tx to whale_events ==========
  promoteBlockTxToWhaleEvents();
  
  // ========== STEP 3: Seed ALL event types from DB (whales, reactions, alerts, momentum) ==========
  seedWhaleEventsFromDb();
  
  // ========== STEP 4: CRITICAL - Broadcast init AFTER all data is loaded ==========
  broadcastFullInit();
  
  nonBlockTxCount = alertCache.filter(e => e.type !== "block_tx").length;

  // ── Pre-seed SDK dedup set from loaded reactions ──────────────────────────
  seenSDKContentKeys.clear();
  sdkKeyQueue.length = 0;
  for (const entry of alertCache) {
    if (entry.type === "reaction") {
      const contentKey = `reaction:${entry.raw.from}:${entry.raw.to}:${entry.raw.reactionCount ?? ""}`;
      markSDKSeen(contentKey);
    }
  }

  // ── Pre-seed seenBlockTxHashes from loaded whale entries ──────────────────
  for (const entry of alertCache) {
    if (entry.type === "whale" && entry.raw.txHash) {
      markBlockSeen(entry.raw.txHash as string);
    }
  }

  // Seed analytics engine from loaded history + set threshold meta
  analyticsSeed(alertCache);
  const thresholdStt = Number(WHALE_DISPLAY_THRESHOLD) / 1e18;
  analyticsSetThreshold(thresholdStt, 75);

  // Start 2s metrics broadcast to all SSE clients
  startMetricsBroadcast();
  cacheReadyResolve?.();

  // Only start backfill if not already running
  if (!backfillRunning) {
    setTimeout(() => loadRecentBlockTxs().catch(() => {}), 10_000);
  }

  fetchExplorerStats().catch(() => {});

  const CONTRACT = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;
  const HANDLER = process.env.HANDLER_CONTRACT_ADDRESS as `0x${string}`;
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const pubClient = createPublicClient({ chain: somniaTestnet, transport: webSocket("wss://dream-rpc.somnia.network/ws") });
  const walClient = createWalletClient({ account, chain: somniaTestnet, transport: http("https://dream-rpc.somnia.network") });
  const sdk = new SDK({ public: pubClient, wallet: walClient });

  const WHALE_TOPIC = keccak256(toBytes("WhaleTransfer(address,address,uint256,uint256,string)"));
  const REACTED_TOPIC = keccak256(toBytes("ReactedToWhaleTransfer(address,bytes32,address,address,uint256)"));
  const THRESHOLD_TOPIC = keccak256(toBytes("ThresholdUpdated(uint256,uint256)"));

  // ── SDK WhaleTransfer: leaderboard + dedup signal only ───────────────────
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

          updateLeaderMap(a.from, a.to, amount, ts);
          for (const wallet of [a.from as string, a.to as string]) {
            const le = leaderMap.get(wallet);
            if (le) persistLeaderEntry(wallet, le);
          }
        } catch (e) { console.error("SDK leaderboard update error:", e); }
      },
      onError: (e: Error) => {
        console.error("Tracker SDK error:", (e as any).shortMessage ?? e.message);
        if (e.message?.includes("socket") || e.message?.includes("closed")) {
          trackerSub = null; handlerSub = null; momentumSub = null; scheduleReconnect();
        }
      },
    });

    if (r1 instanceof Error) throw r1;
    trackerSub = r1;
    console.log("✅ SDK WhaleTransfer subscription (leaderboard only):", r1.subscriptionId);
  }

  // ── SDK Reaction: on-chain event from WhaleHandler.sol ───────────────────
  if (!handlerSub && HANDLER) {
    const r2 = await sdk.subscribe({
      ethCalls: [], eventContractSources: [HANDLER], topicOverrides: [REACTED_TOPIC],
      onData: (data: any) => {
        try {
          const r = data?.result ?? data;
          const txHash = r?.transactionHash ?? "";
          const blockNumber = r?.blockNumber ? BigInt(r.blockNumber).toString() : "";

          const decoded = decodeEventLog({
            abi: HANDLER_ABI, data: r?.data as `0x${string}`,
            topics: r?.topics as [`0x${string}`, ...`0x${string}`[]],
          });
          const a = decoded.args as any;

          const contentKey = `reaction:${a.from}:${a.to}:${a.count}`;
          if (!markSDKSeen(contentKey)) return;

          const latestWhale = [...alertCache].reverse().find(e =>
            e.type === "whale" && e.raw.txHash && e.raw.txHash.length > 0
          );

          if (!latestWhale) {
            console.log(`⚠ Reaction dropped — no confirmed whale with txHash in cache to link`);
            return;
          }

          push({
            type: "reaction", receivedAt: Date.now(),
            raw: {
              from: a.from, to: a.to, amount: "0x0",
              timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
              token: "", txHash, blockNumber, blockHash: r?.blockHash ?? "",
              reactionCount: a.count?.toString() ?? "",
              handlerEmitter: a.emitter ?? "",
              linkedTxHash: latestWhale.raw.txHash,
              signalReason: `WhaleHandler reacted to whale transfer${txHash ? "" : " (tx id pending SDK delivery)"} — reaction #${a.count}`,
            },
          });
          console.log(`⚡ Reaction accepted: #${a.count} linked to whale ${latestWhale.raw.txHash.slice(0, 10)}`);
        } catch (e) { console.error("Reaction parse error:", e); }
      },
      onError: (e: Error) => {
        console.error("Handler SDK error:", (e as any).shortMessage ?? e.message);
        if (e.message?.includes("socket") || e.message?.includes("closed")) {
          trackerSub = null; handlerSub = null; momentumSub = null; scheduleReconnect();
        }
      },
    });

    if (r2 instanceof Error) {
      console.warn("⚠ Handler subscription failed:", r2.message);
    } else {
      handlerSub = r2;
      console.log("✅ SDK Reaction subscription (on-chain, integrity-gated):", r2.subscriptionId);
    }

    momentumSub = { unsubscribe: async () => {} };

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
            raw: { from:"", to:"", amount:"0", timestamp:"0x0", token:"",
              txHash:"", blockNumber:"", blockHash:"", oldValue: oldVal.toString(), newValue: newVal.toString() },
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

/**
 * injectSimulatedWhale — called by /api/simulate-whale after a successful contract call.
 * Pushes a synthetic whale entry directly into alertCache and broadcasts it via SSE
 * so it appears immediately in the frontend feed.
 *
 * The block watcher cannot pick up simulated whales because simulate-whale sends
 * a contract CALL (no native STT value transferred), so tx.value = 0 and the block
 * watcher's val >= WHALE_DISPLAY_THRESHOLD gate is never satisfied.
 * This function bypasses that gate for simulation purposes only.
 */
export function injectSimulatedWhale(params: {
  from: `0x${string}`;
  to:   `0x${string}`;
  amountEth: string;   // decimal string e.g. "250000"
  token: string;
  txHash: `0x${string}`;
}) {
  const now   = Date.now();
  const ts    = `0x${Math.floor(now / 1000).toString(16)}`;
  const amtWei = BigInt(Math.round(parseFloat(params.amountEth) * 1e18));

  const entry: CacheEntry = {
    type: "whale",
    receivedAt: now,
    raw: {
      from:        params.from,
      to:          params.to,
      amount:      `0x${amtWei.toString(16)}`,
      timestamp:   ts,
      token:       params.token,
      txHash:      params.txHash,
      blockNumber: "simulated",   // CRITICAL: Mark as simulated for frontend badge
      blockHash:   "simulated",
      txFee:       "0",
      signalReason: "🧪 SIMULATED WHALE - Test transaction only",
    },
  };

  // DO NOT use markBlockSeen for simulated whales - we want them to always show
  // The markBlockSeen would prevent the whale from appearing if the txHash was seen before
  // For simulated whales, we skip the dedup check entirely
  
  // Push directly to cache - this bypasses the dedup for simulated whales
  push(entry);
  console.log(`🎭 Simulated whale injected: ${params.amountEth} ${params.token} ${params.from.slice(0,8)}→${params.to.slice(0,8)} tx:${params.txHash.slice(0,10)}`);
}

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

      // Send full init payload immediately — alertCache is already seeded before cacheReady resolves
      const whaleAlerts = alertCache
        .filter(e => e.type !== "block_tx")
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, 5000);

      const blockTxAlerts = alertCache
        .filter(e => e.type === "block_tx")
        .sort((a, b) => b.receivedAt - a.receivedAt)
        .slice(0, 5_000);

      const dbLatestBlock = (() => {
        try {
          const row = db.prepare(`SELECT MAX(block_number) as n FROM whale_events`).get() as any;
          return row?.n ? Number(row.n) : 0;
        } catch { return 0; }
      })();

      console.log(`📡 SSE connection: sending ${whaleAlerts.length} whale events + ${blockTxAlerts.length} block_txs`);
      console.log(`📡 Sample first whale:`, whaleAlerts[0]);

      const initPayload = {
        type: "init",
        alerts: [...whaleAlerts, ...blockTxAlerts],
        totalBlockTxsSeen,
        networkLargestSTT,
        explorerStats,
        metrics: analyticsGetMetrics(),
        shock: analyticsGetShock(),
        whaleThresholdSTT: Number(WHALE_DISPLAY_THRESHOLD) / 1e18,
        whalePercentile: 75,
        dbLatestBlock,
      };
      
      console.log(`📡 Sending init payload with ${initPayload.alerts.length} total alerts`);
      
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(initPayload)}\n\n`));

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
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}