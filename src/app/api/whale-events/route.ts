import { NextRequest } from "next/server";
import { SDK } from "@somnia-chain/reactivity";
import { createPublicClient, createWalletClient, webSocket, http, keccak256, toBytes, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://dream-rpc.somnia.network"],
      webSocket: ["wss://dream-rpc.somnia.network/ws"],
    },
  },
});

// Server-side cache — survives page refreshes
const MAX_CACHE = 100;
const alertCache: object[] = [];

let activeSub: { unsubscribe: () => Promise<any> } | null = null;

async function ensureSubscription() {
  if (activeSub) return;

  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const publicClient = createPublicClient({ chain: somniaTestnet, transport: webSocket("wss://dream-rpc.somnia.network/ws") });
  const walletClient = createWalletClient({ account, chain: somniaTestnet, transport: http("https://dream-rpc.somnia.network") });
  const sdk = new SDK({ public: publicClient, wallet: walletClient });

  const TOPIC = keccak256(toBytes("WhaleTransfer(address,address,uint256,uint256)"));
  const CONTRACT = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS as `0x${string}`;

  const result = await sdk.subscribe({
    ethCalls: [],
    eventContractSources: [CONTRACT],
    topicOverrides: [TOPIC],
    onData: (data: any) => {
      console.log("SDK data:", JSON.stringify(data));
      const entry = { type: "whale", raw: data, receivedAt: Date.now() };
      alertCache.push(entry);
      if (alertCache.length > MAX_CACHE) alertCache.shift();
      // Notify all active SSE clients
      controllers.forEach(c => {
        try { c.enqueue(encoder.encode(`data: ${JSON.stringify(entry)}\n\n`)); }
        catch { }
      });
    },
    onError: (e: Error) => console.error("SDK error:", e),
  });

  if (result instanceof Error) throw result;
  activeSub = result;
  console.log("✅ Subscription active:", result.subscriptionId);
}

const encoder = new TextEncoder();
const controllers = new Set<ReadableStreamDefaultController>();

export async function GET(req: NextRequest) {
  await ensureSubscription();

  const stream = new ReadableStream({
    start(controller) {
      controllers.add(controller);

      // Send cached alerts immediately on connect
      const init = { type: "init", alerts: alertCache };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(init)}\n\n`));
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected" })}\n\n`));

      // Keep-alive ping
      const ping = setInterval(() => {
        try { controller.enqueue(encoder.encode(`: ping\n\n`)); }
        catch { clearInterval(ping); }
      }, 30000);

      req.signal.addEventListener("abort", () => {
        clearInterval(ping);
        controllers.delete(controller);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}