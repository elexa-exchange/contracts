/**
 * Per-network environment loading for the BSC and TRON deployment scripts.
 *
 * There used to be a single `.env` holding testnet values, which is fine right
 * up until the day there is a mainnet to deploy to. Then the same file has to
 * hold two sets of secrets, and the failure mode is not a broken script — it is
 * a deployment that succeeds with the wrong key, or a mainnet contract
 * allow-listing a testnet token address that anyone can mint.
 *
 * So the target picks the file:
 *
 *   npm run deploy:testnet / deploy:tron-shasta   ->  .env.testnet
 *   npm run deploy:mainnet / deploy:tron          ->  .env.mainnet
 *
 * Files are read in this order, and the first value wins (dotenv never
 * overwrites something already set):
 *
 *   1. the real environment      — CI secrets, one-off overrides
 *   2. .env.<target>.local       — your own machine, never committed
 *   3. .env.<target>             — the deployment's settings
 *   4. .env                      — optional shared, network-agnostic bits
 *
 * Imported by hardhat.config.ts, which Hardhat loads before any script, so
 * every entry point gets this without having to remember it.
 *
 * TON is not here. It is a different toolchain in contracts/ton, with its own
 * .env.<network> files and its own scripts/env.ts.
 */
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

export type DeployTarget = "mainnet" | "testnet";

/** Hardhat network name -> which set of settings it should be run with. */
const HARDHAT_NETWORK_TARGETS: Record<string, DeployTarget> = {
  bsc: "mainnet",
  bscTestnet: "testnet",
};

/** TRON_NETWORK -> the same. */
const TRON_NETWORK_TARGETS: Record<string, DeployTarget> = {
  mainnet: "mainnet",
  shasta: "testnet",
};

/**
 * Which set of settings to load.
 *
 * The npm scripts set DEPLOY_ENV explicitly, so in normal use this is not an
 * inference at all. The rest is for `npx hardhat run … --network bsc` typed by
 * hand, where guessing from the network beats loading testnet secrets and
 * failing halfway through a mainnet deployment.
 */
function resolveTarget(): DeployTarget {
  const explicit = process.env.DEPLOY_ENV?.trim().toLowerCase();
  if (explicit === "mainnet" || explicit === "testnet") return explicit;
  if (explicit) {
    throw new Error(`DEPLOY_ENV must be "mainnet" or "testnet" — got "${process.env.DEPLOY_ENV}".`);
  }

  // `--network <name>`, as Hardhat itself parses it. `hardhat` and `localhost`
  // are deliberately unmapped: the TRON scripts pass `--network hardhat` purely
  // to satisfy the CLI, and TRON_NETWORK below is what actually decides.
  const flag = process.argv.indexOf("--network");
  const networkName = flag >= 0 ? process.argv[flag + 1] : undefined;
  if (networkName && HARDHAT_NETWORK_TARGETS[networkName]) {
    return HARDHAT_NETWORK_TARGETS[networkName];
  }

  const tron = process.env.TRON_NETWORK?.trim().toLowerCase();
  if (tron && TRON_NETWORK_TARGETS[tron]) return TRON_NETWORK_TARGETS[tron];

  return "testnet";
}

export const target: DeployTarget = resolveTarget();

/** Files actually found, most specific first. Printed by the deploy scripts. */
export const loadedFiles: string[] = [];

for (const name of [`.env.${target}.local`, `.env.${target}`, ".env"]) {
  const file = path.join(__dirname, name);
  if (!fs.existsSync(file)) continue;
  dotenv.config({ path: file });
  loadedFiles.push(name);
}

if (loadedFiles.length === 0) {
  // A warning, not an error: `hardhat compile` and `hardhat test` need no
  // settings at all, and failing them because a deployment file is missing
  // would be obstructive. The deploy scripts fail on their own missing values.
  console.log(`No .env.${target} in contracts/ — copy .env.example to it before deploying.\n`);
}

/** One line saying where the settings came from, so a wrong file is visible. */
export function describeEnv(): string {
  return `${target} (from ${loadedFiles.join(", ") || "no file"})`;
}

/**
 * Read an optional setting, treating blank as unset.
 *
 * `??` is wrong here: a key present-but-empty in the file (`BSC_RPC_URL=`,
 * which is exactly how .env.example ships) reaches us as "" rather than
 * undefined, so `??` keeps the empty string and Hardhat fails with HH117
 * instead of using the public endpoint.
 */
export function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}
