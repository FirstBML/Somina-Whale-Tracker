import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import "dotenv/config";
import { createPublicClient, createWalletClient, http, parseGwei, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import { SDK } from "@somnia-chain/reactivity";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
});

async function main() {
  const TRACKER = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;
  const HANDLER = process.env.HANDLER_CONTRACT_ADDRESS as `0x${string}`;

  if (!TRACKER || !HANDLER) {
    throw new Error("Missing NEXT_PUBLIC_CONTRACT_ADDRESS or HANDLER_CONTRACT_ADDRESS in .env.local");
  }

  console.log("WhaleTracker:", TRACKER);
  console.log("WhaleHandler:", HANDLER);

  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  console.log("Owner:", account.address);

  const publicClient = createPublicClient({ chain: somniaTestnet, transport: http() });
  const walletClient = createWalletClient({ account, chain: somniaTestnet, transport: http() });
  const sdk = new SDK({ public: publicClient, wallet: walletClient });

  // Topic0 = keccak256 of the updated event signature (with string token)
  const TOPIC = keccak256(toBytes("WhaleTransfer(address,address,uint256,uint256,string)"));
  console.log("\nWhaleTransfer topic0:", TOPIC);

  console.log("\nCreating on-chain Solidity subscription...");
  console.log("This links WhaleTracker events → WhaleHandler._onEvent()");
  console.log("Requires 32+ STT in owner wallet...\n");

  const txHash = await sdk.createSoliditySubscription({
    emitter:              TRACKER,      // only react to events from WhaleTracker
    handlerContractAddress: HANDLER,    // Somnia calls WhaleHandler._onEvent()
    eventTopics:          [TOPIC],      // filter to WhaleTransfer only
    priorityFeePerGas:    parseGwei("2"),
    maxFeePerGas:         parseGwei("10"),
    gasLimit:             500_000n,
    isGuaranteed:         true,         // retry if block is full
    isCoalesced:          false,        // one call per event (not batched)
  });

  if (txHash instanceof Error) {
    console.error("❌ Subscription creation failed:", txHash.message);
    process.exit(1);
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log("✅ Solidity subscription created!");
  console.log("   TX Hash:     ", txHash);
  console.log("   Block Number:", receipt.blockNumber.toString());
  console.log("\nArchitecture now complete:");
  console.log("  WhaleTracker.sol → [emits WhaleTransfer]");
  console.log("  Somnia Reactivity Engine → [pushes to handler]");
  console.log("  WhaleHandler._onEvent() → [emits ReactedToWhaleTransfer]");
  console.log("  Frontend WebSocket → [listens to both events]");
}

main().catch(e => { console.error(e); process.exit(1); });