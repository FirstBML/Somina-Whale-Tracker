import { NextRequest, NextResponse } from "next/server";
import {
  createWalletClient, createPublicClient, http, parseEther, defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
});

const TOKENS  = ["STT","USDC","WETH","WBTC","USDT","LINK","UNI","AAVE"];
const WALLETS = [
  "0xaabbccddee000000000000000000000000000001",
  "0xaabbccddee000000000000000000000000000002",
  "0xaabbccddee000000000000000000000000000003",
  "0xaabbccddee000000000000000000000000000004",
  "0xaabbccddee000000000000000000000000000005",
];

const ABI = [{
  name: "reportTransfer", type: "function", stateMutability: "nonpayable",
  inputs: [
    { name: "from",   type: "address" },
    { name: "to",     type: "address" },
    { name: "amount", type: "uint256" },
    { name: "token",  type: "string"  },
  ],
  outputs: [],
}] as const;

function pick(arr: string[]): string {
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function POST(_req: NextRequest) {
  try {
    const privateKey      = process.env.PRIVATE_KEY as `0x${string}`;
    const contractAddress = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;

    if (!privateKey || !contractAddress) {
      return NextResponse.json(
        { success: false, error: "Missing PRIVATE_KEY or NEXT_PUBLIC_CONTRACT_ADDRESS" },
        { status: 500 }
      );
    }

    const account   = privateKeyToAccount(privateKey);
    const pubClient = createPublicClient({ chain: somniaTestnet, transport: http() });
    const walClient = createWalletClient({ account, chain: somniaTestnet, transport: http() });

    const token  = pick(TOKENS);
    const from   = pick(WALLETS) as `0x${string}`;
    let   to     = pick(WALLETS) as `0x${string}`;
    while (to === from) to = pick(WALLETS) as `0x${string}`;

    const amountEth = String(Math.floor(Math.random() * 490_000) + 10_000);
    const amount    = parseEther(amountEth);

    // Always use pending to get latest nonce including unconfirmed txns
    const nonce = await pubClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });

    let hash: `0x${string}`;
    try {
      hash = await walClient.writeContract({
        address: contractAddress, abi: ABI,
        functionName: "reportTransfer",
        args: [from, to, amount, token],
        nonce,
      });
    } catch (e: any) {
      // On nonce-too-low, fetch fresh nonce and retry once
      if (e?.message?.includes("nonce") || e?.details?.includes("nonce")) {
        const freshNonce = await pubClient.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        });
        hash = await walClient.writeContract({
          address: contractAddress, abi: ABI,
          functionName: "reportTransfer",
          args: [from, to, amount, token],
          nonce: freshNonce,
        });
      } else {
        throw e;
      }
    }

    // Fire and return immediately — don't wait for receipt (testnet can be slow)
    return NextResponse.json({
      success:     true,
      txHash:      hash,
      token,
      amount:      amountEth,
    });
  } catch (e: any) {
    console.error("simulate-whale error:", e?.shortMessage ?? e?.message);
    return NextResponse.json({ success: false, error: e?.shortMessage ?? e?.message }, { status: 500 });
  }
}