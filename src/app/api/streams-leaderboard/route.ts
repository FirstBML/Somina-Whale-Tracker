import { NextRequest, NextResponse } from "next/server";
import { SDK } from "@somnia-chain/streams";
import {
  createPublicClient, createWalletClient, http, defineChain,
  encodeAbiParameters, parseAbiParameters,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
});

export type LeaderboardEntry = {
  wallet:      string;
  totalVolume: string;
  txCount:     number;
  lastSeen:    number;
};

// ── Singleton clients — one wallet = one nonce sequence ───────────────────────
let _sdk:    SDK | null = null;
let _pubClient: ReturnType<typeof createPublicClient> | null = null;

function getClients() {
  if (_sdk && _pubClient) return { sdk: _sdk, pub: _pubClient };
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  _pubClient = createPublicClient({ chain: somniaTestnet, transport: http() });
  _sdk = new SDK({
    public: _pubClient as any,
    wallet: createWalletClient({ account, chain: somniaTestnet, transport: http() }),
  });
  return { sdk: _sdk, pub: _pubClient };
}

// ── Serialized write queue with in-flight dedup ───────────────────────────────
type WriteJob = { wallet: string; totalVolume: string; txCount: number; lastSeen: number };

const queue: WriteJob[] = [];
const inFlight = new Set<string>();
let processing = false;

export function enqueue(job: WriteJob) {
  const qi = queue.findIndex(j => j.wallet === job.wallet);
  if (qi !== -1) { queue[qi] = job; return; }
  queue.push(job);
  if (!processing) processQueue();
}

async function processQueue() {
  if (processing || queue.length === 0) return;
  processing = true;
  while (queue.length > 0) {
    const job = queue.shift()!;
    inFlight.add(job.wallet);
    try {
      await writeWithRetry(job);
    } catch (e) {
      console.error("streams final error:", job.wallet.slice(0, 10), e instanceof Error ? e.message.split("\n")[0] : e);
    } finally {
      inFlight.delete(job.wallet);
    }
    await new Promise(r => setTimeout(r, 400));
  }
  processing = false;
}

async function writeWithRetry(job: WriteJob, attempt = 0) {
  try {
    await writeToStreams(job);
  } catch (e: any) {
    const isNonceError = e?.message?.includes("nonce") || e?.details?.includes("nonce");
    if (isNonceError && attempt === 0) {
      console.warn("streams: nonce error, resetting SDK and retrying...");
      _sdk = null;
      _pubClient = null;
      await new Promise(r => setTimeout(r, 600));
      return writeWithRetry(job, 1);
    }
    throw e;
  }
}

async function writeToStreams(job: WriteJob) {
  const schemaId = process.env.LEADERBOARD_SCHEMA_ID as `0x${string}`;
  const { sdk } = getClients();
  const encoded = encodeAbiParameters(
    parseAbiParameters("address, uint256, uint32, uint64"),
    [
      job.wallet as `0x${string}`,
      BigInt(job.totalVolume),
      job.txCount,
      BigInt(Math.floor(job.lastSeen / 1000)),
    ]
  );
  const dataId = (job.wallet.toLowerCase() + "0".repeat(24)) as `0x${string}`;
  const tx = await sdk.streams.set([{ id: dataId, schemaId, data: encoded }]);
  if (tx instanceof Error) throw tx;
  console.log(`✅ Streams: ${job.wallet.slice(0, 10)}… updated`);
}

// Safely unwrap SDK field — may be nested { value, type } objects
function unwrap(x: any): any {
  if (x === null || x === undefined) return x;
  if (typeof x === "object" && "value" in x) return unwrap(x.value);
  return x;
}

function safeBigInt(x: any): bigint {
  try {
    const v = unwrap(x);
    if (v === null || v === undefined) return 0n;
    return BigInt(String(v));
  } catch { return 0n; }
}

// ── GET ───────────────────────────────────────────────────────────────────────
export async function GET(_req: NextRequest) {
  try {
    const schemaId  = process.env.LEADERBOARD_SCHEMA_ID as `0x${string}`;
    const publisher = process.env.LEADERBOARD_PUBLISHER as `0x${string}`;
    if (!schemaId || !publisher) {
      return NextResponse.json({ entries: [], note: "Streams not configured" });
    }

    const { sdk } = getClients();
    const data = await sdk.streams.getAllPublisherDataForSchema(schemaId, publisher);
    if (!data || data instanceof Error || (data as any[]).length === 0) {
      return NextResponse.json({ entries: [] });
    }

    const entries: LeaderboardEntry[] = (data as any[][])
      .map((row: any[]) => {
        const [wallet, totalVolume, txCount, lastSeen] = row.map(unwrap);
        const volRaw = safeBigInt(totalVolume);
        return {
          wallet:      String(unwrap(wallet) ?? ""),
          totalVolume: (volRaw / BigInt(1e18)).toString(),
          txCount:     Number(unwrap(txCount) ?? 0),
          lastSeen:    Number(unwrap(lastSeen) ?? 0) * 1000,
        };
      })
      .filter(e => e.wallet.startsWith("0x"))
      .sort((a, b) => Number(b.totalVolume) - Number(a.totalVolume));

    return NextResponse.json({ entries });
  } catch (e: any) {
    console.error("streams GET error:", e.message);
    return NextResponse.json({ entries: [], error: e.message }, { status: 500 });
  }
}

// ── POST ──────────────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  try {
    if (!process.env.LEADERBOARD_SCHEMA_ID) {
      return NextResponse.json({ success: false, note: "Streams not configured" });
    }
    const body: WriteJob = await req.json();
    enqueue(body);
    return NextResponse.json({ success: true, queued: true });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}