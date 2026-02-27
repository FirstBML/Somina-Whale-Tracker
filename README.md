# 🐋 Somnia Whale Tracker

Real-time whale transfer dashboard powered by **Somnia Native Reactivity**.  
Built for the [Somnia Reactivity Mini Hackathon](https://dorahacks.io/hackathon/somnia-reactivity).

## How Reactivity is Used

This project uses **Somnia Off-Chain Reactivity** — the `@somnia-chain/reactivity` SDK subscribes to `WhaleTransfer` events emitted by the deployed `WhaleTracker` contract. Instead of polling the RPC every few seconds (traditional approach), Somnia **pushes events to the app via WebSocket** the moment they occur on-chain — zero polling, zero latency.

```
WhaleTracker.sol emits WhaleTransfer
        ↓  (Somnia native push, no polling)
@somnia-chain/reactivity SDK receives event
        ↓
React UI updates instantly
```

## Stack
- **Blockchain**: Somnia Testnet (Chain ID: 50312)
- **Smart Contract**: Solidity 0.8.20 + Hardhat
- **Reactivity**: `@somnia-chain/reactivity` (off-chain WebSocket subscription)
- **Frontend**: Next.js 14 + Tailwind CSS

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.local.example .env.local
# Fill in your PRIVATE_KEY
```

### 3. Get testnet tokens
Join [Somnia Telegram](https://t.me/+XHq0F0JXMyhmMzM0) and request STT test tokens.  
You need **32+ STT** in your wallet for subscriptions.

### 4. Deploy the contract
```bash
npm run deploy:contract
# Copy the printed address into .env.local as NEXT_PUBLIC_CONTRACT_ADDRESS
```

### 5. Run the dashboard
```bash
npm run dev
# Open http://localhost:3000
```

## Triggering Test Whale Alerts
You can simulate whale transfers via Remix or Hardhat:
```solidity
// Call on your deployed WhaleTracker contract
tracker.reportTransfer(fromAddress, toAddress, 50000 * 1e18);
```
The dashboard will update in real time without any page refresh.

## Project Structure
```
somnia-whale-tracker/
├── contracts/
│   └── WhaleTracker.sol
├── scripts/
│   └── deploy.ts
├── src/
│   ├── app/
│   │   └── page.tsx
│   ├── components/
│   │   └── WhaleDashboard.tsx
│   └── lib/
│       ├── reactivity.ts
│       └── useWhaleAlerts.ts
├── .env.local.example
├── hardhat.config.ts
├── package.json
└── README.md
```