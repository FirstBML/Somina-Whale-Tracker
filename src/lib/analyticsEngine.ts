/**
 * analyticsEngine.ts — Backend analytics layer
 *
 * Maintains all metrics incrementally as events arrive.
 * Every query is O(1) or O(buckets) — never O(transactions).
 * Frontend becomes pure display: it renders pre-computed values, never filters arrays.
 *
 * FIX: Added getFilteredMetrics(filter) so KPIs/charts respond to
 *      window, min, max, token, and wallet filters correctly.
 *      Filtered queries run over the raw event log (kept in a bounded ring buffer)
 *      rather than the incremental counters, so unfiltered paths stay O(1).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type LiveMetrics = {
  // Network
  totalTx24h: number;
  sttTx24h: number;
  // Whales
  whaleTx24h: number;
  whaleVolumeStt: number;
  avgWhaleSizeStt: number;
  largestWhaleStt: number;
  whaleFees: number;
  whaleFeeEstimated: boolean;
  // Signals
  alerts24h: number;
  momentum24h: number;
  reactions24h: number;
  // Rates
  whaleTxRate: number;    // % of STT transfers that are whales (0-100)
  whaleTxRateRaw: number; // same but not capped
  // Threshold
  whaleThresholdStt: number;
  whalePercentile: number;
  // Time
  updatedAt: number;
};

export type ShockDataPoint = {
  time: string;
  score: number;
  txCount: number;
  uniqueWallets: number;
  followups: number;
  label: string;
  scoreColor: string;
  amount: number;
  token: string;
  whaleTxHash: string;
};

export type WindowMetrics = {
  whaleTxRate: number;
  whaleTx: number;
  totalTx: number;
  sttTx: number;
};

// ── Filter type for filtered KPI queries ──────────────────────────────────────

export type MetricsFilter = {
  windowMs?: number;   // default: 24h
  minStt?: number;     // minimum whale size in STT
  maxStt?: number;     // maximum whale size in STT
  token?: string;      // token symbol filter (e.g. "STT")
  wallet?: string;     // wallet address filter (from or to, lowercase)
};

// ── Internal state ────────────────────────────────────────────────────────────

const BUCKET_MS   = 60_000;          // 1-minute buckets
const WINDOW_24H  = 24 * 60 * 60_000;
const MAX_WHALE_SAMPLES = 1_000;
const MAX_SHOCK_ENTRIES = 50;

// ── Raw event ring buffer — used for filtered queries ─────────────────────────
// Keeps the last MAX_RAW_EVENTS entries. Filtered KPI queries scan this buffer
// (O(n) where n ≤ MAX_RAW_EVENTS) instead of rebuilding counters.
// Unfiltered paths still use O(1) incremental counters.
const MAX_RAW_EVENTS = 50_000;
type RawEvent = {
  type: string;
  receivedAt: number;
  amountStt: number;    // 0 for non-whale events
  fromAddr: string;
  toAddr: string;
  token: string;
  txFee: number;
  feeEstimated: boolean;
  txHash: string;
};
const rawEvents: RawEvent[] = [];

// Rolling time buckets { bucket_start_ms → count }
const allTxBuckets:   Map<number, number> = new Map();
const sttTxBuckets:   Map<number, number> = new Map();
const whaleTxBuckets: Map<number, number> = new Map();

// Recent whale sizes for average/percentile
const whaleSizesStt: number[] = [];

// Per-whale network-reaction window (for shock score)
type ShockAccumulator = {
  whaleTxHash: string;
  whaleTs: number;
  amount: number;
  token: string;
  txCount: number;
  wallets: Set<string>;
  followups: number;
};
const activeShockWindows: Map<string, ShockAccumulator> = new Map();
const completedShock: ShockDataPoint[] = [];

// Cumulative totals (reset on eviction — approximate, sufficient for display)
let _totalTx24h  = 0;
let _sttTx24h    = 0;
let _whaleTx24h  = 0;
let _whaleVolStt = 0;
let _largestStt  = 0;
let _whaleFees   = 0;
let _whaleFeeEst = false;
let _alerts24h   = 0;
let _momentum24h = 0;
let _reactions24h = 0;
let _whaleThresholdStt = 0.5;
let _whalePercentile   = 90;

// ── Public API ────────────────────────────────────────────────────────────────

export function setThresholdMeta(stt: number, percentile: number) {
  _whaleThresholdStt = stt;
  _whalePercentile   = percentile;
}

/**
 * Call this inside push() for every event.
 * This is the only place state is mutated.
 */
