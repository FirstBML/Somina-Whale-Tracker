"use client";

import { useEffect, useRef, useState, useMemo } from "react";

declare global {
  interface Window {
    _processedTxHashes?: Set<string>;
    // FIX 3 — Separate dedup set for reactions/alerts/momentum
    _processedAlertKeys?: Set<string>;
  }
}

export type AlertType = "whale" | "reaction" | "alert" | "momentum";

export type WhaleAlert = {
  id: string;
  type: AlertType;
  from: string;
  to: string;
  amount: string;
  amountRaw: bigint;
  timestamp: number;
  token: string;
  txHash: string;
  blockNumber: string;
  blockHash: string;
  reactionCount?: string;
  handlerEmitter?: string;
  txFee?: string;
  linkedTxHash?: string;
  signalReason?: string;
};

export type BlockTx = {
  id: string;
  from: string;
  to: string;
  amount: string;
  amountRaw: number;
  isTransfer: boolean;
  txHash: string;
  blockNumber: string;
  timestamp: number;
  txFee: string;
};

// Mirror of analyticsEngine.ts types — kept in sync manually
export type LiveMetrics = {
  totalTx24h: number;
  sttTx24h: number;
  whaleTx24h: number;
  whaleVolumeStt: number;
  avgWhaleSizeStt: number;
  largestWhaleStt: number;
  whaleFees: number;
  whaleFeeEstimated: boolean;
  alerts24h: number;
  momentum24h: number;
  reactions24h: number;
  whaleTxRate: number;
  whaleThresholdStt: number;
  whalePercentile: number;
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

const DEFAULT_METRICS: LiveMetrics = {
  totalTx24h: 0, sttTx24h: 0, whaleTx24h: 0,
  whaleVolumeStt: 0, avgWhaleSizeStt: 0,
  largestWhaleStt: 0, whaleFees: 0, whaleFeeEstimated: false,
  alerts24h: 0, momentum24h: 0, reactions24h: 0,
  whaleTxRate: 0, whaleThresholdStt: 0.5, whalePercentile: 90,
  updatedAt: 0,
};

function parseEntry(raw: any): WhaleAlert | null {
  try {
    const r = raw?.raw ?? raw;
    const type = (raw?.type ?? "whale") as AlertType;

    // Integrity gate: whale entries must have a txHash to be valid
    // blockNumber is NOT required — simulated whales and some old DB rows have no blockNumber
    if (type === "whale") {
    console.log(`🔍 Parsing whale: txHash=${r.txHash?.slice(0,10)}, blockNumber=${r.blockNumber}`);
    if (!r.txHash) {
      console.warn(`⚠️ Whale rejected: no txHash`);
      return null;
    }
  }

    const amount = BigInt(r?.amount ?? "0x0");

    // ── Timestamp strategy ────────────────────────────────────────────────────
    // For WHALE entries: prefer raw.receivedAt (when the server processed the tx).
    // Using the block's mint time caused two visible bugs:
    //   1. Backfilled whales showed "55m ago" while their alerts showed "4m ago"
    //      because alerts always use Date.now() but whales used block timestamp.
    //   2. Alerts sorted ABOVE whales in the feed (alerts had more recent timestamps).
    // Using receivedAt fixes both: whale and its derived alert have near-identical
    // timestamps, so they appear together in the feed in the correct order.
    // The actual block time is still visible in the expanded row via blockNumber + explorer.
    let timestamp: number;
    if (type === "whale") {
      // raw.receivedAt is set by the server at push() time (top-level CacheEntry field)
      const receivedAt = typeof raw?.receivedAt === "number" ? raw.receivedAt : 0;
      timestamp = receivedAt > 0 ? receivedAt : (Number(BigInt(r?.timestamp ?? "0x0")) * 1000 || Date.now());
    } else {
      // For reactions/alerts/momentum: use block timestamp if available, else Date.now()
      let ts = 0;
      try { ts = Number(BigInt(r?.timestamp ?? "0x0")) * 1000; } catch {}
      if (ts > 0 && ts <= Date.now()) timestamp = ts;
      else timestamp = Date.now();
    }

    return {
      id: `${Date.now()}-${Math.random()}`,
      type,
      from: r.from ?? "",
      to: r.to ?? "",
      amountRaw: amount,
      amount: (Number(amount) / 1e18).toFixed(8),
      timestamp,
      token: r.token ?? "",
      txHash: r.txHash ?? "",
      blockNumber: r.blockNumber ?? "",
      blockHash: r.blockHash ?? "",
      reactionCount: r.reactionCount,
      handlerEmitter: r.handlerEmitter,
      txFee: r.txFee ?? "0",
      linkedTxHash: r.linkedTxHash ?? "",
      signalReason: r.signalReason ?? "",
    };
  } catch (e) {
    console.error("parseEntry error:", e, raw);
    return null;
  }
}

function parseBlockTx(msg: any): BlockTx | null {
  try {
    const r = msg?.raw ?? msg;
    const amountRaw = parseFloat(r.amount ?? "0");
    let timestamp = Date.now();
    try {
      const ts = Number(BigInt(r.timestamp ?? "0x0")) * 1000;
      if (ts > 0 && ts <= Date.now()) timestamp = ts;
    } catch {}

    return {
      id: `btx-${Date.now()}-${Math.random()}`,
      from: r.from ?? "",
      to: r.to ?? "",
      amount: amountRaw > 0 ? amountRaw.toFixed(8) : "0.00000000",
      amountRaw,
      isTransfer: amountRaw > 0,
      txHash: r.txHash ?? "",
      blockNumber: r.blockNumber ?? "",
      timestamp,
      txFee: r.txFee ?? "0",
    };
  } catch {
    return null;
  }
}

const ALERTS_CACHE_KEY  = "wt_alerts_cache";
const BLOCKTX_CACHE_KEY = "wt_blocktx_cache";
const CACHE_TTL_MS      = 24 * 60 * 60_000;

// ── Cache versioning — bump this string whenever the data shape changes ───────
// On mismatch the old localStorage data is cleared automatically so users
// never need to do a manual Ctrl+Shift+R to see fresh data.
const CACHE_VERSION     = "v4";
const CACHE_VERSION_KEY = "wt_cache_version";
const isBrowser = typeof window !== "undefined";
const MAX_BLOCKTX_STATE = 5_000; // cap in React state — full data in SQLite via /api/network-activity

function loadCached<T>(key: string): T[] {
  if (!isBrowser) return [];
  try {
    // Auto-clear entire cache if version has changed
    const storedVersion = localStorage.getItem(CACHE_VERSION_KEY);
    if (storedVersion !== CACHE_VERSION) {
      localStorage.removeItem(ALERTS_CACHE_KEY);
      localStorage.removeItem(BLOCKTX_CACHE_KEY);
      localStorage.setItem(CACHE_VERSION_KEY, CACHE_VERSION);
      return [];
    }
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL_MS) { localStorage.removeItem(key); return []; }
    return data as T[];
  } catch { return []; }
}

