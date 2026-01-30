/**
 * __LatticA__ Mantle Sepolia E2E Scenario
 *
 * Runs the full payroll flow against deployed contracts on Mantle Sepolia:
 * 1. Mint USDC to deployer
 * 2. BOB shields 1000 USDC
 * 3. Shield rollup
 * 4. BOB transfers to ALICE(300), CHARLIE(400), DAVID(300)
 * 5. Recipients unshield
 * 6. Final rollup
 * 7. Query audit logs
 *
 * Usage: npx hardhat run scripts/mantle_scenario.ts --network mantleSepolia
 */

// Set deployment block for paginated queryFilter on Mantle Sepolia
process.env.POOL_DEPLOY_BLOCK = "34100290";

import { ethers } from "hardhat";
import fs from "fs";
import path from "path";
import { sdk as interfaceSdkModule } from "../sdk";
import { createBackendSdk as createBackendSdkFn } from "../sdk/backendSdk";
import { TreesService } from "../sdk/serverSdk";
import {
  MockERC20__factory,
  PoolERC20__factory,
} from "../typechain-types";

function getCircuitJson(name: string) {
  const circuitPath = path.join(__dirname, "..", "noir", "target", `${name}.json`);
  return JSON.parse(fs.readFileSync(circuitPath, "utf-8"));
}

// Deployed contract addresses on Mantle Sepolia
const POOL_ADDRESS = "0x7E6E75ebE754BB6131BAFe594b02b96308314D46";
const USDC_ADDRESS = "0x32E058De9606B06c576619e619acA1CfCc213937"; // MockERC20

// ZK secret keys (different identities in the privacy layer)
const bobSecretKey = "0x2120f33c0d324bfe571a18c1d5a1c9cdc6db60621e35bc78be1ced339f936a71";
const aliceSecretKey = "0x118f09bc73ec486db2030077142f2bceba2a4d4c9e0f6147d776f8ca8ec02ff1";
const charlieSecretKey = "0x038c0439a42280637b202fd2f0d25d6e8e3c11908eab966a6d85bd6797eed5d5";
const davidSecretKey = "0x04a5f3c8b7e6d9f2a1b0c3e4d5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4";

