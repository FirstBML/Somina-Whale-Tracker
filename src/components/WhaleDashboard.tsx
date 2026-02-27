"use client";
import { useWhaleAlerts } from "../lib/useWhaleAlerts";

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function timeAgo(ts: number) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

export default function WhaleDashboard() {
  const { alerts, connected, error } = useWhaleAlerts();

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6 font-mono">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold text-blue-400">🐋 Whale Tracker</h1>
            <p className="text-gray-400 text-sm mt-1">Powered by Somnia Reactivity</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${connected ? "bg-green-400 animate-pulse" : "bg-red-400"}`} />
            <span className="text-sm text-gray-400">{connected ? "Live" : "Connecting..."}</span>
          </div>
        </div>

        {error && (
          <div className="bg-red-900/40 border border-red-600 rounded p-3 mb-6 text-red-300 text-sm">
            ⚠️ {error}
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { label: "Total Alerts", value: alerts.length },
            { label: "Last 5min", value: alerts.filter(a => Date.now() - a.timestamp < 300_000).length },
            { label: "Largest (tokens)", value: alerts[0]?.amount ?? "—" },
          ].map(({ label, value }) => (
            <div key={label} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <p className="text-gray-400 text-xs uppercase tracking-wider">{label}</p>
              <p className="text-xl font-bold text-white mt-1">{value}</p>
            </div>
          ))}
        </div>

        {/* Alert Feed */}
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-800 flex items-center gap-2">
            <span className="text-sm text-gray-400">Live Feed</span>
            {connected && (
              <span className="text-xs bg-green-900 text-green-400 px-2 py-0.5 rounded-full">● LIVE</span>
            )}
          </div>

          {alerts.length === 0 ? (
            <div className="p-8 text-center text-gray-500 text-sm">
              Waiting for whale activity...
            </div>
          ) : (
            <div className="divide-y divide-gray-800">
              {alerts.map((alert) => (
                <div key={alert.id} className="px-4 py-3 flex items-center justify-between hover:bg-gray-800/50 transition-colors">
                  <div className="flex items-center gap-4">
                    <span className="text-blue-400 font-bold">{alert.amount} tokens</span>
                    <span className="text-gray-500 text-sm">
                      {shortAddr(alert.from)} → {shortAddr(alert.to)}
                    </span>
                  </div>
                  <span className="text-gray-500 text-xs">{timeAgo(alert.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}