function saveCache<T>(key: string, data: T[]) {
  if (!isBrowser) return;
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: data })); }
  catch {}
}

// ── FIX: Dedup key — one reaction per whale (linkedTxHash), not per reactionCount ──
// The Reactivity precompile fires 3 events per whale with incrementing counts.
// ── FIX: Dedup key with proper whale deduplication ──
// IMPORTANT: For whales, we MUST use txHash as the primary key.
// Without this, whales with the same timestamp/from pair get filtered out.
// The txHash is the only truly unique identifier for an on-chain transaction.
function getAlertDedupKey(a: WhaleAlert): string {
  if (a.type === "whale") {
    // ALWAYS use txHash for whales - this is the only reliable dedup key
    if (a.txHash) {
      return `whale:${a.txHash}`;
    }
    // Fallback only for simulated whales (which have no txHash)
    return `whale:sim:${a.timestamp}:${a.from}`;
  }
  if (a.type === "reaction") {
    // One reaction per linked whale transaction
    return `reaction:${a.linkedTxHash ?? a.timestamp}`;
  }
  // alert, momentum
  return `${a.type}:${a.linkedTxHash ?? ""}:${a.timestamp}`;
}

let lastKnownBlock = 0;

export function useWhaleAlerts() {
  const [alerts, setAlerts] = useState<WhaleAlert[]>([]);
  const [blockTxs, setBlockTxs] = useState<BlockTx[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [totalBlockTxsSeen, setTotalBlockTxsSeen] = useState(0);
  const [networkLargestSTT, setNetworkLargestSTT] = useState(0);
  const [currentThreshold, setCurrentThreshold] = useState<number | null>(null);
  const [whaleThresholdSTT, setWhaleThresholdSTT] = useState<number | null>(null);
  const [whalePercentile, setWhalePercentile] = useState<number>(95);
  const [metrics, setMetrics] = useState<LiveMetrics>(DEFAULT_METRICS);
  const [shockData, setShockData] = useState<ShockDataPoint[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const esRef = useRef<EventSource | null>(null);
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate from localStorage after mount
  useEffect(() => {
    const cachedAlerts = loadCached<WhaleAlert>(ALERTS_CACHE_KEY);
    const cachedBlockTxs = loadCached<BlockTx>(BLOCKTX_CACHE_KEY);
    if (cachedAlerts.length) setAlerts(cachedAlerts);
    if (cachedBlockTxs.length) setBlockTxs(cachedBlockTxs);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;

    function connect() {
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }

      const es = new EventSource("/api/whale-events");
      esRef.current = es;

      es.onopen = () => {
        setConnected(true);
        setError(null);
        retryCount.current = 0;
      };

      es.onmessage = (e) => {
        if (e.data === ": ping") return;
        try {
          const msg = JSON.parse(e.data);

          if (msg.type === "init") {
            if (msg.dbLatestBlock > lastKnownBlock) {
              lastKnownBlock = msg.dbLatestBlock;
              const allAlerts = msg.alerts || [];

              // ✅ FIX 1: Parse ALL event types from init (including reactions)
              // Previously this only parsed non-block_tx events but reactions
              // need to come through too.
              const rawParsed = allAlerts
                .filter((a: any) => a.type !== "block_tx")
                .map(parseEntry).filter(Boolean) as WhaleAlert[];

              // ✅ FIX 3: Dedup by content key
              const seen = new Set<string>();
              const parsedAlerts = rawParsed.filter(a => {
                const key = getAlertDedupKey(a);
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
              });

              const parsedBlockTxs = allAlerts
                .filter((a: any) => a.type === "block_tx")
                .map(parseBlockTx).filter(Boolean) as BlockTx[];

              setAlerts(parsedAlerts);
              setBlockTxs(parsedBlockTxs.slice(0, MAX_BLOCKTX_STATE)); // cap — full data in SQLite
              saveCache(ALERTS_CACHE_KEY, parsedAlerts);
              saveCache(BLOCKTX_CACHE_KEY, parsedBlockTxs.slice(0, 500)); // localStorage cap

              // Pre-seed dedup sets so live messages don't duplicate loaded history
              if (!window._processedTxHashes) window._processedTxHashes = new Set();
              if (!window._processedAlertKeys) window._processedAlertKeys = new Set();

              parsedBlockTxs.forEach(tx => { if (tx.txHash) window._processedTxHashes!.add(tx.txHash); });
              parsedAlerts.forEach(a => { window._processedAlertKeys!.add(getAlertDedupKey(a)); });
            }

            if (msg.totalBlockTxsSeen) setTotalBlockTxsSeen(msg.totalBlockTxsSeen);
            if (msg.networkLargestSTT) setNetworkLargestSTT(msg.networkLargestSTT);
            if (msg.whaleThresholdSTT) setWhaleThresholdSTT(msg.whaleThresholdSTT);
            if (msg.whalePercentile) setWhalePercentile(msg.whalePercentile);
            if (msg.metrics) setMetrics(msg.metrics);
            if (msg.shock) setShockData(msg.shock);
          }

          if (msg.type === "metrics_update") {
            if (msg.metrics) setMetrics(msg.metrics);
            if (msg.shock) setShockData(msg.shock);
          }

          if (msg.type === "connected") { setConnected(true); setError(null); }
          if (msg.type === "error") setError(msg.message);

          if (["whale", "reaction", "alert", "momentum"].includes(msg.type)) {
          const a = parseEntry(msg);
          if (a) {
            if (!window._processedAlertKeys) window._processedAlertKeys = new Set();
            const key = getAlertDedupKey(a);
            
            // Debug: log whale arrivals
            if (a.type === "whale") {
              console.log(`🐋 Whale received in frontend: ${a.txHash?.slice(0,10)} key=${key} alreadySeen=${window._processedAlertKeys.has(key)}`);
            }
            
            if (window._processedAlertKeys.has(key)) return;
            window._processedAlertKeys.add(key);

            setAlerts(prev => {
              const next = [a, ...prev];
              saveCache(ALERTS_CACHE_KEY, next);
              return next;
            });
          }
        }

          if (msg.type === "block_tx") {
            const txHash = msg.raw?.txHash;
            if (!window._processedTxHashes) {
              window._processedTxHashes = new Set();
            }
            if (txHash && window._processedTxHashes.has(txHash)) {
              return;
            }
            if (txHash) {
              window._processedTxHashes.add(txHash);
            }
            const tx = parseBlockTx(msg);
            if (tx) {
              setBlockTxs(prev => {
                if (prev.some(t => t.txHash === tx.txHash)) return prev;
                const next = [tx, ...prev].slice(0, MAX_BLOCKTX_STATE);
                saveCache(BLOCKTX_CACHE_KEY, next.slice(0, 500));
                return next;
              });
            }
            if (msg.totalBlockTxsSeen) setTotalBlockTxsSeen(msg.totalBlockTxsSeen);
            if (msg.networkLargestSTT) setNetworkLargestSTT(msg.networkLargestSTT);
          } // ← closes the block_tx if block

          if (msg.type === "whale_fee_update" && msg.txHash && msg.txFee) {
            setAlerts(prev => prev.map(a =>
              a.txHash === msg.txHash ? { ...a, txFee: msg.txFee } : a
            ));
          }

          if (msg.type === "threshold_update")
            setCurrentThreshold(parseFloat(msg.raw?.newValue ?? "0"));

        } catch (err) {
          console.error("Error parsing SSE message:", err);
        }
      };

      es.onerror = () => {
        setConnected(false);
        es.close();
        esRef.current = null;
        const delay = Math.min(1000 * 2 ** retryCount.current, 30_000);
        retryCount.current = Math.min(retryCount.current + 1, 10);
        setError(`SSE disconnected. Retrying in ${Math.round(delay / 1000)}s…`);
        retryTimer.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [hydrated]);

  const sttTransfers = useMemo(() => blockTxs.filter(tx => tx.isTransfer), [blockTxs]);
  const contractCalls = useMemo(() => blockTxs.filter(tx => !tx.isTransfer), [blockTxs]);

  return {
    alerts,
    blockTxs, // capped at 5000 — for display only
    blockTxTotal: totalBlockTxsSeen,
    sttTransfers,
    contractCalls,
    totalBlockTxsSeen,
    networkLargestSTT,
    currentThreshold,
    whaleThresholdSTT,
    whalePercentile,
    metrics, // pre-computed by analyticsEngine — no frontend math needed
    shockData, // pre-computed shock scores per whale event
    connected,
    error,
  };
}

// ── Filter-aware metrics fetcher ──────────────────────────────────────────────
// Call this from the dashboard whenever window/min/max/token/wallet filters
// change. Returns filtered KPIs from the backend analyticsEngine.
// This is separate from the SSE stream so it doesn't block real-time updates.

export type MetricsFilter = {
  windowMs?: number;
  minStt?: number;
  maxStt?: number;
  token?: string;
  wallet?: string;
};

export async function fetchFilteredMetrics(filter: MetricsFilter = {}): Promise<LiveMetrics | null> {
  try {
    const params = new URLSearchParams();
    if (filter.windowMs != null) params.set("window", String(filter.windowMs));
    if (filter.minStt   != null) params.set("min",    String(filter.minStt));
    if (filter.maxStt   != null) params.set("max",    String(filter.maxStt));
    if (filter.token)             params.set("token",  filter.token);
    if (filter.wallet)            params.set("wallet", filter.wallet);

    const res = await fetch(`/api/metrics?${params.toString()}`);
    if (!res.ok) return null;
    const data = await res.json();
    return data.metrics as LiveMetrics;
  } catch {
    return null;
  }
}

// ── Cache utilities ───────────────────────────────────────────────────────────

/**
 * clearFrontendCache — wipes all cached whale/block_tx data from localStorage.
 * Call this when the user clicks "Clear Cache" in the dashboard, or when data
 * looks stale after a server restart. The SSE connection will immediately
 * reseed from the fresh server-side init payload.
 */
export function clearFrontendCache(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(ALERTS_CACHE_KEY);
    localStorage.removeItem(BLOCKTX_CACHE_KEY);
    // Bump the stored version so loadCached() doesn't restore anything until
    // the next saveCache() call (which sets the correct version again).
    localStorage.removeItem(CACHE_VERSION_KEY);
  } catch {}
}