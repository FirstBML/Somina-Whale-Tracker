"use client";
import { useEffect, useRef, useState } from "react";

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
};

export type BlockTx = {
  id:          string;
  from:        string;
  to:          string;
  amount:      string;
  amountRaw:   number;
  txHash:      string;
  blockNumber: string;
  timestamp:   number;
};

function parseEntry(raw: any): WhaleAlert | null {
  try {
    const r    = raw?.raw ?? raw;
    const type = (raw?.type ?? "whale") as AlertType;

    if (type === "alert" || type === "momentum") {
      return {
        id:            `${Date.now()}-${Math.random()}`,
        type,
        from:          "",
        to:            "",
        amount:        "0",
        amountRaw:     0n,
        timestamp:     Number(BigInt(r.timestamp ?? "0x0")) * 1000 || Date.now(),
        token:         "",
        txHash:        r.txHash      ?? "",
        blockNumber:   r.blockNumber ?? "",
        blockHash:     r.blockHash   ?? "",
        reactionCount: r.reactionCount,
      };
    }

    const amountHex = r?.amount    ?? "0x0";
    const tsHex     = r?.timestamp ?? "0x0";
    const amount    = BigInt(amountHex);
    const timestamp = BigInt(tsHex);

    return {
      id:             `${Date.now()}-${Math.random()}`,
      type,
      from:           r.from  ?? "",
      to:             r.to    ?? "",
      amountRaw:      amount,
      amount:         (Number(amount) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 }),
      timestamp:      Number(timestamp) * 1000 || Date.now(),
      token:          r.token ?? "",
      txHash:         r.txHash      ?? "",
      blockNumber:    r.blockNumber ?? "",
      blockHash:      r.blockHash   ?? "",
      reactionCount:  r.reactionCount,
      handlerEmitter: r.handlerEmitter,
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
    return {
      id:          `btx-${Date.now()}-${Math.random()}`,
      from:        r.from        ?? "",
      to:          r.to          ?? "",
      amount:      amountRaw.toLocaleString(),
      amountRaw,
      txHash:      r.txHash      ?? "",
      blockNumber: r.blockNumber ?? "",
      timestamp:   Date.now(),
    };
  } catch {
    return null;
  }
}

export function useWhaleAlerts(maxAlerts = 200) {
  const [alerts,    setAlerts]    = useState<WhaleAlert[]>([]);
  const [blockTxs,  setBlockTxs]  = useState<BlockTx[]>([]);
  const [totalBlockTxsSeen, setTotalBlockTxsSeen] = useState(0);
  const [networkLargestSTT,  setNetworkLargestSTT]  = useState(0);
  const [connected, setConnected] = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/whale-events");
    esRef.current = es;

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "init") {
        const allEntries = msg.alerts as any[];
        const whaleParsed = allEntries
          .filter(a => a.type !== "block_tx")
          .map(parseEntry).filter(Boolean).reverse() as WhaleAlert[];
        const blockParsed = allEntries
          .filter(a => a.type === "block_tx")
          .map(parseBlockTx).filter(Boolean).reverse() as BlockTx[];
        setAlerts(whaleParsed.slice(0, maxAlerts));
        setBlockTxs(blockParsed.slice(0, 500));
        if (msg.totalBlockTxsSeen) setTotalBlockTxsSeen(msg.totalBlockTxsSeen);
        if (msg.networkLargestSTT) setNetworkLargestSTT(msg.networkLargestSTT);
      }
      if (msg.type === "connected") setConnected(true);
      if (msg.type === "error")     setError(msg.message);

      if (["whale", "reaction", "alert", "momentum"].includes(msg.type)) {
        const alert = parseEntry(msg);
        if (alert) setAlerts(prev => [alert, ...prev].slice(0, maxAlerts));
      }
      if (msg.type === "block_tx") {
        const tx = parseBlockTx(msg);
        if (tx) setBlockTxs(prev => [tx, ...prev].slice(0, 500));
        if (msg.totalBlockTxsSeen) setTotalBlockTxsSeen(msg.totalBlockTxsSeen);
        if (msg.networkLargestSTT) setNetworkLargestSTT(msg.networkLargestSTT);
      }
    };

    es.onerror = () => setError("SSE connection lost. Retrying...");
    return () => es.close();
  }, [maxAlerts]);

  return { alerts, blockTxs, totalBlockTxsSeen, networkLargestSTT, connected, error };
}