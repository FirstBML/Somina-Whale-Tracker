"use client";
import { useEffect, useRef, useState } from "react";

export type AlertType = "whale" | "reaction" | "alert" | "momentum";

export type WhaleAlert = {
  id:            string;
  type:          AlertType;
  from:          string;
  to:            string;
  amount:        string;
  amountRaw:     bigint;
  timestamp:     number;
  token:         string;
  txHash:        string;
  blockNumber:   string;
  blockHash:     string;
  reactionCount?: string;
  handlerEmitter?: string;
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

export function useWhaleAlerts(maxAlerts = 200) {
  const [alerts, setAlerts]       = useState<WhaleAlert[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError]         = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/whale-events");
    esRef.current = es;

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "init") {
        const parsed = (msg.alerts as any[])
          .map(parseEntry).filter(Boolean).reverse() as WhaleAlert[];
        setAlerts(parsed.slice(0, maxAlerts));
      }
      if (msg.type === "connected") setConnected(true);
      if (msg.type === "error")     setError(msg.message);

      if (["whale", "reaction", "alert", "momentum"].includes(msg.type)) {
        const alert = parseEntry(msg);
        if (alert) setAlerts(prev => [alert, ...prev].slice(0, maxAlerts));
      }
    };

    es.onerror = () => setError("SSE connection lost. Retrying...");
    return () => es.close();
  }, [maxAlerts]);

  return { alerts, connected, error };
}