const INITIAL_AMOUNT = 1000n;
const ALICE_AMOUNT = 300n;
const CHARLIE_AMOUNT = 400n;
const DAVID_AMOUNT = 300n;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("=".repeat(70));
  console.log("__LatticA__ Mantle Sepolia E2E Scenario");
  console.log("=".repeat(70));
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Network: Mantle Sepolia (chainId 5003)`);
  console.log(`Pool: ${POOL_ADDRESS}`);
  console.log(`USDC: ${USDC_ADDRESS}`);
  console.log("");

  const pool = PoolERC20__factory.connect(POOL_ADDRESS, deployer);
  const usdc = MockERC20__factory.connect(USDC_ADDRESS, deployer);

  // Initialize SDK
  const { CompleteWaAddress, TokenAmount, AuditLogService } = interfaceSdkModule;
  const coreSdk = interfaceSdkModule.createCoreSdk(pool);
  const trees = new TreesService(pool, 34100290); // PoolERC20 deployment block

  const sdk = interfaceSdkModule.createInterfaceSdk(coreSdk, trees, {
    shield: getCircuitJson("erc20_shield"),
    unshield: getCircuitJson("erc20_unshield"),
    join: getCircuitJson("erc20_join"),
    transfer: getCircuitJson("erc20_transfer"),
    swap: getCircuitJson("lob_router_swap"),
  });

  const backendSdk = createBackendSdkFn(coreSdk, trees, {
    rollup: getCircuitJson("rollup"),
  });

  const timings: { step: string; duration: number; gas?: string }[] = [];
  const startTotal = Date.now();

  // ============================================================
  // STEP 0: Mint USDC and approve
  // ============================================================
  console.log("[Step 0] Minting USDC and approving...");
  let t = Date.now();

  const mintTx = await usdc.mintForTests(deployer.address, INITIAL_AMOUNT);
  await mintTx.wait();
  console.log(`  Minted ${INITIAL_AMOUNT} USDC to deployer`);

  const approveTx = await usdc.approve(POOL_ADDRESS, ethers.MaxUint256);
  await approveTx.wait();
  console.log(`  Approved Pool to spend USDC`);

  timings.push({ step: "Mint + Approve", duration: Date.now() - t });

  // ============================================================
  // STEP 1: BOB shields 1000 USDC
  // ============================================================
  console.log("\n[Step 1] BOB shields 1000 USDC...");
  t = Date.now();

  const { note: bobNote, tx: shieldTx } = await sdk.poolErc20.shield({
    account: deployer, // deployer sends the tx, but ZK identity is BOB
    token: usdc,
    amount: INITIAL_AMOUNT,
    secretKey: bobSecretKey,
  });

  const shieldReceipt = await shieldTx.wait();
  const shieldGas = shieldReceipt?.gasUsed?.toString() || "?";
  console.log(`  Shield gas: ${shieldGas}`);
  timings.push({ step: "Shield (BOB 1000 USDC)", duration: Date.now() - t, gas: shieldGas });

  // ============================================================
  // STEP 2: Shield rollup
  // ============================================================
  console.log("\n[Step 2] Processing shield rollup...");
  t = Date.now();

  await backendSdk.rollup.rollup();

  const bobBalance = await sdk.poolErc20.balanceOf(usdc, bobSecretKey);
  console.log(`  BOB shielded balance: ${bobBalance}`);
  timings.push({ step: "Shield Rollup", duration: Date.now() - t });

  // ============================================================
  // STEP 3: BOB transfers to ALICE(300), CHARLIE(400), DAVID(300)
  // ============================================================
  console.log("\n[Step 3] BOB transfers to 3 recipients...");

  // Transfer to ALICE
  console.log("  [3a] BOB → ALICE (300 USDC)...");
  t = Date.now();
  const [note1] = await sdk.poolErc20.getBalanceNotesOf(usdc, bobSecretKey);
  const aliceTransfer = await sdk.poolErc20.transfer({
    secretKey: bobSecretKey,
    fromNote: note1,
    to: await CompleteWaAddress.fromSecretKey(aliceSecretKey),
    amount: await TokenAmount.from({ token: await usdc.getAddress(), amount: ALICE_AMOUNT }),
  });
  const aliceTransferGas = (await aliceTransfer.tx.wait())?.gasUsed?.toString() || "?";
  console.log(`    Gas: ${aliceTransferGas}`);
  timings.push({ step: "Transfer BOB→ALICE (300)", duration: Date.now() - t, gas: aliceTransferGas });

  console.log("    Rolling up...");
  t = Date.now();
  await backendSdk.rollup.rollup();
  timings.push({ step: "Rollup after ALICE transfer", duration: Date.now() - t });

  // Transfer to CHARLIE
  console.log("  [3b] BOB → CHARLIE (400 USDC)...");
  t = Date.now();
  const [note2] = await sdk.poolErc20.getBalanceNotesOf(usdc, bobSecretKey);
  const charlieTransfer = await sdk.poolErc20.transfer({
    secretKey: bobSecretKey,
    fromNote: note2,
    to: await CompleteWaAddress.fromSecretKey(charlieSecretKey),
    amount: await TokenAmount.from({ token: await usdc.getAddress(), amount: CHARLIE_AMOUNT }),
  });
  const charlieTransferGas = (await charlieTransfer.tx.wait())?.gasUsed?.toString() || "?";
  console.log(`    Gas: ${charlieTransferGas}`);
  timings.push({ step: "Transfer BOB→CHARLIE (400)", duration: Date.now() - t, gas: charlieTransferGas });

  console.log("    Rolling up...");
  t = Date.now();
  await backendSdk.rollup.rollup();
  timings.push({ step: "Rollup after CHARLIE transfer", duration: Date.now() - t });

  // Transfer to DAVID
  console.log("  [3c] BOB → DAVID (300 USDC)...");
  t = Date.now();
  const [note3] = await sdk.poolErc20.getBalanceNotesOf(usdc, bobSecretKey);
  const davidTransfer = await sdk.poolErc20.transfer({
    secretKey: bobSecretKey,
    fromNote: note3,
    to: await CompleteWaAddress.fromSecretKey(davidSecretKey),
    amount: await TokenAmount.from({ token: await usdc.getAddress(), amount: DAVID_AMOUNT }),
  });
  const davidTransferGas = (await davidTransfer.tx.wait())?.gasUsed?.toString() || "?";
  console.log(`    Gas: ${davidTransferGas}`);
  timings.push({ step: "Transfer BOB→DAVID (300)", duration: Date.now() - t, gas: davidTransferGas });

  console.log("    Rolling up...");
  t = Date.now();
  await backendSdk.rollup.rollup();
  timings.push({ step: "Rollup after DAVID transfer", duration: Date.now() - t });

  // Verify shielded balances
  const aliceBal = await sdk.poolErc20.balanceOf(usdc, aliceSecretKey);
  const charlieBal = await sdk.poolErc20.balanceOf(usdc, charlieSecretKey);
  const davidBal = await sdk.poolErc20.balanceOf(usdc, davidSecretKey);
  const bobRemaining = await sdk.poolErc20.balanceOf(usdc, bobSecretKey);
  console.log(`\n  Shielded balances:`);
  console.log(`    ALICE:   ${aliceBal} USDC`);
  console.log(`    CHARLIE: ${charlieBal} USDC`);
  console.log(`    DAVID:   ${davidBal} USDC`);
  console.log(`    BOB:     ${bobRemaining} USDC (should be 0)`);

  // ============================================================
  // STEP 4: Recipients unshield
  // ============================================================
  console.log("\n[Step 4] Recipients unshield...");

  // ALICE unshields — deployer receives the USDC on-chain
  console.log("  [4a] ALICE unshields 300 USDC...");
  t = Date.now();
  const [aliceNote] = await sdk.poolErc20.getBalanceNotesOf(usdc, aliceSecretKey);
  const aliceUnshield = await sdk.poolErc20.unshield({
    secretKey: aliceSecretKey,
    fromNote: aliceNote,
    token: await usdc.getAddress(),
    to: deployer.address,
    amount: ALICE_AMOUNT,
  });
  const aliceUnshieldGas = (await aliceUnshield.tx.wait())?.gasUsed?.toString() || "?";
  console.log(`    Gas: ${aliceUnshieldGas}`);
  console.log(`    Nullifier: ${aliceUnshield.nullifier}`);
  timings.push({ step: "Unshield ALICE (300)", duration: Date.now() - t, gas: aliceUnshieldGas });

  // CHARLIE unshields
  console.log("  [4b] CHARLIE unshields 400 USDC...");
  t = Date.now();
  const [charlieNote] = await sdk.poolErc20.getBalanceNotesOf(usdc, charlieSecretKey);
  const charlieUnshield = await sdk.poolErc20.unshield({
    secretKey: charlieSecretKey,
    fromNote: charlieNote,
    token: await usdc.getAddress(),
    to: deployer.address,
    amount: CHARLIE_AMOUNT,
  });
  const charlieUnshieldGas = (await charlieUnshield.tx.wait())?.gasUsed?.toString() || "?";
  console.log(`    Gas: ${charlieUnshieldGas}`);
  console.log(`    Nullifier: ${charlieUnshield.nullifier}`);
  timings.push({ step: "Unshield CHARLIE (400)", duration: Date.now() - t, gas: charlieUnshieldGas });

  // DAVID unshields
  console.log("  [4c] DAVID unshields 300 USDC...");
  t = Date.now();
  const [davidNote] = await sdk.poolErc20.getBalanceNotesOf(usdc, davidSecretKey);
  const davidUnshield = await sdk.poolErc20.unshield({
    secretKey: davidSecretKey,
    fromNote: davidNote,
    token: await usdc.getAddress(),
    to: deployer.address,
    amount: DAVID_AMOUNT,
  });
  const davidUnshieldGas = (await davidUnshield.tx.wait())?.gasUsed?.toString() || "?";
  console.log(`    Gas: ${davidUnshieldGas}`);
  console.log(`    Nullifier: ${davidUnshield.nullifier}`);
  timings.push({ step: "Unshield DAVID (300)", duration: Date.now() - t, gas: davidUnshieldGas });

  // ============================================================
  // STEP 5: Final rollup
  // ============================================================
  console.log("\n[Step 5] Processing final rollup...");
  t = Date.now();
  await backendSdk.rollup.rollup();
  timings.push({ step: "Final Rollup", duration: Date.now() - t });
  console.log("  Rollup processed");

  // ============================================================
  // STEP 6: Query audit logs
  // ============================================================
  console.log("\n[Step 6] Querying audit logs...");
  const auditLogService = new AuditLogService(pool);

  const aliceLog = await auditLogService.queryAuditLog(aliceUnshield.nullifier);
  const charlieLog = await auditLogService.queryAuditLog(charlieUnshield.nullifier);
  const davidLog = await auditLogService.queryAuditLog(davidUnshield.nullifier);

  if (aliceLog) {
    console.log(`  ALICE audit log: wa_commitment=${aliceLog.waCommitment.slice(0, 20)}...`);
  } else {
    console.log(`  ALICE audit log: NOT FOUND`);
  }
  if (charlieLog) {
    console.log(`  CHARLIE audit log: wa_commitment=${charlieLog.waCommitment.slice(0, 20)}...`);
  } else {
    console.log(`  CHARLIE audit log: NOT FOUND`);
  }
  if (davidLog) {
    console.log(`  DAVID audit log: wa_commitment=${davidLog.waCommitment.slice(0, 20)}...`);
  } else {
    console.log(`  DAVID audit log: NOT FOUND`);
  }

  const allLogs = await auditLogService.getAllAuditLogs();
  console.log(`  Total audit logs on-chain: ${allLogs.length}`);

  // ============================================================
  // SUMMARY
  // ============================================================
  const totalDuration = Date.now() - startTotal;
  console.log("\n" + "=".repeat(70));
  console.log("PERFORMANCE SUMMARY");
  console.log("=".repeat(70));
  console.log(`${"Step".padEnd(40)} ${"Time (s)".padStart(10)} ${"Gas".padStart(12)}`);
  console.log("-".repeat(70));
  for (const t of timings) {
    const sec = (t.duration / 1000).toFixed(1);
    console.log(`${t.step.padEnd(40)} ${sec.padStart(10)} ${(t.gas || "-").padStart(12)}`);
  }
  console.log("-".repeat(70));
  console.log(`${"TOTAL".padEnd(40)} ${(totalDuration / 1000).toFixed(1).padStart(10)}`);
  console.log("=".repeat(70));

  console.log("\nAudit Log Nullifiers:");
  console.log(`  ALICE:   ${aliceUnshield.nullifier}`);
  console.log(`  CHARLIE: ${charlieUnshield.nullifier}`);
  console.log(`  DAVID:   ${davidUnshield.nullifier}`);
}

main().catch((err) => {
  console.error("Scenario failed:", err);
  process.exit(1);
});
