import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const threshold = ethers.parseEther("10000"); // 10,000 token threshold
  const WhaleTracker = await ethers.getContractFactory("WhaleTracker");
  const tracker = await WhaleTracker.deploy(threshold);
  await tracker.waitForDeployment();

  const address = await tracker.getAddress();
  console.log("✅ WhaleTracker deployed to:", address);
  console.log("👉 Copy this address to your .env.local as NEXT_PUBLIC_CONTRACT_ADDRESS");
}

main().catch((e) => { console.error(e); process.exit(1); });