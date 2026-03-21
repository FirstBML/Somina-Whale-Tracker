/**
 * analyticsEngine.ts — Backend analytics layer
 *
 * Maintains all metrics incrementally as events arrive.
 * Every query is O(1) or O(buckets) — never O(transactions).
 * Frontend becomes pure display: it renders pre-computed values, never filters arrays.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type LiveMetrics = {
  // Network
  totalTx24h:      number;
  sttTx24h:        number;
  // Whales
  whaleTx24h:      number;
  whaleVolumeStt:  number;   // total STT moved (no USD — STT is testnet-only, no oracle)
  avgWhaleSizeStt: number;
  largestWhaleStt: number;
  whaleFees:       number;
  whaleFeeEstimated: boolean;
  // Signals
  alerts24h:    number;
  momentum24h:  number;
  reactions24h: number;
  // Rates
  whaleTxRate:  number;
  whaleTxRateRaw: number; 
  // Threshold
  whaleThresholdStt: number;
  whalePercentile:   number;
  // Time
  updatedAt: number;
};

export type ShockDataPoint = {
  time:          string;
  score:         number;
  txCount:       number;
  uniqueWallets: number;
  followups:     number;
  label:         string;
  scoreColor:    string;
  amount:        number;
  token:         string;
  whaleTxHash:   string;
};

export type WindowMetrics = {
  whaleTxRate:   number;
  whaleTx:       number;
  totalTx:       number;
  sttTx:         number;
};

// ── Internal state ────────────────────────────────────────────────────────────

const BUCKET_MS   = 60_000;           // 1-minute buckets
const WINDOW_24H  = 24 * 60 * 60_000;
const MAX_WHALE_SAMPLES = 1_000;
const MAX_SHOCK_ENTRIES = 50;         // keep last 50 whale events for shock chart

// Rolling time buckets  { bucket_start_ms → count }
const allTxBuckets:   Map<number, number> = new Map();
const sttTxBuckets:   Map<number, number> = new Map();
const whaleTxBuckets: Map<number, number> = new Map();

// Recent whale sizes for average/percentile
const whaleSizesStt: number[] = [];

// Per-whale network-reaction window (for shock score)
// Stored as { whaleTxHash, whaleTs, txCount, wallets: Set, followups }
type ShockAccumulator = {
  whaleTxHash: string;
  whaleTs:     number;
  amount:      number;
  token:       string;
  txCount:     number;
  wallets:     Set<string>;
  followups:   number;
};
const activeShockWindows: Map<string, ShockAccumulator> = new Map(); // txHash → accumulator
const completedShock: ShockDataPoint[] = [];

// Cumulative totals (reset on eviction — approximate, sufficient for display)
let _totalTx24h   = 0;
let _sttTx24h     = 0;
let _whaleTx24h   = 0;
let _whaleVolStt  = 0;
let _largestStt   = 0;
let _whaleFees    = 0;
let _whaleFeeEst  = false;
let _alerts24h    = 0;
let _momentum24h  = 0;
let _reactions24h = 0;

let _whaleThresholdStt = 0.5;
let _whalePercentile   = 90;

// ── Public API ─────────────────────────────────────────────────────────────────

export function setThresholdMeta(stt: number, percentile: number) {
  _whaleThresholdStt = stt;
  _whalePercentile   = percentile;
}

/**
 * Call this inside push() for every event.
 * This is the only place state is mutated.
 */
export function processEvent(
  type:        string,
  raw:         Record<string, any>,
  receivedAt:  number,
) {
  const now    = receivedAt;
  const bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;

  if (type === "block_tx") {
    _totalTx24h++;
    inc(allTxBuckets, bucket);

    const amt = parseFloat(raw.amount ?? "0");
    if (amt > 0) {
      _sttTx24h++;
      inc(sttTxBuckets, bucket);
    }

    // Feed any active shock windows
    const txTs = hexTsToMs(raw.timestamp) || now;
    for (const [, acc] of activeShockWindows) {
      if (txTs > acc.whaleTs && txTs <= acc.whaleTs + 30_000) {
        acc.txCount++;
        if (raw.from) acc.wallets.add(raw.from);
        if (raw.to)   acc.wallets.add(raw.to);
      }
    }

    // Finalize shock windows whose 30s window has passed
    finalizeExpiredShockWindows(txTs);

  } else if (type === "whale") {
    _whaleTx24h++;
    inc(whaleTxBuckets, bucket);

    const stt = hexAmtToStt(raw.amount);
    _whaleVolStt  += stt;
    // STT is testnet-only with no oracle price — USD fields stay 0
    if (stt > _largestStt) _largestStt = stt;

    const fee = parseFloat((raw.txFee ?? "0").replace("~", ""));
    if (!isNaN(fee) && fee > 0) {
      _whaleFees += fee;
      if (raw.txFee?.startsWith("~")) _whaleFeeEst = true;
    }

    // Track whale size for average
    whaleSizesStt.push(stt);
    if (whaleSizesStt.length > MAX_WHALE_SAMPLES) whaleSizesStt.shift();

    // Open shock accumulator for this whale
    if (raw.txHash) {
      const whaleTs = hexTsToMs(raw.timestamp) || now;
      activeShockWindows.set(raw.txHash, {
        whaleTxHash: raw.txHash,
        whaleTs,
        amount:  stt,
        token:   raw.token ?? "STT",
        txCount: 0,
        wallets: new Set(),
        followups: 0,
      });
    }

    // Count follow-up whale events in existing open windows
    const whaleTs = hexTsToMs(raw.timestamp) || now;
    for (const [key, acc] of activeShockWindows) {
      if (key !== raw.txHash && whaleTs > acc.whaleTs && whaleTs <= acc.whaleTs + 30_000) {
        acc.followups++;
      }
    }

  } else if (type === "alert")    { _alerts24h++;    }
    else if (type === "momentum") { _momentum24h++;  }
    else if (type === "reaction") { _reactions24h++; }

  evictOldBuckets(now);
}

