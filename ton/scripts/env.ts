/**
 * Per-network environment loading for the TON scripts.
 *
 * There used to be a single `.env` holding testnet values, which is fine right
 * up until the day there is a mainnet to deploy to. Then the same file has to
 * hold two sets of secrets, and the failure mode is not a broken script — it is
 * a deployment that succeeds with the wrong wallet.
 *
 * So the network picks the file, and the network is chosen explicitly:
 *
 *   npm run deploy:testnet     ->  TON_NETWORK=testnet  ->  .env.testnet
 *   npm run deploy:mainnet     ->  TON_NETWORK=mainnet  ->  .env.mainnet
 *
 * Files are read in this order, and the first value wins (dotenv never
 * overwrites something already set):
 *
 *   1. the real environment          — CI secrets, one-off overrides
 *   2. .env.<network>.local          — your own machine, never committed
 *   3. .env.<network>                — the deployment's settings
 *   4. .env                          — optional shared, network-agnostic bits
 *
 * `.env` is deliberately last and deliberately optional. Anything network
 * specific — a mnemonic, an arbiter, a contract address — belongs in the
 * network file, where it cannot be picked up by the other network.
 */
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { Address } from "@ton/core";

export type TonNetwork = "mainnet" | "testnet";

/** contracts/ton — the env files sit next to package.json, not next to this file. */
const ROOT = path.resolve(__dirname, "..");

/**
 * Which network we are pointed at.
 *
 * Strict, where the scripts used to treat "anything that is not mainnet" as
 * testnet. That was a safe default when testnet was the only target; with a
 * mainnet file present it becomes a hazard in the other direction, because
 * `TON_NETWORK=mainet` (one 'n') would quietly load testnet settings and the
 * operator would be told the deployment succeeded.
 */
function resolveNetwork(): TonNetwork {
  const raw = (process.env.TON_NETWORK ?? "").trim().toLowerCase();
  if (raw === "mainnet") return "mainnet";
  if (raw === "testnet" || raw === "") return "testnet";
  throw new Error(
    `TON_NETWORK must be "mainnet" or "testnet" — got "${process.env.TON_NETWORK}". ` +
      `Use \`npm run deploy:mainnet\` / \`npm run deploy:testnet\` rather than setting it by hand.`,
  );
}

export const network: TonNetwork = resolveNetwork();

/** Files actually found, most specific first. Printed by the scripts. */
export const loadedFiles: string[] = [];

for (const name of [`.env.${network}.local`, `.env.${network}`, ".env"]) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) continue;
  dotenv.config({ path: file });
  loadedFiles.push(name);
}

if (loadedFiles.length === 0) {
  // A warning rather than an error: `wallet.ts new` is how you *bootstrap* a
  // network, and it has nothing to read yet. Anything that actually needs a
  // setting fails on `required()` below, which names the missing file.
  console.log(
    `No .env.${network} in contracts/ton — copy .env.example to it and fill it in.\n`,
  );
}

// Pin it, so a script reading process.env.TON_NETWORK directly (and the files
// themselves, which may not set it) agrees with what we resolved.
process.env.TON_NETWORK = network;

/** Read a setting that must be present, treating blank as absent. */
export function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required — set it in contracts/ton/.env.${network}.`,
    );
  }
  return value;
}

/** Read an optional setting, treating blank as absent. */
export function optional(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * Parse an address and check it belongs to the network we are deploying to.
 *
 * A TON user-friendly address carries a test-only flag in its tag byte: the
 * same account is `0Q…`/`kQ…` on testnet and `UQ…`/`EQ…` on mainnet. Both parse,
 * and the contract will happily store either, so pasting last week's testnet
 * arbiter into `.env.mainnet` produces a working deployment with an arbiter
 * nobody can sign for — discovered at the first dispute, with real money locked.
 *
 * Raw form (`0:abc…`) carries no flag and is accepted as-is; there is nothing
 * to check.
 */
export function parseAddress(name: string, value: string): Address {
  let parsed: Address;
  let isTestOnly: boolean;

  try {
    const friendly = Address.parseFriendly(value);
    parsed = friendly.address;
    isTestOnly = friendly.isTestOnly;
  } catch {
    // Not friendly form — either raw (fine) or malformed (Address.parse says so).
    return Address.parse(value);
  }

  if (network === "mainnet" && isTestOnly) {
    throw new Error(
      `${name} is a testnet-only address (${value}) but TON_NETWORK=mainnet.\n` +
        `Testnet and mainnet forms of the same account differ only in one byte, so this is\n` +
        `almost always a value copied over from .env.testnet. Use the mainnet (UQ…/EQ…) form\n` +
        `of the address you actually control on mainnet.`,
    );
  }
  if (network === "testnet" && !isTestOnly) {
    console.log(
      `Note: ${name} is in mainnet form (${value}) while deploying to testnet. It will work,\n` +
        `but check it is the wallet you meant.\n`,
    );
  }

  return parsed;
}

/** One line saying where the settings came from, so a wrong file is visible. */
export function describeEnv(): string {
  return `${network} (from ${loadedFiles.join(", ")})`;
}
