import hre from "hardhat";
import { describeEnv } from "../env";

/**
 * Deploys ElexaEscrow and allow-lists the tokens it may escrow.
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY  funds the deployment; becomes owner unless OWNER_ADDRESS is set
 *   ARBITER_ADDRESS       key that settles disputes (a hot key, or a Safe)
 *   FEE_COLLECTOR_ADDRESS where platform fees land
 *   ALLOWED_TOKENS        comma-separated token addresses to allow-list (e.g. USDT BEP-20)
 * Optional:
 *   OWNER_ADDRESS         admin key, if it should differ from the deployer
 *
 * Setting OWNER_ADDRESS is the safer deployment and changes what this script can
 * finish: the allow-list calls are onlyOwner, and the deployer stops being owner
 * the moment the constructor runs. In that case the script prints the calldata
 * for them rather than failing on the first one.
 *
 * Verify the token addresses on BscScan before running this against mainnet —
 * an allow-listed impostor token is the cheapest way to get users robbed.
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();

  // hardhat.config.ts builds `accounts` from DEPLOYER_PRIVATE_KEY, so an unset
  // key leaves the network with no signers at all. Say that, rather than
  // failing on `deployer.address` with an unexplained TypeError.
  if (!deployer) {
    throw new Error(
      `No signer for network '${hre.network.name}'. Set DEPLOYER_PRIVATE_KEY ` +
        `in contracts/.env.testnet or .env.mainnet (copy .env.example) — it funds ` +
        `the deployment and becomes the owner unless OWNER_ADDRESS is set.`,
    );
  }

  // Blank, not absent: .env.example ships `OWNER_ADDRESS=`, which arrives as ""
  // rather than undefined, so `??` would keep the empty string and ethers would
  // try to resolve it as an ENS name. Same reason hardhat.config.ts has `env()`.
  const owner = process.env.OWNER_ADDRESS?.trim() || deployer.address;
  const arbiter = required("ARBITER_ADDRESS");
  const feeCollector = required("FEE_COLLECTOR_ADDRESS");
  const tokens = (process.env.ALLOWED_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error("ALLOWED_TOKENS is empty — the contract would accept no deposits.");
  }

  console.log(`settings     ${describeEnv()}`);
  console.log(`network      ${hre.network.name}`);
  console.log(`deployer     ${deployer.address}`);
  console.log(`owner        ${owner}`);
  console.log(`arbiter      ${arbiter}`);
  console.log(`feeCollector ${feeCollector}`);

  const escrow = await hre.ethers.deployContract("ElexaEscrow", [owner, arbiter, feeCollector]);
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  console.log(`\nElexaEscrow deployed at ${address}`);

  // Ownership is handed to `owner` by the constructor, so from this line on the
  // deployer holds no admin rights at all. When the two differ — which is the
  // right way to deploy, keeping the cold wallet as owner — every call below is
  // `onlyOwner` and reverts with OwnableUnauthorizedAccount(deployer).
  //
  // That used to happen *after* a successful deployment, leaving a mainnet
  // contract that looked deployed but allow-listed nothing, so funding reverted
  // with TokenNotAllowed and the failure looked like a contract bug. Print the
  // calldata instead and let the owner send it.
  const allowNative = (process.env.ALLOW_NATIVE ?? "").toLowerCase() === "true";
  const deployerIsOwner = owner.toLowerCase() === deployer.address.toLowerCase();

  if (deployerIsOwner) {
    for (const token of tokens) {
      const tx = await escrow.setTokenAllowed(token, true);
      await tx.wait();
      console.log(`allow-listed ${token}`);
    }

    // Native BNB escrow is off unless asked for: a stablecoin-only deployment
    // should not accept deposits it has no offers for.
    if (allowNative) {
      const tx = await escrow.setNativeAllowed(true);
      await tx.wait();
      console.log("native coin (BNB) escrow enabled");
    }
  } else {
    const calls = tokens.map((token) => ({
      label: `setTokenAllowed(${token}, true)`,
      data: escrow.interface.encodeFunctionData("setTokenAllowed", [token, true]),
    }));
    if (allowNative) {
      calls.push({
        label: "setNativeAllowed(true)",
        data: escrow.interface.encodeFunctionData("setNativeAllowed", [true]),
      });
    }

    console.log(
      `\n${"=".repeat(72)}\n` +
        `NOT YET USABLE — the contract accepts no deposits until the calls below\n` +
        `have been sent. OWNER_ADDRESS is not the deployer, so this script cannot\n` +
        `send them: they are onlyOwner and would revert.\n\n` +
        `Send each from ${owner}, to ${address}, value 0:\n`,
    );
    for (const { label, data } of calls) {
      console.log(`  ${label}\n    ${data}\n`);
    }
    console.log(
      `That account needs a little ${hre.network.name === "bsc" ? "BNB" : "native coin"} ` +
        `for gas. Re-run scripts/check.ts (or read tokenAllowed/nativeAllowed)\n` +
        `to confirm before pointing anything at this deployment.\n` +
        `${"=".repeat(72)}`,
    );
  }

  // Worth recording as configuration rather than rediscovering later: an
  // indexer needs the deploy block to know where to start reading from, and
  // both belong wherever the application stores its per-network settings.
  console.log("\nDeployment:");
  console.log(`  network        ${hre.network.name}`);
  console.log(`  address        ${address}`);
  console.log(`  deploy block   ${await hre.ethers.provider.getBlockNumber()}`);
  console.log(`\nVerify with:\n  npx hardhat verify --network ${hre.network.name} ${address} ${owner} ${arbiter} ${feeCollector}`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
