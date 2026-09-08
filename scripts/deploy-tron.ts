import hre from "hardhat";
import { TronWeb } from "tronweb";
import { describeEnv } from "../env";

/**
 * Deploys ElexaEscrow to TRON and allow-lists the tokens it may escrow.
 *
 * The TRON sibling of deploy.ts. It deploys the *same* contract from the *same*
 * compiled artifact: TRON's TVM executes the bytecode solc already emits for
 * BSC, so there is no TRON-specific Solidity and no second compiler here. Only
 * the deployment transport differs, which is why this is a script rather than a
 * separate contracts project — a forked copy of ElexaEscrow.sol would drift
 * from the audited one the first time either side is patched.
 *
 * Two compiler settings in hardhat.config.ts are what make this work, and both
 * must stay as they are:
 *   - `evmVersion: "paris"`, which keeps PUSH0 out of the bytecode. The TVM
 *     does not implement it, and a shanghai build fails at deployment rather
 *     than at a call, so it looks like a broken address.
 *   - the optimizer, because TRON charges energy for deployment size.
 *
 * Run with:
 *   npx hardhat run scripts/deploy-tron.ts --network hardhat
 *
 * The --network flag is only there to satisfy Hardhat; nothing in this script
 * touches an EVM node. Where it actually deploys is TRON_NETWORK.
 *
 * Required env:
 *   TRON_PRIVATE_KEY       funds the deployment; becomes owner unless TRON_OWNER_ADDRESS is set
 *   TRON_ARBITER_ADDRESS   key that settles disputes (base58, T…)
 *   TRON_FEE_COLLECTOR     where platform fees land (base58, T…)
 *   TRON_ALLOWED_TOKENS    comma-separated TRC-20 addresses to allow-list (e.g. USDT)
 * Optional:
 *   TRON_NETWORK           shasta (default) | mainnet
 *   TRON_OWNER_ADDRESS     admin key, if it should differ from the deployer
 *   TRON_ALLOW_NATIVE      "true" to also accept TRX escrow
 *   TRONGRID_API_KEY       required in practice on mainnet; TronGrid throttles hard without it
 *
 * Verify the token addresses on tronscan before running this against mainnet.
 * An allow-listed impostor token is the cheapest way to get users robbed, and
 * TRON's base58 addresses are considerably harder to eyeball than 0x-hex.
 */

/** TRON_NETWORK -> node endpoint and explorer. */
const TRON_NETWORKS: Record<string, { host: string; explorer: string }> = {
  mainnet: {
    host: "https://api.trongrid.io",
    explorer: "https://tronscan.org/#",
  },
  shasta: {
    host: "https://api.shasta.trongrid.io",
    explorer: "https://shasta.tronscan.org/#",
  },
  // Nile is deliberately absent: one testnet is enough to exercise the TVM
  // differences this script exists for, and a second one is another set of
  // faucets, endpoints and allow-listed token addresses to keep straight.
};

/**
 * Energy ceiling for the deployment, in SUN (1 TRX = 1e6 SUN).
 *
 * TRON has no gas price to estimate — you set a maximum you are willing to burn
 * and the network takes what it needs. 5000 TRX is generous for a contract this
 * size and exists to stop a mispriced energy market silently emptying the
 * deployer account, not because the deployment costs anything like it.
 */
const DEPLOY_FEE_LIMIT = 5_000_000_000;

/** Same ceiling logic, for the one-argument admin calls after deployment. */
const CALL_FEE_LIMIT = 100_000_000;

