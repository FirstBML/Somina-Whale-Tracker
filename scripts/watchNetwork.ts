import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import {
  createPublicClient, createWalletClient, http, defineChain, parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
});

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

const POLLING_MS   = 500;
const REPORT_DELAY = 500;   // ms between submissions
const MAX_QUEUE    = 50;
const LOG_INTERVAL = 60_000;
const MAX_BACKFILL = 90_000n;

// ── FIX 1: Checkpoint granularity inside backfillGap ─────────────────────────
// Save progress every CHECKPOINT_EVERY blocks during backfill so a crash/stop
// never loses more than that many blocks. Previously saveLastBlock() was only
// called after the entire backfill finished — which never happened because nonce
// errors crashed it first, causing the permanent "Resuming from #336304780" loop.
const CHECKPOINT_EVERY = 500n;    // save to disk every 500 blocks
const CHECKPOINT_LOG   = 10_000n; // only print a log line every 10,000 blocks

let lastBlock     = 0n;
let totalSeen     = 0;
let totalReported = 0;
let totalSkipped  = 0;
let totalErrors   = 0;
let nonce         = -1;
let reporting     = false;

const reportQueue: {
  from: `0x${string}`;
  to:   `0x${string}`;
  val:  bigint;
  stt:  number;
  key:  string;
}[] = [];
const queuedKeys = new Set<string>();

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

async function getNextNonce(pub: ReturnType<typeof createPublicClient>, address: `0x${string}`): Promise<number> {
  if (nonce === -1) {
    nonce = await pub.getTransactionCount({ address, blockTag: "pending" });
    console.log(`📌 Initial nonce: ${nonce}`);
  }
  return nonce++;
}

async function resetNonce(pub: ReturnType<typeof createPublicClient>, address: `0x${string}`) {
  // Wait 1s before re-reading nonce — gives the RPC time to propagate the last tx
  await new Promise(r => setTimeout(r, 1_000));
  nonce = await pub.getTransactionCount({ address, blockTag: "pending" });
  console.log(`🔄 Nonce reset to: ${nonce}`);
}

