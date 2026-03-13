import { http, createConfig } from "wagmi";
import { injected } from "wagmi/connectors";
import { defineChain } from "viem";

export const somniaTestnet = defineChain({
  id: 50312,
  name: "Somnia Testnet",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: {
    default: {
      http: ["https://dream-rpc.somnia.network"],
      webSocket: ["wss://dream-rpc.somnia.network/ws"],
    },
  },
  blockExplorers: {
    default: {
      name: "Somnia Explorer",
      url: "https://shannon-explorer.somnia.network",
    },
  },
  testnet: true,
});

export const wagmiConfig = createConfig({
  chains: [somniaTestnet],
  connectors: [injected()], // Only browser injected wallets (MetaMask, etc.)
  transports: {
    [somniaTestnet.id]: http(),
  },
  ssr: true,
});