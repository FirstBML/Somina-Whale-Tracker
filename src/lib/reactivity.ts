import { SDK, SubscriptionCallback } from "@somnia-chain/reactivity";
import { createPublicClient, createWalletClient, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { somniaTestnet } from "viem/chains";

const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;

export function getSDK() {
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const publicClient = createPublicClient({ chain: somniaTestnet, transport: http(RPC_URL) });
  const walletClient = createWalletClient({ account, chain: somniaTestnet, transport: http(RPC_URL) });
  return new SDK({ public: publicClient, wallet: walletClient });
}

export async function subscribeToWhaleTransfers(
  onWhale: (data: { from: string; to: string; amount: bigint; timestamp: bigint }) => void,
  onError?: (err: unknown) => void
) {
  const sdk = getSDK();
  const WHALE_TRANSFER_TOPIC = keccak256(toBytes("WhaleTransfer(address,address,uint256,uint256)"));

  const result = await sdk.subscribe({
    ethCalls: [],
    eventContractSources: [CONTRACT_ADDRESS],   // 
    topicOverrides: [WHALE_TRANSFER_TOPIC],      // 
    onData: (data: SubscriptionCallback) => {
      try {
        const { topics, data: rawData } = data.result;  // 
        if (!topics || topics.length < 3) return;

        const from = `0x${topics[1]?.slice(26)}`;
        const to   = `0x${topics[2]?.slice(26)}`;
        // rawData is hex: first 32 bytes = amount, next 32 bytes = timestamp
        const amount    = BigInt(`0x${rawData.slice(2, 66)}`);
        const timestamp = BigInt(`0x${rawData.slice(66, 130)}`);

        onWhale({ from, to, amount, timestamp });
      } catch (e) {
        onError?.(e);
      }
    },
    onError: (e: Error) => onError?.(e),
  });

  if (result instanceof Error) throw result;
  return result; // { subscriptionId, unsubscribe }
}