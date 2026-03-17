"use client";
import { useEffect, useRef, useState, useMemo } from "react";

declare global {
  interface Window {
    _processedTxHashes?: Set<string>;
    _processedPendingKeys?: Set<string>;
  }
}

export type AlertType = "whale" | "reaction" | "alert" | "momentum" | "whale_pending" | "whale_confirmed";

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
  isPending?:     boolean;
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

    if (type === "alert" || type === "momentum" || type === "whale_pending") {
      return {
        id:            `${Date.now()}-${Math.random()}`,
        type,
        from:          r.from ?? "",
        to:            r.to ?? "",
        amount:        r.amount ? (Number(BigInt(r.amount)) / 1e18).toFixed(8) : "0",
        amountRaw:     BigInt(r.amount ?? "0x0"),
        timestamp:     Number(BigInt(r.timestamp ?? "0x0")) * 1000 || Date.now(),
        token:         r.token ?? "",
        txHash:        r.txHash ?? "",
        blockNumber:   r.blockNumber ?? "",
        blockHash:     r.blockHash ?? "",
        reactionCount: r.reactionCount,
        isPending:     type === "whale_pending",
      };
    }

    const amount    = BigInt(r?.amount    ?? "0x0");
    // Use block timestamp if available
    const timestamp = r.blockTimestamp 
      ? Number(r.blockTimestamp)
      : Number(BigInt(r.timestamp ?? "0x0")) * 1000 || Date.now();

    return {
      id:             `${Date.now()}-${Math.random()}`,
      type,
      from:           r.from  ?? "",
      to:             r.to    ?? "",
      amountRaw:      amount,
      amount:         (Number(amount) / 1e18).toFixed(8),
      timestamp,
      token:          r.token ?? "",
      txHash:         r.txHash      ?? "",
      blockNumber:    r.blockNumber ?? "",
      blockHash:      r.blockHash   ?? "",
      reactionCount:  r.reactionCount,
      handlerEmitter: r.handlerEmitter,
      txFee:          r.txFee ?? "0",
      isPending:      false,
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

export type ExplorerStats = {
  txCount24h:   number;
  totalFees24h: number;
  avgFee24h:    number;
  fetchedAt:    number;
};

export function useWhaleAlerts(maxAlerts = 200) {
  const [alerts, setAlerts] = useState<WhaleAlert[]>([]);
  const [blockTxs, setBlockTxs] = useState<BlockTx[]>([]);
  const [totalBlockTxsSeen, setTotalBlockTxsSeen] = useState(0);
  const [networkLargestSTT, setNetworkLargestSTT] = useState(0);
  const [currentThreshold, setCurrentThreshold] = useState<number | null>(null);
  const [explorerStats, setExplorerStats] = useState<ExplorerStats | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
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
            const all = msg.alerts as any[];
            setAlerts(
              all.filter(a => a.type !== "block_tx")
                .map(parseEntry)
                .filter(Boolean)
                .reverse() as WhaleAlert[]
            );
            setBlockTxs(
              all.filter(a => a.type === "block_tx")
                .map(parseBlockTx)
                .filter(Boolean)
                .reverse() as BlockTx[]
            );
            if (msg.totalBlockTxsSeen) setTotalBlockTxsSeen(msg.totalBlockTxsSeen);
            if (msg.networkLargestSTT) setNetworkLargestSTT(msg.networkLargestSTT);
            if (msg.explorerStats) setExplorerStats(msg.explorerStats);
          }
          
          if (msg.type === "connected") {
            setConnected(true);
            setError(null);
          }
          
          if (msg.type === "error") setError(msg.message);
          
          // Handle pending whales from SDK
          if (msg.type === "whale_pending") {
            const a = parseEntry(msg);
            if (a) {
              // Mark as pending with special styling
              a.isPending = true;
              setAlerts(prev => [a, ...prev]);
              console.log(`⚡ Pending whale: ${a.from.slice(0,8)}→${a.to.slice(0,8)}`);
            }
          }
          
          // Handle confirmed whales (from block watcher)
          if (msg.type === "whale") {
            const a = parseEntry(msg);
            if (a) {
              setAlerts(prev => {
                // Remove any pending version of this transaction
                const filtered = prev.filter(p => 
                  !(p.isPending && p.from === a.from && p.to === a.to && p.amount === a.amount)
                );
                return [a, ...filtered];
              });
              console.log(`✅ Confirmed whale: ${a.from.slice(0,8)}→${a.to.slice(0,8)} tx:${a.txHash.slice(0,10)}`);
            }
          }
          
          if (["reaction","alert","momentum"].includes(msg.type)) {
            const a = parseEntry(msg);
            if (a) setAlerts(prev => [a, ...prev]);
          }
          
          // ============= FIX: Block tx deduplication =============
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
                return [tx, ...prev];
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
          
          if (msg.type === "explorer_stats" && msg.stats) setExplorerStats(msg.stats);
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
  }, [maxAlerts]);

  const sttTransfers = useMemo(() => blockTxs.filter(tx => tx.isTransfer), [blockTxs]);
  const contractCalls = useMemo(() => blockTxs.filter(tx => !tx.isTransfer), [blockTxs]);
  const pendingWhales = useMemo(() => alerts.filter(a => a.isPending), [alerts]);

  return {
    alerts,
    blockTxs,
    sttTransfers,
    contractCalls,
    pendingWhales,
    totalBlockTxsSeen,
    networkLargestSTT,
    currentThreshold,
    explorerStats,
    connected,
    error,
  };
}