import { config } from "dotenv";
config({ path: ".env.local" });
import { SDK } from "@somnia-chain/streams";
import { createPublicClient, createWalletClient, http, zeroHash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
});

// Schema: wallet address | total volume (uint256) | tx count (uint32) | last seen (uint64)
export const LEADERBOARD_SCHEMA = "address wallet, uint256 totalVolume, uint32 txCount, uint64 lastSeen";
export const LEADERBOARD_SCHEMA_NAME = "whale-leaderboard-v1";

async function main() {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const sdk = new SDK({
    public: createPublicClient({ chain: somniaTestnet, transport: http() }),
    wallet: createWalletClient({ account, chain: somniaTestnet, transport: http() }),
  });

  console.log("Registering leaderboard schema...");
  const tx = await sdk.streams.registerDataSchemas([
    {
      schemaName: LEADERBOARD_SCHEMA_NAME,
      schema: LEADERBOARD_SCHEMA,
      parentSchemaId: zeroHash,
    },
  ], true); // true = ignore if already registered

  if (tx instanceof Error) {
    console.error("❌ Schema registration failed:", tx.message);
    process.exit(1);
  }

  console.log("✅ Schema registered! TX:", tx);

  // Compute and log the schemaId for use in env
  const schemaId = await sdk.streams.computeSchemaId(LEADERBOARD_SCHEMA);
  console.log("\n📋 Add to .env.local:");
  console.log(`LEADERBOARD_SCHEMA_ID=${schemaId}`);
  console.log(`LEADERBOARD_PUBLISHER=${account.address}`);
}

main().catch(e => { console.error(e); process.exit(1); });