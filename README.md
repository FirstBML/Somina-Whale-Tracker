---

```md
# 🐋 Somnia Whale Intelligence System

Real-time, event-driven whale analytics powered by **Somnia Reactivity**.

This project detects large on-chain transfers at block time, derives higher-order signals (momentum, alerts, reactions), and streams them to a live dashboard with **sub-second latency** — without relying on indexers or polling.

It demonstrates how Somnia’s Reactivity layer enables **low-latency, event-driven analytics pipelines directly on blockchain data**.

---

---

## 🧠 Why This Matters

Traditional blockchain analytics systems rely on:
- Polling RPC endpoints
- Indexers (The Graph, custom pipelines)
- Delayed batch processing

This introduces latency and complexity.

### With Somnia Reactivity:
- Smart contracts react instantly to on-chain events
- No polling or indexing required
- Signals are derived **at event time**, not after

👉 This project shows how to build a **real-time intelligence layer on top of raw blockchain activity**

---

## ⚙️ System Architecture

```

watchNetwork.ts → WhaleTracker.sol → Reactivity Engine → WhaleHandler.sol
↓
Next.js API (SSE) → Browser Dashboard
↓
SQLite + Data Streams

````

### Flow

1. `watchNetwork.ts` scans every block  
2. Transfers ≥ threshold trigger `reportTransfer()` on `WhaleTracker.sol`  
3. Contract emits `WhaleTransfer`  
4. **Somnia Reactivity Engine** forwards event instantly to `WhaleHandler.sol`  
5. Backend subscribes via SDK  
6. Events are:
   - Persisted in SQLite  
   - Streamed to frontend via SSE  
7. Frontend updates in real-time  

---

## 🔥 Core Features

### 1. Live Whale Feed

Confirmed whale transactions appear within milliseconds.

**Derived Signals:**

| Badge | Signal | Trigger |
|------|--------|--------|
| 🔥 MOMENTUM | Burst activity | ≥ 3 whale txs from same wallet in 60s |
| 🚨 ALERT | Large transfer | 2× above average whale size |
| ⚡ REACTION | On-chain response | Triggered via Reactivity |

---

### 2. Analytics Engine

- **Shock Score (0–100)** — measures downstream network activity  
- **Whale Concentration** — top wallets dominance  
- **Net Flow Analysis** — accumulation vs distribution  

---

### 3. Leaderboard (Wallet Intelligence)

Wallet influence scoring (0–100) based on:
- Volume  
- Frequency  
- Burst activity  

Classification:
- 🟢 ACCUMULATOR  
- 🔴 DISTRIBUTOR  
- 🟡 MARKET MOVER  

Persisted using **Somnia Data Streams**.

---

### 4. Advanced Filtering

- Time windows: `30m / 1h / 24h`  
- Amount range  
- Wallet address  
- Event type  

All analytics update dynamically.

---

### 5. Simulation Layer (Testing System)

Inject synthetic whale events to test the full pipeline:

Contracts → Reactivity → Backend → UI  

**Simulated events:**
- ❌ Do NOT affect core metrics  
- ✅ DO trigger signals  

---

## 🧱 Hybrid Analytics Architecture

Designed to handle **200,000+ transactions** efficiently.

### Problem
Frontend-heavy analytics causes:
- UI freezing  
- Re-render bottlenecks  

### Solution

| Layer | Responsibility |
|------|----------------|
| Backend | Aggregation + persistence |
| Frontend | Visualization (capped dataset) |

### Optimizations
- Block transactions capped at **5,000 in React state**  
- Full dataset stored in **SQLite**  
- KPIs use **server-side totals**  
- Time updates throttled (5s interval)  

---

## 🛠️ Tech Stack

| Layer | Tech |
|------|------|
| Frontend | Next.js 14, React 18, TypeScript |
| Charts | Recharts |
| Blockchain | Viem, Wagmi, RainbowKit |
| Somnia | @somnia-chain/reactivity, @somnia-chain/streams |
| Backend | Next.js API |
| Database | SQLite (better-sqlite3) |
| Real-time | Server-Sent Events |

---

## ⚡ Setup

### Prerequisites
- Node.js 18+
- npm
- Git

```bash
git clone https://github.com/your-username/somnia-whale-tracker.git
cd somnia-whale-tracker
npm install
````

---

### Environment Variables

Create `.env.local`:

```bash
PRIVATE_KEY=your_private_key_here
NEXT_PUBLIC_CONTRACT_ADDRESS=0x38538663834868bFbE09219d56429E7aA7728404
HANDLER_CONTRACT_ADDRESS=0x...

# Optional
LEADERBOARD_SCHEMA_ID=0x...
LEADERBOARD_PUBLISHER=0x...
```

> ⚠️ Never commit your private key

---

## ▶️ Running the Project

Run in two terminals:

```bash
# Terminal 1 — frontend
npm run dev

# Terminal 2 — ingestion
npx tsx scripts/watchNetwork.ts
```

Open:

```
http://localhost:3000
```

---

## 📂 Project Structure

```
src/
├── app/api/
│   ├── whale-events/
│   ├── network-activity/
│   ├── simulate-whale/
│   ├── streams-leaderboard/
│   └── metrics/
├── components/
│   └── WhaleDashboard.tsx
└── lib/
    ├── analyticsEngine.ts
    ├── useWhaleAlerts.ts
    └── useOraclePrices.ts

scripts/
└── watchNetwork.ts
```

---

## 📜 Smart Contracts

### WhaleTracker.sol

* Emits `WhaleTransfer`

### WhaleHandler.sol

* Triggered via Reactivity
* Emits:

  * ReactedToWhaleTransfer
  * AlertThresholdCrossed
  * WhaleMomentumDetected

---

## 🧠 Architecture Decisions

* SQLite for simplicity and speed
* SSE for real-time streaming
* Hybrid analytics to prevent UI freezing
* Event-driven design (no polling)

---

## 🐛 Troubleshooting

| Problem      | Fix                              |
| ------------ | -------------------------------- |
| SQLite error | `npm rebuild better-sqlite3`     |
| No data      | Ensure watcher script is running |
| UI lag       | Verify state capping             |
| DB issues    | Delete `whales.db` and restart   |

---

## 🧪 Submission Notes

### ✅ Completed

* Real-time whale detection
* Historical data persistence
* Derived signals
* Network activity analytics
* Leaderboard
* Simulation system

---

### ⚠️ Limitations

* SQLite is local-only
* SSE may timeout in some environments

---

### 🚀 Future Improvements

* Move analytics fully backend
* Use scalable DB
* Multi-token support

---

## 🙌 Acknowledgments

Somnia Network
Protofire
DIA

---

Built with 💙 on Somnia Testnet

```