export function processEvent(
  type: string,
  raw: Record<string, any>,
  receivedAt: number,
) {
  const now    = receivedAt;
  const bucket = Math.floor(now / BUCKET_MS) * BUCKET_MS;

  // ── Raw ring buffer entry ──────────────────────────────────────────────────
  const amountStt = type === "whale" ? hexAmtToStt(raw.amount) : parseFloat(raw.amount ?? "0");
  const txFeeRaw  = parseFloat((raw.txFee ?? "0").replace("~", ""));
  const rawEntry: RawEvent = {
    type,
    receivedAt,
    amountStt: isNaN(amountStt) ? 0 : amountStt,
    fromAddr: (raw.from ?? "").toLowerCase(),
    toAddr:   (raw.to ?? "").toLowerCase(),
    token:    raw.token ?? "STT",
    txFee:    isNaN(txFeeRaw) ? 0 : txFeeRaw,
    feeEstimated: (raw.txFee ?? "").startsWith("~"),
    txHash: raw.txHash ?? "",
  };
  rawEvents.push(rawEntry);
  if (rawEvents.length > MAX_RAW_EVENTS) rawEvents.shift();

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
    finalizeExpiredShockWindows(txTs);

  } else if (type === "whale") {
    _whaleTx24h++;
    inc(whaleTxBuckets, bucket);
    const stt = hexAmtToStt(raw.amount);
    _whaleVolStt += stt;
    if (stt > _largestStt) _largestStt = stt;
    const fee = parseFloat((raw.txFee ?? "0").replace("~", ""));
    if (!isNaN(fee) && fee > 0) {
      _whaleFees += fee;
      if (raw.txFee?.startsWith("~")) _whaleFeeEst = true;
    }
    whaleSizesStt.push(stt);
    if (whaleSizesStt.length > MAX_WHALE_SAMPLES) whaleSizesStt.shift();
    // Open shock accumulator for this whale
    if (raw.txHash) {
      const whaleTs = hexTsToMs(raw.timestamp) || now;
      activeShockWindows.set(raw.txHash, {
        whaleTxHash: raw.txHash, whaleTs,
        amount: stt, token: raw.token ?? "STT",
        txCount: 0, wallets: new Set(), followups: 0,
      });
    }
    // Count follow-up whale events in existing open windows
    const whaleTs = hexTsToMs(raw.timestamp) || now;
    for (const [key, acc] of activeShockWindows) {
      if (key !== raw.txHash && whaleTs > acc.whaleTs && whaleTs <= acc.whaleTs + 30_000) {
        acc.followups++;
      }
    }
  } else if (type === "alert")    { _alerts24h++; }
  else if (type === "momentum")   { _momentum24h++; }
  else if (type === "reaction")   { _reactions24h++; }

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

  // ── Whale rate — % of STT value transfers that are whale-sized ──────────
  // Denominator is sttTx24h (block_tx entries with amount > 0) as requested.
  // Semantic: "of all transfers that moved STT value, what fraction were whale-sized?"
  // This aligns with the STT TXN KPI shown in the sidebar.
  const whaleTxRateRaw = _sttTx24h > 0 ? (_whaleTx24h / _sttTx24h) * 100 : 0;
  const whaleTxRate    = Math.min(100, whaleTxRateRaw);

  return {
    totalTx24h:      _totalTx24h,
    sttTx24h:        _sttTx24h,
    whaleTx24h:      _whaleTx24h,
    whaleVolumeStt:  _whaleVolStt,
    avgWhaleSizeStt: avg,
    largestWhaleStt: _largestStt,
    whaleFees:       _whaleFees,
    whaleFeeEstimated: _whaleFeeEst,
    alerts24h:       _alerts24h,
    momentum24h:     _momentum24h,
    reactions24h:    _reactions24h,
    whaleTxRate,
    whaleTxRateRaw,
    whaleThresholdStt: _whaleThresholdStt,
    whalePercentile:   _whalePercentile,
    updatedAt: Date.now(),
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
    whaleTx, totalTx, sttTx,
  };
}

/**
 * FIX: getFilteredMetrics — computes KPIs for any combination of filters.
 *
 * All KPI cards (Whale Volume, Largest Whale, Whale Fees, STT TXN, TXN COUNT,
 * Whale Rate) and charts should call this when any filter is active.
 * Falls back to getMetrics() when no filter is set (O(1) path).
 *
 * Filters:
 *   windowMs — time window in ms (default 24h)
 *   minStt   — minimum whale size in STT
 *   maxStt   — maximum whale size in STT
 *   token    — token symbol (case-insensitive)
 *   wallet   — wallet address (from or to, case-insensitive)
 */