async function main() {
  const networkName = (process.env.TRON_NETWORK ?? "shasta").trim().toLowerCase();
  const target = TRON_NETWORKS[networkName];
  if (!target) {
    throw new Error(
      `Unknown TRON_NETWORK '${networkName}'. Expected one of: ${Object.keys(TRON_NETWORKS).join(", ")}`,
    );
  }

  const privateKey = required("TRON_PRIVATE_KEY").replace(/^0x/, "");
  const arbiter = required("TRON_ARBITER_ADDRESS");
  const feeCollector = required("TRON_FEE_COLLECTOR");
  const tokens = (process.env.TRON_ALLOWED_TOKENS ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error("TRON_ALLOWED_TOKENS is empty — the contract would accept no deposits.");
  }

  const tronWeb = new TronWeb({
    fullHost: target.host,
    privateKey,
    headers: process.env.TRONGRID_API_KEY
      ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY }
      : undefined,
  });

  const deployer = tronWeb.address.fromPrivateKey(privateKey);
  if (!deployer) throw new Error("TRON_PRIVATE_KEY is not a valid 32-byte hex key.");
  const owner = process.env.TRON_OWNER_ADDRESS?.trim() || deployer;

  // Every address is checked before anything is signed. A base58 typo that
  // still parses would otherwise become an unrecoverable feeCollector or an
  // arbiter nobody holds the key to, and neither is fixable after deployment
  // without an owner call from a key that may itself be the typo.
  for (const [label, address] of [
    ["TRON_OWNER_ADDRESS", owner],
    ["TRON_ARBITER_ADDRESS", arbiter],
    ["TRON_FEE_COLLECTOR", feeCollector],
    ...tokens.map((t, i): [string, string] => [`TRON_ALLOWED_TOKENS[${i}]`, t]),
  ] as Array<[string, string]>) {
    if (!tronWeb.isAddress(address)) {
      throw new Error(`${label} is not a valid TRON address: ${address}`);
    }
  }

  console.log(`settings     ${describeEnv()}`);
  console.log(`network      TRON ${networkName} (${target.host})`);
  console.log(`deployer     ${deployer}`);
  console.log(`owner        ${owner}`);
  console.log(`arbiter      ${arbiter}`);
  console.log(`feeCollector ${feeCollector}`);

  const balance = await tronWeb.trx.getBalance(deployer);
  console.log(`balance      ${balance / 1e6} TRX`);
  if (balance === 0) {
    throw new Error(
      `${deployer} holds no TRX. Deployment burns energy and bandwidth paid for in TRX` +
        (networkName === "shasta" ? " — fund it from https://shasta.tronex.io/." : "."),
    );
  }

  // Straight from Hardhat's build output. Not recompiled, not re-flattened:
  // whatever `npm run build` produced for BSC is byte-for-byte what goes on
  // chain here, so the two deployments cannot be different contracts.
  const artifact = await hre.artifacts.readArtifact("ElexaEscrow");

  const instance = await tronWeb.contract().new({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    feeLimit: DEPLOY_FEE_LIMIT,
    callValue: 0,
    // TRON charges for the storage a contract's own calls consume, split
    // between the caller and the contract. 100% means callers pay their own
    // energy, which is what every wallet expects and what the EVM does.
    userFeePercentage: 100,
    parameters: [owner, arbiter, feeCollector],
  });

  // tronweb hands back the 41-hex form; everything downstream — tronscan,
  // TronLink, anything storing the address — speaks base58, so convert once.
  const address = instance.address && tronWeb.address.fromHex(instance.address);
  if (!address) {
    throw new Error("Deployment returned no contract address. Check the fee limit and the deployer's balance.");
  }
  console.log(`\nElexaEscrow deployed at ${address}`);
  console.log(`${target.explorer}/contract/${address}`);

  // See scripts/deploy.ts for the whole story: the constructor hands ownership
  // to `owner`, so once it differs from the deployer every call below is
  // onlyOwner and reverts. On BSC that produced a mainnet contract that looked
  // deployed and allow-listed nothing. Print the calldata instead of failing.
  const allowNative = (process.env.TRON_ALLOW_NATIVE ?? "").toLowerCase() === "true";
  const deployerIsOwner = owner === deployer;

  if (deployerIsOwner) {
    for (const token of tokens) {
      await instance.setTokenAllowed(token, true).send({ feeLimit: CALL_FEE_LIMIT });
      console.log(`allow-listed ${token}`);
    }

    // Native TRX escrow is off unless asked for: a stablecoin-only deployment
    // should not accept deposits it has no offers for.
    if (allowNative) {
      await instance.setNativeAllowed(true).send({ feeLimit: CALL_FEE_LIMIT });
      console.log("native coin (TRX) escrow enabled");
    }
  } else {
    const pending = [
      ...tokens.map((token) => `setTokenAllowed(${token}, true)`),
      ...(allowNative ? ["setNativeAllowed(true)"] : []),
    ];
    console.log(
      `\n${"=".repeat(72)}\n` +
        `NOT YET USABLE — the contract accepts no deposits until these have run.\n` +
        `TRON_OWNER_ADDRESS is not the deployer, so this script cannot send them:\n` +
        `they are onlyOwner and would revert.\n\n` +
        `Send from ${owner} against ${address}:\n` +
        pending.map((c) => `  ${c}`).join("\n") +
        `\n\nEasiest from Tronscan's contract page, or scripts/tron-admin.ts with\n` +
        `TRON_PRIVATE_KEY set to the owner's key. Confirm tokenAllowed/nativeAllowed\n` +
        `before pointing anything at this deployment.\n` +
        `${"=".repeat(72)}`,
    );
  }

  const block = await tronWeb.trx.getCurrentBlock();
  const deployBlock = block?.block_header?.raw_data?.number ?? 0;

  // Worth recording as configuration rather than rediscovering later: an
  // indexer needs the deploy block to know where to start reading from.
  console.log("\nDeployment:");
  console.log(`  network        TRON ${networkName}`);
  console.log(`  address        ${address}`);
  console.log(`  deploy block   ${deployBlock}`);
  console.log(
    "\nTRON_ARBITER_ADDRESS above must be the address derived from the key " +
      "that\nwill settle disputes. Nothing checks this and nothing fails until " +
      "the first\ndispute, so compare the two by hand now.",
  );
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
