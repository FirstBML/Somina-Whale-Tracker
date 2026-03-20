"use client";
import { useEffect, useRef, useState, useMemo } from "react";

declare global {
  interface Window {
    _processedTxHashes?: Set<string>;
  }
}

export type AlertType = "whale" | "reaction" | "alert" | "momentum";

export type WhaleAlert = {
  id:             string;
  type:           AlertType;
  from:           string;
  to:             string;
  amount:         string;
  amountRaw:      bigint;
  timestamp:      number;
  token:          string;
  txHash:         string;
  blockNumber:    string;
  blockHash:      string;
  reactionCount?: string;
  handlerEmitter?: string;
  txFee?:         string;
  linkedTxHash?:  string;
  signalReason?:  string;
};

export type BlockTx = {
  id:          string;
  from:        string;
  to:          string;
  amount:      string;
  amountRaw:   number;
  isTransfer:  boolean;
  txHash:      string;
  blockNumber: string;
  timestamp:   number;
  txFee:       string;
};

function parseEntry(raw: any): WhaleAlert | null {
  try {
    const r    = raw?.raw ?? raw;
    const type = (raw?.type ?? "whale") as AlertType;

    // Integrity gate: whale entries must have txHash + blockNumber
    if (type === "whale" && (!r.txHash || !r.blockNumber)) return null;

    const amount    = BigInt(r?.amount ?? "0x0");
    const timestamp = Number(BigInt(r?.timestamp ?? "0x0")) * 1000 || Date.now();

    return {
      id:             `${Date.now()}-${Math.random()}`,
      type,
      from:           r.from         ?? "",
      to:             r.to           ?? "",
      amountRaw:      amount,
      amount:         (Number(amount) / 1e18).toFixed(8),
      timestamp,
      token:          r.token        ?? "",
      txHash:         r.txHash       ?? "",
      blockNumber:    r.blockNumber  ?? "",
      blockHash:      r.blockHash    ?? "",
      reactionCount:  r.reactionCount,
      handlerEmitter: r.handlerEmitter,
      txFee:          r.txFee        ?? "0",  
      linkedTxHash:   r.linkedTxHash ?? "",
      signalReason:   r.signalReason ?? "",
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
      id:          `btx-${Date.now()}-${Math.random()}`,
      from:        r.from        ?? "",
      to:          r.to          ?? "",
      amount:      amountRaw > 0 ? amountRaw.toFixed(8) : "0.00000000",
      amountRaw,
      isTransfer:  amountRaw > 0,
      txHash:      r.txHash      ?? "",
      blockNumber: r.blockNumber ?? "",
      timestamp,
      txFee:       r.txFee ?? "0",
    };
  } catch {
    return null;
  }
}

const ALERTS_CACHE_KEY  = "wt_alerts_cache";
const BLOCKTX_CACHE_KEY = "wt_blocktx_cache";
const CACHE_TTL_MS      = 24 * 60 * 60_000;
const isBrowser         = typeof window !== "undefined";

function loadCached<T>(key: string): T[] {
  if (!isBrowser) return [];
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const { ts, data } = JSON.parse(raw);
    if (Date.now() - ts > CACHE_TTL_MS) { localStorage.removeItem(key); return []; }
    return data as T[];
  } catch { return []; }
}

function saveCache<T>(key: string, data: T[]) {
  if (!isBrowser) return;
  try { localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data: data})); }
  catch {}
}

let lastKnownBlock = 0;

export function useWhaleAlerts() {
  const [alerts,            setAlerts]           = useState<WhaleAlert[]>([]);
  const [blockTxs,          setBlockTxs]         = useState<BlockTx[]>([]);
  const [hydrated,          setHydrated]         = useState(false);
  const [totalBlockTxsSeen, setTotalBlockTxsSeen] = useState(0);
  const [networkLargestSTT, setNetworkLargestSTT] = useState(0);
  const [currentThreshold,    setCurrentThreshold]    = useState<number | null>(null);
  const [whaleThresholdSTT,   setWhaleThresholdSTT]   = useState<number | null>(null);
  const [whalePercentile,     setWhalePercentile]     = useState<number>(95);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Hydrate from localStorage after mount
  useEffect(() => {
    const cachedAlerts   = loadCached<WhaleAlert>(ALERTS_CACHE_KEY);
    const cachedBlockTxs = loadCached<BlockTx>(BLOCKTX_CACHE_KEY);
    if (cachedAlerts.length)   setAlerts(cachedAlerts);
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

            // ✅ Separate whale events from block_tx — parseEntry ignores block_tx type
            const parsedAlerts = allAlerts
              .filter((a: any) => a.type !== "block_tx")
              .map(parseEntry).filter(Boolean) as WhaleAlert[];

            const parsedBlockTxs = allAlerts
              .filter((a: any) => a.type === "block_tx")
              .map(parseBlockTx).filter(Boolean) as BlockTx[];

            setAlerts(parsedAlerts);
            setBlockTxs(parsedBlockTxs);
            saveCache(ALERTS_CACHE_KEY, parsedAlerts);
            saveCache(BLOCKTX_CACHE_KEY, parsedBlockTxs);

            // Pre-seed dedup set so live messages don't duplicate loaded history
            if (!window._processedTxHashes) window._processedTxHashes = new Set();
            parsedBlockTxs.forEach(tx => { if (tx.txHash) window._processedTxHashes!.add(tx.txHash); });
          }

          if (msg.totalBlockTxsSeen) setTotalBlockTxsSeen(msg.totalBlockTxsSeen);
          if (msg.networkLargestSTT) setNetworkLargestSTT(msg.networkLargestSTT);
        }
          
          if (msg.type === "connected") { setConnected(true); setError(null); }
          if (msg.type === "error") setError(msg.message);

          if (["whale","reaction","alert","momentum"].includes(msg.type)) {
            const a = parseEntry(msg);
            if (a) setAlerts(prev => {
              const next = [a, ...prev];
              saveCache(ALERTS_CACHE_KEY, next);
              return next;
            });
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
                const next = [tx, ...prev];
                saveCache(BLOCKTX_CACHE_KEY, next);
                return next;
              });
            }
            if (msg.totalBlockTxsSeen) setTotalBlockTxsSeen(msg.totalBlockTxsSeen);
            if (msg.networkLargestSTT) setNetworkLargestSTT(msg.networkLargestSTT);
          }  // ← closes the block_tx if block

          if (msg.type === "whale_fee_update" && msg.txHash && msg.txFee) {
            setAlerts(prev => prev.map(a =>
              a.txHash === msg.txHash ? { ...a, txFee: msg.txFee } : a
            ));
          }

          if (msg.type === "threshold_update") setCurrentThreshold(parseFloat(msg.raw?.newValue ?? "0"));
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
    blockTxs,
    sttTransfers,
    contractCalls,
    totalBlockTxsSeen,
    networkLargestSTT,
    currentThreshold,
    whaleThresholdSTT,
    whalePercentile,
    connected,
    error,
  };
}