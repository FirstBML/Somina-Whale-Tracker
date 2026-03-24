"use client";

import { useEffect, useRef, useState, useMemo } from "react";

declare global {
  interface Window {
    _processedTxHashes?: Set<string>;
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

    // Log whale parsing
    if (type === "whale") {
      console.log(`🔍 Parsing whale: txHash=${r.txHash?.slice(0,10)}, blockNumber=${r.blockNumber}, hasTxHash=${!!r.txHash}`);
      if (!r.txHash) {
        console.warn(`⚠️ Whale rejected: no txHash`);
        return null;
      }
    }

    const amount = BigInt(r?.amount ?? "0x0");

    let timestamp: number;
    if (type === "whale") {
      const receivedAt = typeof raw?.receivedAt === "number" ? raw.receivedAt : 0;
      timestamp = receivedAt > 0 ? receivedAt : (Number(BigInt(r?.timestamp ?? "0x0")) * 1000 || Date.now());
    } else {
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
const CACHE_VERSION     = "v4";
const CACHE_VERSION_KEY = "wt_cache_version";
const isBrowser = typeof window !== "undefined";
const MAX_BLOCKTX_STATE = 50_000;

function loadCached<T>(key: string): T[] {
  if (!isBrowser) return [];
  try {
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

function getAlertDedupKey(a: WhaleAlert): string {
  if (a.type === "whale") {
    if (a.txHash) {
      return `whale:${a.txHash}`;
    }
    return `whale:sim:${a.timestamp}:${a.from}`;
  }
  if (a.type === "reaction") {
    return `reaction:${a.linkedTxHash ?? a.timestamp}`;
  }
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

      console.log("🔌 Connecting to SSE: /api/whale-events");
      const es = new EventSource("/api/whale-events");
      esRef.current = es;

      es.onopen = () => {
        console.log("✅ SSE Connection OPENED");
        setConnected(true);
        setError(null);
        retryCount.current = 0;
      };

      es.onmessage = (e) => {
        if (e.data === ": ping") return;
        try {
          const msg = JSON.parse(e.data);
          
          // Log every message type
          console.log(`📨 SSE message type: ${msg.type}`, msg.type === "init" ? { 
            alertsCount: msg.alerts?.length,
            sampleFirst: msg.alerts?.[0]
          } : {});

          if (msg.type === "init") {
            console.log("📡 INIT received - raw alerts length:", msg.alerts?.length);
            
            // Remove the dbLatestBlock check - always process init
            const allAlerts = msg.alerts || [];

            // Parse all non-block_tx alerts
            const rawParsed: WhaleAlert[] = [];
            for (const alert of allAlerts) {
              if (alert.type !== "block_tx") {
                const parsed = parseEntry(alert);
                if (parsed) {
                  rawParsed.push(parsed);
                }
              }
            }
            
            console.log(`📊 rawParsed count: ${rawParsed.length}`);

            // Dedup
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

            console.log("📊 Frontend alerts after init:", {
              total: parsedAlerts.length,
              whales: parsedAlerts.filter(a => a.type === "whale").length,
              reactions: parsedAlerts.filter(a => a.type === "reaction").length,
              alerts: parsedAlerts.filter(a => a.type === "alert").length,
              momentum: parsedAlerts.filter(a => a.type === "momentum").length
            });

            // Update state
            setAlerts(parsedAlerts);
            setBlockTxs(parsedBlockTxs.slice(0, MAX_BLOCKTX_STATE));
            saveCache(ALERTS_CACHE_KEY, parsedAlerts);
            saveCache(BLOCKTX_CACHE_KEY, parsedBlockTxs.slice(0, 500));

            if (!window._processedTxHashes) window._processedTxHashes = new Set();
            if (!window._processedAlertKeys) window._processedAlertKeys = new Set();

            parsedBlockTxs.forEach(tx => { if (tx.txHash) window._processedTxHashes!.add(tx.txHash); });
            parsedAlerts.forEach(a => { window._processedAlertKeys!.add(getAlertDedupKey(a)); });

            // Update the lastKnownBlock for future reference
            if (msg.dbLatestBlock > lastKnownBlock) {
              lastKnownBlock = msg.dbLatestBlock;
            }

            // Rest of init handler...
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
          }

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

      es.onerror = (err) => {
        console.error("❌ SSE Connection ERROR:", err);
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
    blockTxs,
    blockTxTotal: totalBlockTxsSeen,
    sttTransfers,
    contractCalls,
    totalBlockTxsSeen,
    networkLargestSTT,
    currentThreshold,
    whaleThresholdSTT,
    whalePercentile,
    metrics,
    shockData,
    connected,
    error,
  };
}

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

export function clearFrontendCache(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(ALERTS_CACHE_KEY);
    localStorage.removeItem(BLOCKTX_CACHE_KEY);
    localStorage.removeItem(CACHE_VERSION_KEY);
  } catch {}
}