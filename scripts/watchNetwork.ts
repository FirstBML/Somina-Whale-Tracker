/**
 * watchNetwork.ts — Standalone Somnia Network Watcher
 *
 * Runs independently of Next.js. Monitors every block for native STT transfers
 * >= threshold and calls WhaleTracker.reportTransfer(), feeding the full
 * Reactivity Engine pipeline:
 *
 *   Real STT transfer
 *     ↓
 *   watchNetwork.ts detects it (block polling, 500ms)
 *     ↓
 *   reportTransfer(from, to, amount, "STT")
 *     ↓
 *   WhaleTracker emits WhaleTransfer
 *     ↓
 *   Somnia Reactivity Engine → WhaleHandler._onEvent()
 *     ↓
 *   ReactedToWhaleTransfer / AlertThresholdCrossed / WhaleMomentumDetected
 *     ↓
 *   Frontend SSE dashboard
 *
 * Run:
 *   npx tsx scripts/watchNetwork.ts
 *
 * Keep running alongside npm run dev in a separate terminal.
 * Uses its own nonce tracking so it never conflicts with the Next.js server.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
  createPublicClient, createWalletClient, http, defineChain, parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ── Chain ─────────────────────────────────────────────────────────────────────
const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
});

// ── Contract ABI ──────────────────────────────────────────────────────────────
const TRACKER_ABI = [
  {
    name: "reportTransfer", type: "function", stateMutability: "nonpayable",
    inputs: [
      { name: "from",   type: "address" },
      { name: "to",     type: "address" },
      { name: "amount", type: "uint256" },
      { name: "token",  type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "threshold", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ── Config ────────────────────────────────────────────────────────────────────
const POLLING_MS   = 500;    // poll every 500ms — catch most blocks at 0.1s block time
const REPORT_DELAY = 300;    // ms between reportTransfer calls — prevents nonce collisions
const MAX_QUEUE    = 50;     // max pending transfers to report at once
const LOG_INTERVAL = 60_000; // print stats every 60s

// ── State ─────────────────────────────────────────────────────────────────────
let lastBlock      = 0n;
let totalSeen      = 0;
let totalReported  = 0;
let totalSkipped   = 0;
let totalErrors    = 0;
let nonce          = -1;     // -1 = uninitialized, fetched fresh on first use
let reporting      = false;
const reportQueue: { from: `0x${string}`; to: `0x${string}`; val: bigint; stt: number }[] = [];

// ── Clients ───────────────────────────────────────────────────────────────────
function makeClients() {
  const CONTRACT = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;
  const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}`;

  if (!CONTRACT || !PRIVATE_KEY) {
    console.error("❌ Missing NEXT_PUBLIC_CONTRACT_ADDRESS or PRIVATE_KEY in .env.local");
    process.exit(1);
  }

  const account = privateKeyToAccount(PRIVATE_KEY);
  const pub = createPublicClient({ chain: somniaTestnet, transport: http() });
  const wal = createWalletClient({ account, chain: somniaTestnet, transport: http() });

  return { CONTRACT, account, pub, wal };
}

// ── Nonce management ──────────────────────────────────────────────────────────
async function getNextNonce(pub: ReturnType<typeof createPublicClient>, address: `0x${string}`): Promise<number> {
  if (nonce === -1) {
    // Fetch from chain on first use or after error
    nonce = await pub.getTransactionCount({ address, blockTag: "pending" });
    console.log(`📌 Initial nonce: ${nonce}`);
  }
  return nonce++;
}

async function resetNonce(pub: ReturnType<typeof createPublicClient>, address: `0x${string}`) {
  nonce = await pub.getTransactionCount({ address, blockTag: "pending" });
  console.log(`🔄 Nonce reset to: ${nonce}`);
}

// ── Report queue processor ────────────────────────────────────────────────────
async function processQueue(
  CONTRACT: `0x${string}`,
  pub: ReturnType<typeof createPublicClient>,
  wal: ReturnType<typeof createWalletClient>,
  address: `0x${string}`,
) {
  if (reporting || reportQueue.length === 0) return;
  reporting = true;

  while (reportQueue.length > 0) {
    const item = reportQueue.shift()!;
    try {
      const txNonce = await getNextNonce(pub, address);
      const hash = await wal.writeContract({
        address: CONTRACT,
        abi: TRACKER_ABI,
        functionName: "reportTransfer",
        args: [item.from, item.to, item.val, "STT"],
        chain: somniaTestnet,
        account: wal.account!,
        nonce: txNonce,
      });
      totalReported++;
      console.log(
        `🐋 Whale reported: ${item.stt.toFixed(4)} STT` +
        `  ${item.from.slice(0, 8)}→${item.to.slice(0, 8)}` +
        `  nonce:${txNonce}  tx:${hash.slice(0, 10)}`
      );
    } catch (e: any) {
      totalErrors++;
      const msg = e?.shortMessage ?? e?.message ?? "";

      if (msg.includes("nonce") || msg.includes("replacement")) {
        console.warn(`⚠ Nonce error — resetting and requeueing`);
        reportQueue.unshift(item); // put back at front
        await resetNonce(pub, address);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      if (msg.includes("Below whale threshold") || msg.includes("below threshold")) {
        totalSkipped++;
        // Silently drop — transfer fell below on-chain threshold
      } else {
        console.error(`❌ reportTransfer failed: ${msg.split("\n")[0]}`);
      }
    }

    // Small delay between reports to avoid flooding the mempool
    if (reportQueue.length > 0) {
      await new Promise(r => setTimeout(r, REPORT_DELAY));
    }
  }

  reporting = false;
}

// ── Block processor ───────────────────────────────────────────────────────────
async function processBlock(
  block: any,
  threshold: bigint,
  CONTRACT: `0x${string}`,
  pub: ReturnType<typeof createPublicClient>,
  wal: ReturnType<typeof createWalletClient>,
  address: `0x${string}`,
) {
  if (!block?.transactions?.length) return;

  for (const tx of block.transactions as any[]) {
    if (typeof tx !== "object" || !tx.hash) continue;

    const val = tx.value ?? 0n;
    if (val < threshold) continue;                  // below threshold — skip
    if (tx.from?.toLowerCase() === address.toLowerCase()) continue; // skip our own txs

    const stt = Number(val) / 1e18;
    totalSeen++;

    // Don't let queue grow unbounded
    if (reportQueue.length >= MAX_QUEUE) {
      console.warn(`⚠ Report queue full (${MAX_QUEUE}) — dropping oldest`);
      reportQueue.shift();
    }

    reportQueue.push({
      from: tx.from as `0x${string}`,
      to:   (tx.to ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
      val,
      stt,
    });
  }

  // Drain queue (non-blocking — fires and continues)
  processQueue(CONTRACT, pub, wal, address).catch(e =>
    console.error("Queue processor error:", e?.message?.split("\n")[0])
  );
}

// ── Threshold fetcher ─────────────────────────────────────────────────────────
async function fetchThreshold(pub: ReturnType<typeof createPublicClient>, CONTRACT: `0x${string}`): Promise<bigint> {
  try {
    return await pub.readContract({ address: CONTRACT, abi: TRACKER_ABI, functionName: "threshold" }) as bigint;
  } catch {
    console.warn("⚠ Could not fetch on-chain threshold — using 1 STT fallback");
    return parseEther("1");
  }
}

// ── Stats logger ──────────────────────────────────────────────────────────────
function startStatsLogger() {
  setInterval(() => {
    console.log(
      `📊 Stats — blocks processed up to #${lastBlock}` +
      `  | seen: ${totalSeen}` +
      `  | reported: ${totalReported}` +
      `  | skipped: ${totalSkipped}` +
      `  | errors: ${totalErrors}` +
      `  | queue: ${reportQueue.length}`
    );
  }, LOG_INTERVAL);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🐋 Somnia watchNetwork.ts starting...");
  console.log("   Chain:   Somnia Testnet (50312)");
  console.log("   RPC:     https://dream-rpc.somnia.network");

  const { CONTRACT, account, pub, wal } = makeClients();
  console.log(`   Wallet:  ${account.address}`);
  console.log(`   Contract: ${CONTRACT}`);

  // Fetch on-chain threshold so watcher stays in sync with any setThreshold() calls
  let threshold = await fetchThreshold(pub, CONTRACT);
  console.log(`   Threshold: ${Number(threshold) / 1e18} STT`);

  // Refresh threshold every 5 min in case owner calls setThreshold()
  setInterval(async () => {
    const t = await fetchThreshold(pub, CONTRACT);
    if (t !== threshold) {
      console.log(`⚙ Threshold updated: ${Number(threshold)/1e18} → ${Number(t)/1e18} STT`);
      threshold = t;
    }
  }, 5 * 60_000);

  // Prime lastBlock so we don't reprocess old blocks on startup
  lastBlock = await pub.getBlockNumber();
  console.log(`✅ Ready — watching from block #${lastBlock}\n`);

  startStatsLogger();

  // ── Block watcher loop ───────────────────────────────────────────────────
  // Uses HTTP polling at 500ms — reliable full-block delivery vs WebSocket
  // watchBlocks which returns headers only and requires a second fetch.
  pub.watchBlocks({
    includeTransactions: true,
    pollingInterval: POLLING_MS,
    onBlock: async (block) => {
      // Skip already-processed blocks (viem can deliver duplicates)
      if (!block.number || block.number <= lastBlock) return;
      lastBlock = block.number;
      await processBlock(block, threshold, CONTRACT, pub, wal, account.address);
    },
    onError: (e) => {
      console.error("⚠ Block watcher error:", e.message?.split("\n")[0]);
      // viem auto-retries — no manual reconnect needed
    },
  });

  // Keep process alive
  process.on("SIGINT",  () => { console.log("\n👋 watchNetwork stopped."); process.exit(0); });
  process.on("SIGTERM", () => { console.log("\n👋 watchNetwork stopped."); process.exit(0); });
}

main().catch(e => {
  console.error("Fatal:", e?.message ?? e);
  process.exit(1);
});