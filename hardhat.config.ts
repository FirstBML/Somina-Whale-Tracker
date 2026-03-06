import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.30",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    somniaTestnet: {
      url:      process.env.RPC_URL || "https://dream-rpc.somnia.network",
      chainId:  50312,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      gas:      3_000_000,
      timeout:  120_000,
    },
  },
};

export default config;