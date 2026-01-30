/**
 * Regenerate verifiers using getSolidityVerifier(vkBytes) — the correct API
 * that embeds the actual VK into the Solidity code.
 */
import { UltraHonkBackend } from "@aztec/bb.js";
import fs from "fs";
import path from "path";

async function main() {
  const circuits = [
    "erc20_shield",
    "erc20_unshield",
    "erc20_join",
    "erc20_transfer",
    "lob_router_swap",
    "rollup",
  ];

  const targetDir = path.join(__dirname, "..", "noir", "target");
  const verifiersDir = path.join(__dirname, "..", "contracts", "verifiers");

  for (const name of circuits) {
    console.log(`Processing ${name}...`);
    const circuit = JSON.parse(fs.readFileSync(path.join(targetDir, `${name}.json`), "utf-8"));
    const backend = new UltraHonkBackend(circuit.bytecode);

    // Get VK bytes with keccak
    const vkBytes = await backend.getVerificationKey({ keccak: true });

    // Get Solidity verifier with VK embedded (like hardhat-noir does)
    const solRaw = await backend.getSolidityVerifier(vkBytes);
    let sol: string;
    if (typeof solRaw === "string") {
      sol = solRaw;
    } else {
      sol = new TextDecoder().decode(solRaw);
    }

    // Verify N value
    const nMatch = sol.match(/uint256 constant N = (\d+)/);
    console.log(`  N = ${nMatch?.[1]}`);

    fs.writeFileSync(path.join(verifiersDir, `${name}.sol`), sol);
    console.log(`  Written ${name}.sol`);
    await backend.destroy();
  }
  console.log("Done!");
}
main().catch(console.error);