/** Called when analytics engine is seeded from DB on startup */
export function seedFromHistory(entries: { type: string; raw: Record<string, any>; receivedAt: number }[]) {
  resetCounters();
  for (const e of entries) {
    processEvent(e.type, e.raw, e.receivedAt);
  }
}

export function getMetrics(): LiveMetrics {
  const avg = whaleSizesStt.length > 0
    ? whaleSizesStt.reduce((s, v) => s + v, 0) / whaleSizesStt.length
    : 0;
    
   const whaleTxRateRaw = _totalTx24h > 0
  ? (_whaleTx24h / _totalTx24h) * 100
  : 0;
  
  const rate = _totalTx24h > 0
    ? Math.min(100, (_whaleTx24h / _totalTx24h) * 100 * 20) // *20 to scale 0-5% → 0-100
    : 0;
  
  return {
    totalTx24h:       _totalTx24h,
    sttTx24h:         _sttTx24h,
    whaleTx24h:       _whaleTx24h,
    whaleVolumeStt:   _whaleVolStt,
    avgWhaleSizeStt:  avg,
    largestWhaleStt:  _largestStt,
    whaleFees:        _whaleFees,
    whaleFeeEstimated: _whaleFeeEst,
    alerts24h:        _alerts24h,
    momentum24h:      _momentum24h,
    reactions24h:     _reactions24h,
    whaleTxRate:      rate,
    whaleTxRateRaw:   whaleTxRateRaw,
    whaleThresholdStt: _whaleThresholdStt,
    whalePercentile:   _whalePercentile,
    updatedAt:         Date.now(),
  };
}

export function getWindowMetrics(windowMs: number): WindowMetrics {
  const cutoff = Date.now() - windowMs;
  let totalTx = 0, sttTx = 0, whaleTx = 0;

  for (const [ts, count] of allTxBuckets)   { if (ts >= cutoff) totalTx  += count; }
  for (const [ts, count] of sttTxBuckets)   { if (ts >= cutoff) sttTx    += count; }
  for (const [ts, count] of whaleTxBuckets) { if (ts >= cutoff) whaleTx  += count; }

  return {
    whaleTxRate: sttTx > 0 ? Math.min(100, (whaleTx / sttTx) * 100) : 0,
    whaleTx,
    totalTx,
    sttTx,
  };
}

export function getShockData(): ShockDataPoint[] {
  // Return completed shock entries, newest last (for chart)
  return completedShock.slice(-20);
}

export function getPercentile(p: number): number {
  if (whaleSizesStt.length < 10) return _whaleThresholdStt;
  const sorted = [...whaleSizesStt].sort((a, b) => a - b);
  return sorted[Math.min(Math.floor(p * sorted.length), sorted.length - 1)];
}

// ── Internals ─────────────────────────────────────────────────────────────────

function inc(map: Map<number, number>, bucket: number) {
  map.set(bucket, (map.get(bucket) ?? 0) + 1);
}

function hexTsToMs(hex: string | undefined): number {
  if (!hex) return 0;
  try { const t = Number(BigInt(hex)) * 1000; return t > 0 ? t : 0; }
  catch { return 0; }
}

function hexAmtToStt(hex: string | undefined): number {
  if (!hex) return 0;
  try { return Number(BigInt(hex)) / 1e18; }
  catch { return parseFloat(hex ?? "0"); }
}

function finalizeExpiredShockWindows(now: number) {
  for (const [key, acc] of activeShockWindows) {
    if (now > acc.whaleTs + 30_000) {
      const score = Math.min(100, Math.round(
        acc.txCount * 2 + acc.wallets.size * 1.5 + acc.followups * 10
      ));
      if (acc.txCount > 0) {
        const label = score >= 81 ? "EXTREME" : score >= 51 ? "HIGH" : score >= 21 ? "ELEVATED" : "NORMAL";
        const color = score >= 81 ? "#ef4444" : score >= 51 ? "#f97316" : score >= 21 ? "#f59e0b" : "#6b7280";
        completedShock.push({
          time:          new Date(acc.whaleTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          score,
          txCount:       acc.txCount,
          uniqueWallets: acc.wallets.size,
          followups:     acc.followups,
          label,
          scoreColor:    color,
          amount:        Math.round(acc.amount),
          token:         acc.token,
          whaleTxHash:   acc.whaleTxHash,
        });
        if (completedShock.length > MAX_SHOCK_ENTRIES) completedShock.shift();
      }
      activeShockWindows.delete(key);
    }
  }
}

function evictOldBuckets(now: number) {
  const cutoff = now - WINDOW_24H;
  for (const key of allTxBuckets.keys())   { if (key < cutoff) allTxBuckets.delete(key);   }
  for (const key of sttTxBuckets.keys())   { if (key < cutoff) sttTxBuckets.delete(key);   }
  for (const key of whaleTxBuckets.keys()) { if (key < cutoff) whaleTxBuckets.delete(key); }
}

function resetCounters() {
  _totalTx24h = 0; _sttTx24h = 0; _whaleTx24h = 0;
  _whaleFees = 0; _whaleFeeEst = false;
  _alerts24h = 0; _momentum24h = 0; _reactions24h = 0;
  allTxBuckets.clear(); sttTxBuckets.clear(); whaleTxBuckets.clear();
  whaleSizesStt.length = 0;
  completedShock.length = 0;
  activeShockWindows.clear();
}