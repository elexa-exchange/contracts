import hre from "hardhat";
import { TronWeb } from "tronweb";

/**
 * Owner-only administration of an already-deployed ElexaEscrow on TRON.
 *
 * Everything here is reachable without redeploying, which is the point: the
 * fee collector, the arbiter and the allow-lists are all mutable by design, so
 * rotating a key or adding a token is a transaction rather than a migration.
 * Redeploying would orphan every escrow already funded at the old address.
 *
 * Driven by environment variables rather than argv, because `hardhat run`
 * consumes its own arguments and there is no reliable way to pass extra ones
 * through. That also keeps it consistent with how the deploy script is
 * configured.
 *
 *   TRON_ADMIN_ACTION=show                       npm run tron:admin
 *   TRON_ADMIN_ACTION=set-fee-collector TRON_ADMIN_VALUE=T…  npm run tron:admin
 *   TRON_ADMIN_ACTION=set-arbiter       TRON_ADMIN_VALUE=T…  npm run tron:admin
 *   TRON_ADMIN_ACTION=set-token-allowed TRON_ADMIN_VALUE=T… TRON_ADMIN_FLAG=true npm run tron:admin
 *   TRON_ADMIN_ACTION=set-native-allowed TRON_ADMIN_FLAG=true npm run tron:admin
 *
 * Reads TRON_ESCROW_ADDRESS for the deployment to act on, and signs with
 * TRON_PRIVATE_KEY — which must be the contract's `owner`. That is checked
 * before anything is signed, because an owner-only call from the wrong key
 * reverts with an error that says nothing about ownership.
 */

const HOSTS: Record<string, { host: string; explorer: string }> = {
  mainnet: { host: "https://api.trongrid.io", explorer: "https://tronscan.org/#" },
  shasta: { host: "https://api.shasta.trongrid.io", explorer: "https://shasta.tronscan.org/#" },
};

const CALL_FEE_LIMIT = 100_000_000; // 100 TRX ceiling; these calls cost a fraction of it

async function main() {
  const networkName = (process.env.TRON_NETWORK ?? "shasta").trim().toLowerCase();
  const target = HOSTS[networkName];
  if (!target) {
    throw new Error(`Unknown TRON_NETWORK '${networkName}'. Expected: ${Object.keys(HOSTS).join(", ")}`);
  }

  const privateKey = required("TRON_PRIVATE_KEY").replace(/^0x/, "");
  const escrowAddress = required("TRON_ESCROW_ADDRESS");
  const action = (process.env.TRON_ADMIN_ACTION ?? "show").trim();

  const tronWeb = new TronWeb({
    fullHost: target.host,
    privateKey,
    headers: process.env.TRONGRID_API_KEY
      ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY }
      : undefined,
  });

  const caller = tronWeb.address.fromPrivateKey(privateKey);
  if (!caller) throw new Error("TRON_PRIVATE_KEY is not a valid 32-byte hex key.");
  if (!tronWeb.isAddress(escrowAddress)) {
    throw new Error(`TRON_ESCROW_ADDRESS is not a valid TRON address: ${escrowAddress}`);
  }

  const artifact = await hre.artifacts.readArtifact("ElexaEscrow");
  const escrow = await tronWeb.contract(artifact.abi, escrowAddress);

  const [owner, arbiter, feeCollector, nativeAllowed] = await Promise.all([
    escrow.owner().call(),
    escrow.arbiter().call(),
    escrow.feeCollector().call(),
    escrow.nativeAllowed().call(),
  ]);

  console.log(`network       TRON ${networkName}`);
  console.log(`escrow        ${escrowAddress}`);
  console.log(`caller        ${caller}`);
  console.log(`owner         ${base58(tronWeb, owner)}`);
  console.log(`arbiter       ${base58(tronWeb, arbiter)}`);
  console.log(`feeCollector  ${base58(tronWeb, feeCollector)}`);
  console.log(`nativeAllowed ${Boolean(nativeAllowed)}`);

  if (action === "show") return;

  // Checked here rather than left to revert on chain: an owner-only call from
  // the wrong key fails with a bare revert, and the most likely cause — a
  // TRON_PRIVATE_KEY that is the *arbiter's* rather than the owner's — is
  // invisible in that error.
  if (base58(tronWeb, owner) !== caller) {
    throw new Error(
      `${caller} is not the owner of this contract (${base58(tronWeb, owner)}). ` +
        `Owner-only calls must be signed with the owner's key.`,
    );
  }

  const txId = await run(tronWeb, escrow, action);

  console.log(`\nsent ${txId}`);
  console.log(`${target.explorer}/transaction/${txId}`);
  console.log("\nRe-run with TRON_ADMIN_ACTION=show once it confirms, to verify the new value.");
}

async function run(tronWeb: TronWeb, escrow: any, action: string): Promise<string> {
  const send = { feeLimit: CALL_FEE_LIMIT };

  switch (action) {
    case "set-fee-collector":
    case "set-arbiter": {
      const value = address(tronWeb, required("TRON_ADMIN_VALUE"));
      // Neither can be the zero address — the contract rejects that — but a
      // *wrong* address it will accept happily, and for the arbiter that means
      // no dispute can be resolved again until the owner fixes it.
      const method = action === "set-arbiter" ? "setArbiter" : "setFeeCollector";
      console.log(`\n${method}(${value})`);
      return escrow[method](value).send(send);
    }

    case "set-token-allowed": {
      const value = address(tronWeb, required("TRON_ADMIN_VALUE"));
      const allowed = flag();
      console.log(`\nsetTokenAllowed(${value}, ${allowed})`);
      return escrow.setTokenAllowed(value, allowed).send(send);
    }

    case "set-native-allowed": {
      const allowed = flag();
      console.log(`\nsetNativeAllowed(${allowed})`);
      return escrow.setNativeAllowed(allowed).send(send);
    }

    default:
      throw new Error(
        `Unknown TRON_ADMIN_ACTION '${action}'. Expected one of: show, set-fee-collector, ` +
          `set-arbiter, set-token-allowed, set-native-allowed.`,
      );
  }
}

/** tronweb returns addresses in 41-hex; everything a human reads is base58. */
function base58(tronWeb: TronWeb, value: unknown): string {
  const raw = typeof value === "string" ? value : String(value);
  return tronWeb.address.fromHex(raw) || raw;
}

function address(tronWeb: TronWeb, value: string): string {
  if (!tronWeb.isAddress(value)) {
    throw new Error(`TRON_ADMIN_VALUE is not a valid TRON address: ${value}`);
  }
  return value;
}

/** Only an explicit "true" enables. Anything else disables, including a typo. */
function flag(): boolean {
  return (process.env.TRON_ADMIN_FLAG ?? "").trim().toLowerCase() === "true";
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
