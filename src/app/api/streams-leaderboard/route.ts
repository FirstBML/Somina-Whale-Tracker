import { NextRequest, NextResponse } from "next/server";
import { SDK } from "@somnia-chain/streams";
import { createPublicClient, createWalletClient, http, defineChain, encodeAbiParameters, parseAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
});

export type LeaderboardEntry = {
  wallet:      string;
  totalVolume: string;  // human-readable
  txCount:     number;
  lastSeen:    number;  // ms timestamp
};

function getSDK() {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  return {
    sdk: new SDK({
      public: createPublicClient({ chain: somniaTestnet, transport: http() }),
      wallet: createWalletClient({ account, chain: somniaTestnet, transport: http() }),
    }),
    account,
  };
}

// ── GET: read persisted leaderboard from Data Streams ──────────────────────
export async function GET(req: NextRequest) {
  try {
    const schemaId   = process.env.LEADERBOARD_SCHEMA_ID  as `0x${string}`;
    const publisher  = process.env.LEADERBOARD_PUBLISHER  as `0x${string}`;

    if (!schemaId || !publisher) {
      return NextResponse.json({ entries: [], note: "Streams not configured — LEADERBOARD_SCHEMA_ID or LEADERBOARD_PUBLISHER missing" });
    }

    const { sdk } = getSDK();
    const data = await sdk.streams.getAllPublisherDataForSchema(schemaId, publisher);

    if (!data || data instanceof Error || data.length === 0) {
      return NextResponse.json({ entries: [] });
    }

    // Data Streams returns SchemaDecodedItem[][] — decode each entry
    const entries: LeaderboardEntry[] = (data as any[][]).map((row: any[]) => {
      // Each row is an array of decoded field values matching schema order:
      // address wallet, uint256 totalVolume, uint32 txCount, uint64 lastSeen
      const [wallet, totalVolume, txCount, lastSeen] = row.map((item: any) => item?.value ?? item);
      return {
        wallet:      wallet  as string,
        totalVolume: (BigInt(totalVolume) / BigInt(1e18)).toString(),
        txCount:     Number(txCount),
        lastSeen:    Number(lastSeen) * 1000,
      };
    }).sort((a, b) => Number(b.totalVolume) - Number(a.totalVolume));

    return NextResponse.json({ entries });
  } catch (e: any) {
    console.error("streams GET error:", e);
    return NextResponse.json({ entries: [], error: e.message }, { status: 500 });
  }
}

// ── POST: write/update a wallet's leaderboard entry ───────────────────────
// Called internally from whale-events route on each new whale transfer
export async function POST(req: NextRequest) {
  try {
    const schemaId = process.env.LEADERBOARD_SCHEMA_ID as `0x${string}`;
    if (!schemaId) {
      return NextResponse.json({ success: false, note: "Streams not configured" });
    }

    const body: { wallet: string; totalVolume: bigint | string; txCount: number; lastSeen: number } = await req.json();

    const { sdk } = getSDK();

    // Encode wallet data as ABI bytes matching schema:
    // address wallet, uint256 totalVolume, uint32 txCount, uint64 lastSeen
    const encoded = encodeAbiParameters(
      parseAbiParameters("address, uint256, uint32, uint64"),
      [
        body.wallet as `0x${string}`,
        BigInt(body.totalVolume),
        body.txCount,
        BigInt(Math.floor(body.lastSeen / 1000)),
      ]
    );

    // Use wallet address as the unique data ID (one record per wallet)
    const dataId = body.wallet.toLowerCase().padEnd(66, "0") as `0x${string}`;

    const tx = await sdk.streams.set([
      { id: dataId as `0x${string}`, schemaId, data: encoded },
    ]);

    if (tx instanceof Error) throw tx;

    return NextResponse.json({ success: true, tx });
  } catch (e: any) {
    console.error("streams POST error:", e);
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}