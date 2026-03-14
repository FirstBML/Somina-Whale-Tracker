import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
  createPublicClient, createWalletClient, http, defineChain, parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

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
const POLLING_MS    = 500;      // poll every 500ms
const REPORT_DELAY  = 300;      // ms between reportTransfer calls
const MAX_QUEUE     = 50;       // max pending transfers to report at once
const LOG_INTERVAL  = 60_000;   // print stats every 60s
// FIX 3 — gap backfill: max blocks to scan on restart (3h at 10 blocks/s)
// Covers typical overnight RPC outages without taking too long to catch up.
const MAX_BACKFILL = 36_000n;

// ── State ─────────────────────────────────────────────────────────────────────
let lastBlock      = 0n;
let totalSeen      = 0;
let totalReported  = 0;
let totalSkipped   = 0;
let totalErrors    = 0;
let nonce          = -1;
let reporting      = false;
const reportQueue: { from: `0x${string}`; to: `0x${string}`; val: bigint; stt: number }[] = [];

// ── FIX 1 — lastBlock persistence ────────────────────────────────────────────
// Saves lastBlock to disk every 30s and on SIGINT/SIGTERM.
// On startup, resumes from the saved block instead of always starting from head,
// so any gap caused by crashes or restarts gets backfilled automatically.
const LAST_BLOCK_FILE = join(process.cwd(), ".watchnetwork-lastblock.json");

function loadLastBlock(): bigint {
  try {
    if (!existsSync(LAST_BLOCK_FILE)) return 0n;
    const raw = JSON.parse(readFileSync(LAST_BLOCK_FILE, "utf8"));
    const n = BigInt(raw.lastBlock ?? 0);
    if (n > 0n) console.log(`📂 Resuming from saved block #${n}`);
    return n;
  } catch { return 0n; }
}

function saveLastBlock() {
  try { writeFileSync(LAST_BLOCK_FILE, JSON.stringify({ lastBlock: lastBlock.toString() })); }
  catch {}
}

// ── Clients ───────────────────────────────────────────────────────────────────
function makeClients() {
  const CONTRACT    = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;
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
        reportQueue.unshift(item);
        await resetNonce(pub, address);
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      if (msg.includes("Below whale threshold") || msg.includes("below threshold")) {
        totalSkipped++;
      } else {
        console.error(`❌ reportTransfer failed: ${msg.split("\n")[0]}`);
      }
    }

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
    if (val < threshold) continue;
    if (tx.from?.toLowerCase() === address.toLowerCase()) continue;

    const stt = Number(val) / 1e18;
    totalSeen++;

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

// ── FIX 2 — Gap backfill ──────────────────────────────────────────────────────
// When we resume from a saved lastBlock, scan the gap and report any missed
// whale transfers. Capped at MAX_BACKFILL blocks to bound startup time.
// At BATCH=50 blocks and 200ms delay: 108k blocks ≈ ~7 minutes to scan.
async function backfillGap(
  fromBlock: bigint,
  toBlock: bigint,
  threshold: bigint,
  CONTRACT: `0x${string}`,
  pub: ReturnType<typeof createPublicClient>,
  wal: ReturnType<typeof createWalletClient>,
  address: `0x${string}`,
) {
  const gap = toBlock - fromBlock;
  if (gap <= 0n) return;

  const capped = gap > MAX_BACKFILL ? MAX_BACKFILL : gap;
  const startBlock = toBlock - capped;
  console.log(`🔍 Backfilling gap: blocks #${startBlock} → #${toBlock} (${capped.toLocaleString()} blocks)`);

  const BATCH = 50n;
  let cursor = startBlock;
  let found = 0;

  while (cursor < toBlock) {
    const end = cursor + BATCH < toBlock ? cursor + BATCH : toBlock;
    const blockNums: bigint[] = [];
    for (let n = cursor; n < end; n++) blockNums.push(n);
    cursor = end;

    const results = await Promise.allSettled(
      blockNums.map(n => pub.getBlock({ blockNumber: n, includeTransactions: true }))
    );

    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value?.transactions?.length) continue;
      const prevCount = totalSeen;
      await processBlock(r.value, threshold, CONTRACT, pub, wal, address);
      found += totalSeen - prevCount;
    }

    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`✅ Gap backfill complete — ${found} whale transfers queued from missed blocks`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("🐋 Somnia watchNetwork.ts starting...");
  console.log("   Chain:   Somnia Testnet (50312)");
  console.log("   RPC:     https://dream-rpc.somnia.network");

  const { CONTRACT, account, pub, wal } = makeClients();
  console.log(`   Wallet:  ${account.address}`);
  console.log(`   Contract: ${CONTRACT}`);

  let threshold = await fetchThreshold(pub, CONTRACT);
  console.log(`   Threshold: ${Number(threshold) / 1e18} STT`);

  setInterval(async () => {
    const t = await fetchThreshold(pub, CONTRACT);
    if (t !== threshold) {
      console.log(`⚙ Threshold updated: ${Number(threshold)/1e18} → ${Number(t)/1e18} STT`);
      threshold = t;
    }
  }, 5 * 60_000);

  // FIX 1: load saved lastBlock; if none, start from chain head
  const savedBlock = loadLastBlock();
  const chainHead  = await pub.getBlockNumber();

  if (savedBlock > 0n && savedBlock < chainHead) {
    lastBlock = savedBlock;
    // FIX 2: backfill gap between saved block and current head
    await backfillGap(savedBlock, chainHead, threshold, CONTRACT, pub, wal, account.address);
    lastBlock = chainHead;
  } else {
    lastBlock = chainHead;
  }

  console.log(`✅ Ready — watching from block #${lastBlock}\n`);

  // Save lastBlock to disk every 30s
  setInterval(saveLastBlock, 30_000);

  startStatsLogger();

  // ── FIX 3 — RPC retry with exponential backoff ────────────────────────────
  // viem's onError fires on every failed poll but auto-retries immediately.
  // We track consecutive errors and add a delay so a flaky RPC doesn't spam
  // the logs and allows the network time to recover before hammering it again.
  let rpcErrorCount = 0;

  pub.watchBlocks({
    includeTransactions: true,
    pollingInterval: POLLING_MS,
    onBlock: async (block) => {
      rpcErrorCount = 0; // reset on successful delivery
      if (!block.number || block.number <= lastBlock) return;
      lastBlock = block.number;
      await processBlock(block, threshold, CONTRACT, pub, wal, account.address);
    },
    onError: async (e) => {
      rpcErrorCount++;
      // Backoff: 2s → 4s → 8s → 16s → cap at 30s
      const delay = Math.min(2000 * Math.pow(2, rpcErrorCount - 1), 30_000);
      console.error(`⚠ Block watcher error (attempt ${rpcErrorCount}): ${e.message?.split("\n")[0]}`);
      if (rpcErrorCount > 1) {
        console.warn(`   Backing off ${Math.round(delay/1000)}s before next poll…`);
        await new Promise(r => setTimeout(r, delay));
      }
    },
  });

  // Save on clean exit so next start resumes exactly where we left off
  const shutdown = () => {
    saveLastBlock();
    console.log(`\n👋 watchNetwork stopped at block #${lastBlock}.`);
    process.exit(0);
  };
  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(e => {
  console.error("Fatal:", e?.message ?? e);
  process.exit(1);
});