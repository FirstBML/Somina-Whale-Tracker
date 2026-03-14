"use client";
import { useEffect, useRef, useState, useMemo } from "react";

// Add to global Window interface for TypeScript
declare global {
  interface Window {
    _processedTxMap?: Map<string, number>;
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
  txFee?:         string; // estimated fee in STT
};

export type BlockTx = {
  id:          string;
  from:        string;
  to:          string;
  amount:      string;
  amountRaw:   number;
  isTransfer:  boolean; // true = STT value > 0, false = contract call
  txHash:      string;
  blockNumber: string;
  timestamp:   number;
  txFee:       string; // estimated fee in STT (gasPrice * gasLimit / 1e18)
};

function parseEntry(raw: any): WhaleAlert | null {
  try {
    const r    = raw?.raw ?? raw;
    const type = (raw?.type ?? "whale") as AlertType;

    if (type === "alert" || type === "momentum") {
      return {
        id:            `${Date.now()}-${Math.random()}`,
        type,
        from: "", to: "", amount: "0", amountRaw: 0n,
        timestamp:     Number(BigInt(r.timestamp ?? "0x0")) * 1000 || Date.now(),
        token:         "",
        txHash:        r.txHash      ?? "",
        blockNumber:   r.blockNumber ?? "",
        blockHash:     r.blockHash   ?? "",
        reactionCount: r.reactionCount,
      };
    }

    const amount    = BigInt(r?.amount    ?? "0x0");
    const timestamp = BigInt(r?.timestamp ?? "0x0");

    return {
      id:             `${Date.now()}-${Math.random()}`,
      type,
      from:           r.from  ?? "",
      to:             r.to    ?? "",
      amountRaw:      amount,
      amount:         (Number(amount) / 1e18).toFixed(8),
      timestamp:      Number(timestamp) * 1000 || Date.now(),
      token:          r.token ?? "",
      txHash:         r.txHash      ?? "",
      blockNumber:    r.blockNumber ?? "",
      blockHash:      r.blockHash   ?? "",
      reactionCount:  r.reactionCount,
      handlerEmitter: r.handlerEmitter,
      txFee:          r.txFee ?? "0",
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
  const [alerts,            setAlerts]           = useState<WhaleAlert[]>([]);
  const [blockTxs,          setBlockTxs]         = useState<BlockTx[]>([]);
  const [totalBlockTxsSeen, setTotalBlockTxsSeen] = useState(0);
  const [networkLargestSTT, setNetworkLargestSTT] = useState(0);
  const [currentThreshold,  setCurrentThreshold]  = useState<number|null>(null);
  const [explorerStats,     setExplorerStats]     = useState<ExplorerStats|null>(null);
  const [connected,         setConnected]         = useState(false);
  const [error,             setError]             = useState<string | null>(null);
  const esRef      = useRef<EventSource | null>(null);
  const retryCount = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function connect() {
      if (esRef.current) { esRef.current.close(); esRef.current = null; }
      const es = new EventSource("/api/whale-events");
      esRef.current = es;

      es.onopen = () => { setConnected(true); setError(null); retryCount.current = 0; };

      es.onmessage = (e) => {
        if (e.data === ": ping") return;
        
        try {
          const msg = JSON.parse(e.data);
          
          // Log every message type (optional - comment out in production)
          // console.log(`📨 Message type: ${msg.type}`, msg);
          
          if (msg.type === "init") {
            console.log(`🔄 INIT - totalBlockTxsSeen: ${msg.totalBlockTxsSeen}`);
            const all = msg.alerts as any[];
            setAlerts(
              all.filter(a => a.type !== "block_tx")
                .map(parseEntry).filter(Boolean).reverse().slice(0, maxAlerts) as WhaleAlert[]
            );
            setBlockTxs(
              all.filter(a => a.type === "block_tx")
                .map(parseBlockTx).filter(Boolean).reverse().slice(0, 50_000) as BlockTx[]
            );
            if (msg.totalBlockTxsSeen) setTotalBlockTxsSeen(msg.totalBlockTxsSeen);
            if (msg.networkLargestSTT) setNetworkLargestSTT(msg.networkLargestSTT);
            if (msg.explorerStats)     setExplorerStats(msg.explorerStats);
          }
          
          if (msg.type === "connected") { 
            console.log("🔌 Connected to SSE stream");
            setConnected(true); 
            setError(null); 
          }
          
          if (msg.type === "error") setError(msg.message);
          
          if (["whale","reaction","alert","momentum"].includes(msg.type)) {
            console.log(`🐋 New ${msg.type} event received`);
            const a = parseEntry(msg);
            if (a) setAlerts(prev => [a, ...prev].slice(0, maxAlerts));
          }
          
          // ============= FIXED BLOCK_TX HANDLING WITH DEDUPLICATION =============
          if (msg.type === "block_tx") {
            // Initialize the deduplication map if it doesn't exist
            if (typeof window !== 'undefined' && !window._processedTxMap) {
              window._processedTxMap = new Map<string, number>(); // key: txHash, value: timestamp
            }
            
            const txHash = msg.raw?.txHash;
            const now = Date.now();
            const ONE_HOUR = 60 * 60 * 1000; // 1 hour window
            
            // Clean up entries older than 1 hour (runs periodically)
            if (typeof window !== 'undefined' && window._processedTxMap && window._processedTxMap.size > 0) {
              // Only clean up every 100 messages to avoid performance hit
              if (Math.random() < 0.01) { // 1% chance on each message
                let cleaned = 0;
                for (const [hash, timestamp] of window._processedTxMap.entries()) {
                  if (now - timestamp > ONE_HOUR) {
                    window._processedTxMap.delete(hash);
                    cleaned++;
                  }
                }
                if (cleaned > 0) {
                  console.log(`🧹 Cleaned up ${cleaned} old entries from dedup map`);
                }
              }
            }
            
            // Check for duplicates using the Map
            if (txHash && typeof window !== 'undefined' && window._processedTxMap?.has(txHash)) {
              console.log(`⏭️ Skipping duplicate tx: ${txHash.slice(0, 10)}...`);
              return; // Skip this duplicate message
            }
            
            // Mark as processed with timestamp
            if (txHash && typeof window !== 'undefined' && window._processedTxMap) {
              window._processedTxMap.set(txHash, now);
            }
            
            // Log before state update
            console.log(`📦 BLOCK TX - counter before: ${totalBlockTxsSeen}`);
            
            const tx = parseBlockTx(msg);
            if (tx) {
              setBlockTxs(prev => {
                // Double-check in case the message slipped through (belt and suspenders)
                const exists = prev.some(t => t.txHash === tx.txHash);
                if (exists) {
                  console.log(`⚠️ Duplicate tx ${tx.txHash.slice(0,10)}... found in array, skipping`);
                  return prev;
                }
                
                console.log(`   Adding new TX: ${tx.txHash.slice(0, 10)}... amount: ${tx.amount} STT`);
                return [tx, ...prev].slice(0, 50_000);
              });
              
              // Use the server's counter if available, otherwise increment
              if (msg.totalBlockTxsSeen !== undefined) {
                console.log(`📊 Using server counter: ${msg.totalBlockTxsSeen}`);
                setTotalBlockTxsSeen(msg.totalBlockTxsSeen);
              } else {
                setTotalBlockTxsSeen(prev => {
                  const newVal = prev + 1;
                  console.log(`📊 Incrementing counter from ${prev} to ${newVal}`);
                  return newVal;
                });
              }
            }
            
            if (msg.networkLargestSTT) setNetworkLargestSTT(msg.networkLargestSTT);
          }
          // ============= END OF FIXED SECTION =============
          
          // Receipt fee resolved — patch the txFee on the matching whale alert
          if (msg.type === "whale_fee_update" && msg.txHash && msg.txFee) {
            console.log(`💰 Fee update for ${msg.txHash.slice(0,10)}: ${msg.txFee} STT`);
            setAlerts(prev => prev.map(a =>
              a.txHash === msg.txHash ? { ...a, txFee: msg.txFee } : a
            ));
          }
          
          if (msg.type === "explorer_stats" && msg.stats) {
            console.log(`📊 Explorer stats received`, msg.stats);
            setExplorerStats(msg.stats);
          }
          
          if (msg.type === "threshold_update") {
            console.log(`⚙ Threshold update: ${msg.raw?.newValue} STT`);
            setCurrentThreshold(parseFloat(msg.raw?.newValue ?? "0"));
          }
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
      // Clean up the dedup map on unmount
      if (typeof window !== 'undefined') {
        delete window._processedTxMap;
      }
    };
  }, [maxAlerts]);

  // Memoised — avoids filtering 50k entries on every render
  const sttTransfers  = useMemo(() => blockTxs.filter(tx =>  tx.isTransfer), [blockTxs]);
  const contractCalls = useMemo(() => blockTxs.filter(tx => !tx.isTransfer), [blockTxs]);

  return {
    alerts, blockTxs, sttTransfers, contractCalls,
    totalBlockTxsSeen, networkLargestSTT, currentThreshold,
    explorerStats, connected, error,
  };
}