async function processQueue(
  CONTRACT: `0x${string}`,
  pub: ReturnType<typeof createPublicClient>,
  wal: ReturnType<typeof createWalletClient>,
  address: `0x${string}`,
) {
  if (reporting || reportQueue.length === 0) return;
  reporting = true;

  let nonceResetAttempts = 0;

  while (reportQueue.length > 0) {
    const item = reportQueue.shift()!;
    queuedKeys.delete(item.key);

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
      nonceResetAttempts = 0; // reset backoff on success
      console.log(
        `🐋 Whale reported: ${item.stt.toFixed(4)} STT` +
        `  ${item.from.slice(0, 8)}→${item.to.slice(0, 8)}` +
        `  nonce:${txNonce}  tx:${hash.slice(0, 10)}`
      );
    } catch (e: any) {
      totalErrors++;
      const msg = e?.shortMessage ?? e?.message ?? "";

      if (msg.includes("nonce") || msg.includes("replacement")) {
        nonceResetAttempts++;
        // Exponential backoff: 1s, 2s, 4s … capped at 8s
        const backoff = Math.min(1_000 * Math.pow(2, nonceResetAttempts - 1), 8_000);
        console.warn(`⚠ Nonce error (attempt ${nonceResetAttempts}) — backing off ${Math.round(backoff/1000)}s then resetting`);
        queuedKeys.add(item.key);
        reportQueue.unshift(item);
        await new Promise(r => setTimeout(r, backoff));
        await resetNonce(pub, address);
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

    const key = `${tx.from?.toLowerCase()}:${(tx.to ?? "0x0")?.toLowerCase()}:${val.toString()}`;
    if (queuedKeys.has(key)) continue;

    const stt = Number(val) / 1e18;
    totalSeen++;

    if (reportQueue.length >= MAX_QUEUE) {
      console.warn(`⚠ Report queue full — dropping oldest`);
      const dropped = reportQueue.shift()!;
      queuedKeys.delete(dropped.key);
    }

    queuedKeys.add(key);
    reportQueue.push({
      from: tx.from as `0x${string}`,
      to:   (tx.to ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
      val, stt, key,
    });
  }

  processQueue(CONTRACT, pub, wal, address).catch(e =>
    console.error("Queue processor error:", e?.message?.split("\n")[0])
  );
}

async function fetchThreshold(pub: ReturnType<typeof createPublicClient>, CONTRACT: `0x${string}`): Promise<bigint> {
  try {
    return await pub.readContract({ address: CONTRACT, abi: TRACKER_ABI, functionName: "threshold" }) as bigint;
  } catch {
    console.warn("⚠ Could not fetch on-chain threshold — using 0.5 STT fallback");
    return parseEther("0.5");
  }
}

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
  let blocksSinceCheckpoint = 0n; // ← FIX 1 counter

  while (cursor < toBlock) {
    const end = cursor + BATCH < toBlock ? cursor + BATCH : toBlock;
    const blockNums: bigint[] = [];
    for (let n = cursor; n < end; n++) blockNums.push(n);
    cursor = end;

    const results = await Promise.allSettled(
      blockNums.map(n => pub.getBlock({ blockNumber: n, includeTransactions: true }))
    );

    // ── FIX 2: Collect ALL whale txns from this batch into the queue first ──
    // The original code called processBlock() for each block result, and
    // processBlock() called processQueue() at its end — meaning up to 50
    // concurrent processQueue() calls raced past the `reporting = false` guard
    // before the first one could set it to true. This caused parallel tx
    // submissions with duplicate nonces. Now we inline the enqueue logic here
    // and call processQueue() exactly ONCE after the full batch is collected.
    for (const r of results) {
      if (r.status !== "fulfilled" || !r.value?.transactions?.length) continue;
      const block = r.value;
      for (const tx of block.transactions as any[]) {
        if (typeof tx !== "object" || !tx.hash) continue;
        const val = tx.value ?? 0n;
        if (val < threshold) continue;
        if (tx.from?.toLowerCase() === address.toLowerCase()) continue;
        const key = `${tx.from?.toLowerCase()}:${(tx.to ?? "0x0")?.toLowerCase()}:${val.toString()}`;
        if (queuedKeys.has(key)) continue;
        const stt = Number(val) / 1e18;
        totalSeen++;
        found++;
        if (reportQueue.length >= MAX_QUEUE) {
          console.warn(`⚠ Report queue full — dropping oldest`);
          const dropped = reportQueue.shift()!;
          queuedKeys.delete(dropped.key);
        }
        queuedKeys.add(key);
        reportQueue.push({
          from: tx.from as `0x${string}`,
          to:   (tx.to ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
          val, stt, key,
        });
      }
    }

    // ── FIX 2: Single awaited processQueue call per batch ────────────────────
    // Runs serially to completion — all nonces sequential, no collisions.
    await processQueue(CONTRACT, pub, wal, address);

    // ── FIX 1: Checkpoint inside the backfill loop ────────────────────────────
    // Update lastBlock and save to disk every CHECKPOINT_EVERY blocks so a crash
    // or Ctrl+C resumes from here rather than restarting the full 90k gap.
    lastBlock = cursor;
    blocksSinceCheckpoint += BATCH;
    if (blocksSinceCheckpoint >= CHECKPOINT_EVERY) {
      saveLastBlock();
      // Only print a log line every CHECKPOINT_LOG blocks to avoid terminal spam
      if (blocksSinceCheckpoint >= CHECKPOINT_LOG) {
        console.log(`💾 Checkpoint saved at block #${lastBlock} (${found} whales queued so far)`);
        blocksSinceCheckpoint = 0n;
      }
    }

    await new Promise(r => setTimeout(r, 200));
  }

  // Final save after backfill completes
  lastBlock = toBlock;
  saveLastBlock();
  console.log(`✅ Gap backfill complete — ${found} whale transfers queued`);
}

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

  const savedBlock = loadLastBlock();
  const chainHead  = await pub.getBlockNumber();

  if (savedBlock > 0n && savedBlock < chainHead) {
    lastBlock = savedBlock;
    await backfillGap(savedBlock, chainHead, threshold, CONTRACT, pub, wal, account.address);
    lastBlock = chainHead;
  } else {
    lastBlock = chainHead;
  }

  saveLastBlock();
  console.log(`✅ Ready — watching from block #${lastBlock}\n`);

  // Save progress every 30s during live watching
  setInterval(saveLastBlock, 30_000);
  startStatsLogger();

  let rpcErrorCount = 0;

  pub.watchBlocks({
    includeTransactions: true,
    pollingInterval: POLLING_MS,
    onBlock: async (block) => {
      rpcErrorCount = 0;
      if (!block.number || block.number <= lastBlock) return;
      lastBlock = block.number;
      await processBlock(block, threshold, CONTRACT, pub, wal, account.address);
    },
    onError: async (e) => {
      rpcErrorCount++;
      const delay = Math.min(2000 * Math.pow(2, rpcErrorCount - 1), 30_000);
      console.error(`⚠ Block watcher error (attempt ${rpcErrorCount}): ${e.message?.split("\n")[0]}`);
      if (rpcErrorCount > 1) {
        console.warn(`   Backing off ${Math.round(delay/1000)}s...`);
        await new Promise(r => setTimeout(r, delay));
      }
    },
  });

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