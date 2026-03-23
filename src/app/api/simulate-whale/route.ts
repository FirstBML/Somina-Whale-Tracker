import { NextRequest, NextResponse } from "next/server";
import {
  createWalletClient, createPublicClient, http, parseEther, defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { injectSimulatedWhale } from "../whale-events/route";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["https://dream-rpc.somnia.network"] } },
});

const TOKENS = ["STT","USDC","WETH","WBTC","USDT","LINK","UNI","AAVE"];
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
    { name: "token",  type: "string" },
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

    const token = pick(TOKENS);
    const from  = pick(WALLETS) as `0x${string}`;
    let   to    = pick(WALLETS) as `0x${string}`;
    while (to === from) to = pick(WALLETS) as `0x${string}`;

    // Amount: 10k–500k tokens (large enough to be clearly simulated)
    const amountEth = String(Math.floor(Math.random() * 490_000) + 10_000);
    const amount    = parseEther(amountEth);

    let hash: `0x${string}` | undefined;
    let lastErr: any;
    // Retry up to 3 times — watchNetwork.ts competes for nonces on the same wallet
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const nonce = await pubClient.getTransactionCount({
          address: account.address,
          blockTag: "pending",
        });
        hash = await walClient.writeContract({
          address: contractAddress, abi: ABI,
          functionName: "reportTransfer",
          args: [from, to, amount, token],
          nonce,
        });
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = e;
        const msg: string = e?.message ?? e?.details ?? "";
        if (msg.includes("nonce") || msg.includes("Nonce")) {
          // Brief pause before re-fetching nonce
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw e; // non-nonce error — don't retry
      }
    }
    if (lastErr) throw lastErr;
    if (!hash) throw new Error("Transaction hash not obtained after retries");

    // ── FIX: Inject the simulated whale directly into the SSE feed ─────────────
    // The block watcher cannot detect this transaction because simulate-whale sends
    // a contract CALL with no native STT value (tx.value = 0). Without this injection,
    // the simulated whale never appears in the frontend whale feed.
    injectSimulatedWhale({ from, to, amountEth, token, txHash: hash });

    // Fire and return immediately — don't wait for receipt (testnet can be slow)
    return NextResponse.json({
      success: true,
      txHash: hash,
      token,
      amount: amountEth,
    });

  } catch (e: any) {
    console.error("simulate-whale error:", e?.shortMessage ?? e?.message);
    return NextResponse.json(
      { success: false, error: e?.shortMessage ?? e?.message },
      { status: 500 }
    );
  }
}