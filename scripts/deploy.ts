import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await deployer.provider.getBalance(deployer.address)), "STT\n");

  // ── Step 1: Deploy WhaleTracker ──────────────────────────────────────────
  const threshold = ethers.parseEther("10000");
  const WhaleTracker = await ethers.getContractFactory("WhaleTracker");
  const tracker = await WhaleTracker.deploy(threshold);
  await tracker.waitForDeployment();
  const trackerAddr = await tracker.getAddress();
  console.log("✅ WhaleTracker deployed:", trackerAddr);

  // ── Step 2: Deploy WhaleHandler ──────────────────────────────────────────
  // alertEvery=5 means AlertThresholdCrossed fires every 5 whale transfers
  const WhaleHandler = await ethers.getContractFactory("WhaleHandler");
  const handler = await WhaleHandler.deploy(trackerAddr, 5);
  await handler.waitForDeployment();
  const handlerAddr = await handler.getAddress();
  console.log("✅ WhaleHandler deployed:", handlerAddr);

  // ── Output ────────────────────────────────────────────────────────────────
  console.log("\n📋 Update your .env.local with:");
  console.log(`NEXT_PUBLIC_CONTRACT_ADDRESS=${trackerAddr}`);
  console.log(`HANDLER_CONTRACT_ADDRESS=${handlerAddr}`);
  console.log("\n📋 Then run:");
  console.log("npx tsx scripts/createSubscription.ts");
}

main().catch(e => { console.error(e); process.exit(1); });