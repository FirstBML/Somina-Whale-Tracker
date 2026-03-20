import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { EventEmitter } from "events";
const eventHub = new EventEmitter();

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

const POLLING_MS    = 500;
const REPORT_DELAY  = 300;
const MAX_QUEUE     = 50;
const LOG_INTERVAL  = 60_000;
const MAX_BACKFILL = 90_000n;
const WHALE_THRESHOLD_STT = parseEther("1"); // 1 STT threshold

// ============= FIX: Add missing variables =============
let lastBlock      = 0n;
let totalSeen      = 0;
let totalReported  = 0;
let totalSkipped   = 0;
let totalErrors    = 0;
let totalBlockTxsSeen = 0;  // ← ADD THIS LINE
let totalSttTxns    = 0;    // ← ADD THIS LINE for STT transfers count
let nonce          = -1;
let reporting      = false;

// Update the reportQueue type to include timestamp
const reportQueue: { 
  from: `0x${string}`; 
  to: `0x${string}`; 
  val: bigint; 
  stt: number; 
  key: string;
  timestamp: number;  // ← ADD timestamp field
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
        queuedKeys.add(item.key);
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

async function processBlock(
  block: any,
  threshold: bigint,
  CONTRACT: `0x${string}`,
  pub: ReturnType<typeof createPublicClient>,
  wal: ReturnType<typeof createWalletClient>,
  address: `0x${string}`,
) {
  if (!block?.transactions?.length) return;

  // KPI 1: Every single transaction on the network
  totalBlockTxsSeen += block.transactions.length;

  for (const tx of block.transactions as any[]) {
    if (typeof tx !== "object" || !tx.hash) continue;

    const val = tx.value ?? 0n;

    // KPI 2: Only transactions that are moving STT (Value > 0)
    if (val > 0n) {
      totalSttTxns++;  // ← NOW WORKS (variable declared)
    }

    // --- WHALE FILTERING ---
    if (val < threshold) continue;
    if (tx.from?.toLowerCase() === address.toLowerCase()) continue;

    const key = `${tx.from?.toLowerCase()}:${(tx.to ?? "0x0")?.toLowerCase()}:${val.toString()}`;
    if (queuedKeys.has(key)) continue;

    // KPI 3: Whale Event counter
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
      to: (tx.to ?? "0x0000000000000000000000000000000000000000") as `0x${string}`,
      val, 
      stt, 
      key,
      timestamp: Number(block.timestamp) 
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
    console.warn("⚠ Could not fetch on-chain threshold — using 1 STT fallback");
    return parseEther("1");
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
      `  | queue: ${reportQueue.length}` +
      `  | total txs: ${totalBlockTxsSeen}` +  // ← ADDED to stats
      `  | STT txns: ${totalSttTxns}`          // ← ADDED to stats
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
      // processBlock analyzes the block and identifies whales
      await processBlock(r.value, threshold, CONTRACT, pub, wal, address);
      
      // If the count increased, it means a whale was found in this block
      if (totalSeen > prevCount) {
        // We pass r.value (the block) because that is what the 
        // frontend/stream expects to parse for whale events.
        eventHub.emit('whale_event', r.value);
      }
      
      found += (totalSeen - prevCount);
    }

    await new Promise(r => setTimeout(r, 200));
  }

  console.log(`✅ Gap backfill complete — ${found} whale transfers queued from missed blocks`);
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

  console.log(`✅ Ready — watching from block #${lastBlock}\n`);

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
        console.warn(`   Backing off ${Math.round(delay/1000)}s before next poll…`);
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