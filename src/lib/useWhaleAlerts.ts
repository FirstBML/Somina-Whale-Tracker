"use client";
import { useEffect, useRef, useState } from "react";

export type WhaleAlert = {
  id: string;
  from: string;
  to: string;
  amount: string;
  timestamp: number;
};

function parseRaw(raw: any): WhaleAlert | null {
  try {
    const result = raw?.result ?? raw;
    const topics = result?.topics;
    const rawData = result?.data;
    if (!topics || topics.length < 3 || !rawData) return null;

    const from = `0x${topics[1]?.slice(26)}`;
    const to   = `0x${topics[2]?.slice(26)}`;
    const amount    = BigInt(`0x${rawData.slice(2, 66)}`);
    const timestamp = BigInt(`0x${rawData.slice(66, 130)}`);

    return {
      id: `${Date.now()}-${Math.random()}`,
      from,
      to,
      amount: (Number(amount) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 }),
      timestamp: Number(timestamp) * 1000,
    };
  } catch { return null; }
}

export function useWhaleAlerts(maxAlerts = 50) {
  const [alerts, setAlerts] = useState<WhaleAlert[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/whale-events");
    esRef.current = es;

    es.onmessage = (e) => {
      const msg = JSON.parse(e.data);

      if (msg.type === "init") {
        // Load cached alerts from server
        const parsed = msg.alerts
          .map((a: any) => parseRaw(a.raw))
          .filter(Boolean)
          .reverse() as WhaleAlert[];
        setAlerts(parsed.slice(0, maxAlerts));
      }

      if (msg.type === "connected") setConnected(true);
      if (msg.type === "error") setError(msg.message);

      if (msg.type === "whale") {
        const alert = parseRaw(msg.raw);
        if (alert) setAlerts(prev => [alert, ...prev].slice(0, maxAlerts));
      }
    };

    es.onerror = () => setError("SSE connection lost. Retrying...");
    return () => es.close();
  }, [maxAlerts]);

  return { alerts, connected, error };
}