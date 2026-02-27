import { createWalletClient, createPublicClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
});

const CONTRACT = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;
const ABI = [{
  name: "reportTransfer",
  type: "function",
  inputs: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
  ],
  outputs: [],
  stateMutability: "nonpayable",
}] as const;

async function main() {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const publicClient = createPublicClient({ chain: somniaTestnet, transport: http() });
  const walletClient = createWalletClient({ account, chain: somniaTestnet, transport: http() });

  console.log("Sending whale transfer from:", account.address);

  const hash = await walletClient.writeContract({
    address: CONTRACT,
    abi: ABI,
    functionName: "reportTransfer",
    args: [
      "0x1111111111111111111111111111111111111111",
      "0x2222222222222222222222222222222222222222",
      parseEther("50000"),
    ],
  });

  console.log("Tx submitted:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log("✅ Confirmed in block:", receipt.blockNumber.toString());
}

main().catch((e) => { console.error(e); process.exit(1); });