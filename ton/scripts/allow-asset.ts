/**
 * Turn on an asset the escrow may hold.
 *
 * A fresh deployment accepts nothing. This is the step that changes that, and
 * it is separate from deployment on purpose: allow-listing is the moment a
 * contract starts being able to hold other people's money, and it should be a
 * decision someone makes rather than a side effect of shipping.
 *
 * Settings come from .env.<network>, and the network is the script you run:
 *
 *   npm run allow-asset:testnet -- native
 *   npm run allow-asset:mainnet -- native
 *
 * A jetton — note it takes the *jetton master*, and derives our own jetton
 * wallet from it, because the wallet is what the contract can authenticate but
 * the master is what a human can verify on an explorer:
 *
 *   npm run allow-asset:mainnet -- jetton EQC…usdt-master
 */
// First import, and the order matters: ./env reads .env.<network> as a side
// effect of being loaded, and everything below expects process.env to be
// populated already. Nothing needs the secrets typed onto a command line, where
// they end up in shell history.
import { describeEnv, network, parseAddress, required } from "./env";

import { mnemonicToPrivateKey } from "@ton/crypto";
import { Address, beginCell, toNano } from "@ton/core";
import { TonClient, WalletContractV4 } from "@ton/ton";
import { ElexaEscrow } from "../build/ElexaEscrow_ElexaEscrow";
import { makeClient, withRetry } from "./ton-client";

/**
 * Ask a jetton master which wallet address it would use for `owner`.
 *
 * Derived from the master rather than assumed, because the derivation depends
 * on the master's own code — jettons are free to implement it differently, and
 * guessing would allow-list an address that never sends us anything, leaving
 * every funding attempt silently ignored.
 */
async function jettonWalletFor(client: TonClient, master: Address, owner: Address) {
  const result = await client.runMethod(master, "get_wallet_address", [
    { type: "slice", cell: beginCell().storeAddress(owner).endCell() },
  ]);
  return result.stack.readAddress();
}

async function main() {
  const [mode, masterArg] = process.argv.slice(2);
  if (mode !== "native" && mode !== "jetton") {
    throw new Error("Usage: allow-asset.ts <native|jetton> [jettonMasterAddress]");
  }

  console.log(`Environment: ${describeEnv()}`);
  const { client } = makeClient(network);

  const keyPair = await mnemonicToPrivateKey(required("TON_DEPLOYER_MNEMONIC").split(/\s+/));
  const wallet = client.open(
    WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey }),
  );
  const sender = wallet.sender(keyPair.secretKey);

  const escrowAddress = parseAddress("TON_ESCROW_ADDRESS", required("TON_ESCROW_ADDRESS"));
  const escrow = client.open(ElexaEscrow.fromAddress(escrowAddress));

  if (mode === "native") {
    await withRetry("allow native", () =>
      escrow.send(
        sender,
        { value: toNano("0.05") },
        { $$type: "SetNativeAllowed", allowed: true },
      ),
    );
    console.log("Native TON allowed.");
    return;
  }

  if (!masterArg) throw new Error("A jetton master address is required");
  const master = parseAddress("the jetton master", masterArg);
  const ourWallet = await withRetry("jetton wallet lookup", () =>
    jettonWalletFor(client, master, escrowAddress),
  );

  console.log(`Jetton master  ${master.toString()}`);
  console.log(`Our wallet     ${ourWallet.toString()}`);

  await withRetry("allow jetton", () =>
    escrow.send(
      sender,
      { value: toNano("0.05") },
      {
        $$type: "SetJettonAllowed",
        jettonWallet: ourWallet,
        jettonMaster: master,
        allowed: true,
      },
    ),
  );

  console.log(
    `\nAllowed. Register the same master wherever the application stores its ` +
      `tradeable\nassets — the raw form is what a contract call returns:\n\n` +
      `  ${master.toRawString()}\n`,
  );
}

main().catch((error: unknown) => {
  // The message, not the object. An axios failure stringifies to forty lines of
  // request internals with the actual cause buried in the middle, and every
  // error this script raises deliberately says what to do about it.
  const message = (error as { message?: string })?.message ?? String(error);
  console.error(`\n${message}`);
  if (process.env.TON_DEBUG) console.error(error);
  else console.error("(set TON_DEBUG=1 for the full stack)");
  process.exit(1);
});