export function getFilteredMetrics(filter: MetricsFilter = {}): LiveMetrics {
  const {
    windowMs = WINDOW_24H,
    minStt,
    maxStt,
    token,
    wallet,
  } = filter;

  // If no active filter, return cached O(1) result
  const hasFilter = minStt != null || maxStt != null || token || wallet || windowMs !== WINDOW_24H;
  if (!hasFilter) return getMetrics();

  const cutoff       = Date.now() - windowMs;
  const walletLower  = wallet?.toLowerCase();
  const tokenLower   = token?.toLowerCase();

  let totalTx    = 0;
  let sttTx      = 0;
  let whaleTx    = 0;
  let whaleVol   = 0;
  let largestStt = 0;
  let whaleFees  = 0;
  let feeEst     = false;
  let alerts     = 0;
  let momentum   = 0;
  let reactions  = 0;
  const whaleSizes: number[] = [];

  for (const e of rawEvents) {
    if (e.receivedAt < cutoff) continue;

    // Wallet filter: skip if neither from nor to matches
    if (walletLower) {
      if (e.fromAddr !== walletLower && e.toAddr !== walletLower) continue;
    }

    // Token filter (primarily for non-STT future support)
    if (tokenLower && e.token.toLowerCase() !== tokenLower) continue;

    if (e.type === "block_tx") {
      totalTx++;
      if (e.amountStt > 0) sttTx++;

    } else if (e.type === "whale") {
      const stt = e.amountStt;
      if (minStt != null && stt < minStt) continue;
      if (maxStt != null && stt > maxStt) continue;

      whaleTx++;
      whaleVol += stt;
      if (stt > largestStt) largestStt = stt;
      if (e.txFee > 0) {
        whaleFees += e.txFee;
        if (e.feeEstimated) feeEst = true;
      }
      whaleSizes.push(stt);

    } else if (e.type === "alert")    { alerts++; }
    else if (e.type === "momentum")   { momentum++; }
    else if (e.type === "reaction")   { reactions++; }
  }

  const avg = whaleSizes.length > 0
    ? whaleSizes.reduce((s, v) => s + v, 0) / whaleSizes.length
    : 0;

  const whaleTxRateRaw = sttTx > 0 ? (whaleTx / sttTx) * 100 : 0;

  return {
    totalTx24h:        totalTx,
    sttTx24h:          sttTx,
    whaleTx24h:        whaleTx,
    whaleVolumeStt:    whaleVol,
    avgWhaleSizeStt:   avg,
    largestWhaleStt:   largestStt,
    whaleFees,
    whaleFeeEstimated: feeEst,
    alerts24h:         alerts,
    momentum24h:       momentum,
    reactions24h:      reactions,
    whaleTxRate:       Math.min(100, whaleTxRateRaw),
    whaleTxRateRaw,
    whaleThresholdStt: _whaleThresholdStt,
    whalePercentile:   _whalePercentile,
    updatedAt: Date.now(),
  };
}

export function getShockData(): ShockDataPoint[] {
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
          time: new Date(acc.whaleTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
          score, txCount: acc.txCount, uniqueWallets: acc.wallets.size,
          followups: acc.followups, label, scoreColor: color,
          amount: Math.round(acc.amount), token: acc.token, whaleTxHash: acc.whaleTxHash,
        });
        if (completedShock.length > MAX_SHOCK_ENTRIES) completedShock.shift();
      }
      activeShockWindows.delete(key);
    }
  }
}

function evictOldBuckets(now: number) {
  const cutoff = now - WINDOW_24H;
  for (const key of allTxBuckets.keys())   { if (key < cutoff) allTxBuckets.delete(key); }
  for (const key of sttTxBuckets.keys())   { if (key < cutoff) sttTxBuckets.delete(key); }
  for (const key of whaleTxBuckets.keys()) { if (key < cutoff) whaleTxBuckets.delete(key); }
}

function resetCounters() {
  _totalTx24h = 0; _sttTx24h = 0; _whaleTx24h = 0;
  _whaleVolStt = 0; _largestStt = 0;
  _whaleFees = 0; _whaleFeeEst = false;
  _alerts24h = 0; _momentum24h = 0; _reactions24h = 0;
  allTxBuckets.clear(); sttTxBuckets.clear(); whaleTxBuckets.clear();
  whaleSizesStt.length = 0;
  completedShock.length = 0;
  activeShockWindows.clear();
  rawEvents.length = 0;
}