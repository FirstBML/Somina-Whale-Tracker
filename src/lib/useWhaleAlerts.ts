"use client";
import { useEffect, useRef, useState } from "react";

export type WhaleAlert = {
  id: string;
  from: string;
  to: string;
  amount: string;
  timestamp: number;
};

export function useWhaleAlerts(maxAlerts = 50) {
  const [alerts, setAlerts] = useState<WhaleAlert[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const subRef = useRef<{ unsubscribe: () => void } | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        const { subscribeToWhaleTransfers } = await import("./reactivity");
        const sub = await subscribeToWhaleTransfers(
          ({ from, to, amount, timestamp }) => {
            if (cancelled) return;
            const alert: WhaleAlert = {
              id: `${Date.now()}-${Math.random()}`,
              from,
              to,
              amount: (Number(amount) / 1e18).toLocaleString(undefined, { maximumFractionDigits: 2 }),
              timestamp: Number(timestamp) * 1000,
            };
            setAlerts((prev) => [alert, ...prev].slice(0, maxAlerts));
          },
          (e) => setError(String(e))
        );

        if (!cancelled) {
          subRef.current = { unsubscribe: sub.unsubscribe };  // ✅ extract only what we need
          setConnected(true);
        }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }

    connect();
    return () => {
      cancelled = true;
      subRef.current?.unsubscribe();
    };
  }, [maxAlerts]);

  return { alerts, connected, error };
}