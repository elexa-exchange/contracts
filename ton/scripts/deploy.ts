/**
 * Deploy ElexaEscrow to TON, then print what an application has to be told.
 *
 * Run with:
 *
 *   npm run build
 *   npm run deploy:testnet      # settings from .env.testnet
 *   npm run deploy:mainnet      # settings from .env.mainnet
 *
 * Deliberately does *not* allow-list anything. A fresh deployment accepts no
 * asset at all until an owner explicitly turns one on, which means a
 * half-finished deploy refuses funding rather than accepting it on terms nobody
 * has checked. Turning assets on is `scripts/allow-asset.ts`.
 */
// First import, and the order matters: ./env reads .env.<network> as a side
// effect of being loaded, and everything below — including the module-level
// RESERVE — expects process.env to be populated already. Nothing needs the
// secrets typed onto a command line, where they end up in shell history.
import { describeEnv, network, optional, parseAddress, required } from "./env";

import { mnemonicToPrivateKey } from "@ton/crypto";
import { toNano } from "@ton/core";
import { WalletContractV4 } from "@ton/ton";
import { ElexaEscrow } from "../build/ElexaEscrow_ElexaEscrow";
import { makeClient, spaceCalls, withRetry } from "./ton-client";

/**
 * TON the contract must keep for itself, as operating balance.
 *
 * This has to be sent *separately*, after deployment, and that is not a
 * stylistic choice. Tact's `Deployable` trait answers a `Deploy` message with
 * `DeployOk` using `SendRemainingValue` — so whatever value is attached to the
 * deployment is handed straight back, and the contract is left holding nothing.
 * A TON contract at zero balance is frozen by storage rent and eventually
 * deleted, taking every open escrow's bookkeeping with it.
 *
 * `receive("topup")` exists precisely for this: it accepts value and replies
 * with nothing, so the contract keeps it. It is credited as operating balance
 * only — `lockedNative` is untouched, so this is never confusable with a
 * seller's escrowed funds.
 */
const RESERVE = toNano(optional("TON_ESCROW_RESERVE") ?? "0.5");

/** Wait for the wallet's seqno to move past `from`, so the next send is valid. */
async function waitForSeqno(wallet: { getSeqno: () => Promise<number> }, from: number) {
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const seqno = await withRetry("seqno", () => wallet.getSeqno());
    if (seqno > from) return;
  }
  throw new Error(
    "The deployer wallet's seqno never advanced. Either it holds no TON, or the " +
      "message was rejected — check it on the explorer.",
  );
}

async function main() {
  console.log(`Environment: ${describeEnv()}`);
  const { client } = makeClient(network);

  const keyPair = await mnemonicToPrivateKey(required("TON_DEPLOYER_MNEMONIC").split(/\s+/));
  const wallet = client.open(
    WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey }),
  );
  const sender = wallet.sender(keyPair.secretKey);

  const arbiter = parseAddress("TON_ARBITER_ADDRESS", required("TON_ARBITER_ADDRESS"));
  const feeCollector = parseAddress(
    "TON_FEE_COLLECTOR_ADDRESS",
    required("TON_FEE_COLLECTOR_ADDRESS"),
  );

  // The owner is the deployer unless told otherwise. Worth overriding on
  // mainnet: the owner key can change the arbiter and sweep surplus, so it
  // belongs somewhere colder than the key that happens to be deploying.
  const ownerSetting = optional("TON_OWNER_ADDRESS");
  const owner = ownerSetting
    ? parseAddress("TON_OWNER_ADDRESS", ownerSetting)
    : wallet.address;

  if (network === "mainnet" && !ownerSetting) {
    // Not recoverable after the fact: the contract is `Ownable`, not
    // `OwnableTransferable`, so there is no message that hands ownership over —
    // and the owner is an init parameter, so a different owner is a different
    // address holding none of the escrows. Getting this wrong means migrating.
    console.log(
      "\nWARNING: TON_OWNER_ADDRESS is unset, so the deploying wallet becomes the owner\n" +
        "and stays the owner — this contract has no ownership transfer. The owner can\n" +
        "change the arbiter and sweep surplus, so on mainnet it should be a colder key\n" +
        "than the one deploying. Ctrl-C now if that is not what you want.\n",
    );
  }

  const escrow = client.open(await ElexaEscrow.fromInit(owner, arbiter, feeCollector));

  console.log(`Deploying ElexaEscrow to ${network}`);
  console.log(`  address      ${escrow.address.toString()}`);
  console.log(`  raw          ${escrow.address.toRawString()}`);
  console.log(`  owner        ${owner.toString()}`);
  console.log(`  arbiter      ${arbiter.toString()}`);
  console.log(`  feeCollector ${feeCollector.toString()}`);

  // Checked before anything is broadcast, because the alternative is finding
  // out from `waitForSeqno` thirty seconds later, as "the seqno never
  // advanced" — which reads like a network problem rather than an empty wallet.
  const deployerBalance = await withRetry("deployer balance", () =>
    client.getBalance(wallet.address),
  );
  await spaceCalls();
  const needed = RESERVE + toNano("0.2");
  console.log(`  deployer     ${wallet.address.toString({ testOnly: network !== "mainnet" })}`);
  console.log(`  its balance  ${Number(deployerBalance) / 1e9} TON`);
  if (deployerBalance < needed) {
    throw new Error(
      `The deployer wallet holds ${Number(deployerBalance) / 1e9} TON, and this needs about ` +
        `${Number(needed) / 1e9} (0.05 deployment, ${Number(RESERVE) / 1e9} operating reserve, ` +
        `the rest fees and one allow-list call).\n` +
        (network === "mainnet"
          ? "Send it TON from an exchange or another wallet."
          : "Top it up from @testgiver_ton_bot on Telegram."),
    );
  }

  const alreadyDeployed = await withRetry("deployment check", () =>
    client.isContractDeployed(escrow.address),
  );
  await spaceCalls();
  if (alreadyDeployed) {
    console.log("\nAlready deployed at this address — skipping deployment.");
    console.log("(The address is derived from owner/arbiter/feeCollector, so the");
    console.log(" same three inputs always produce the same contract.)");
  } else {
    const seqnoBefore = await withRetry("seqno", () => wallet.getSeqno());
    // The send itself is wrapped, not just the reads around it: `send` makes its
    // own RPC calls — a deployment check to decide whether to attach the
    // state-init, then the seqno and the broadcast — and any of them can be
    // rate-limited.
    //
    // Retrying a send is safe here because the wallet signs against a specific
    // seqno: if a broadcast did get through before the error, the retry carries
    // the same seqno and the wallet ignores it as a replay.
    await withRetry("deploy", () =>
      escrow.send(
        sender,
        // Small: `Deployable` returns the remainder anyway, so a large value
        // here would just make a round trip. The reserve goes in the topup.
        { value: toNano("0.05") },
        { $$type: "Deploy", queryId: 0n },
      ),
    );
    console.log("\nDeployment sent, waiting for it to confirm…");
    await waitForSeqno(wallet, seqnoBefore);
  }

  // Always topped up, deployed now or previously: the check that matters is
  // whether the contract currently holds enough to pay its rent, not whether
  // this particular run created it.
  const balance = (
    await withRetry("balance", () => client.getContractState(escrow.address))
  ).balance;
  await spaceCalls();

  if (balance < RESERVE) {
    const seqnoBefore = await withRetry("seqno", () => wallet.getSeqno());
    console.log(`Topping up to ${Number(RESERVE) / 1e9} TON of operating balance…`);
    await withRetry("topup", () =>
      escrow.send(sender, { value: RESERVE - balance }, "topup"),
    );
    await waitForSeqno(wallet, seqnoBefore);
  }

  // Reported, not enforced. By this point the deployment and topup have either
  // landed or not, and a read that fails here changes nothing — so a flaky RPC
  // must not turn a successful deployment into a non-zero exit and leave an
  // operator thinking they have to start over.
  try {
    const finalBalance = (
      await withRetry("balance", () => client.getContractState(escrow.address))
    ).balance;
    console.log(`\nDeployed. Operating balance: ${Number(finalBalance) / 1e9} TON`);
    if (finalBalance < RESERVE / 2n) {
      console.log(
        "\nWARNING: the contract is holding very little. Storage rent will freeze\n" +
          "and then delete it. Re-run this script before letting anyone fund an\n" +
          "escrow against it.",
      );
    }
  } catch {
    console.log(
      `\nDeployed. Could not read the final balance — check it on the explorer:\n` +
        `  https://${network === "mainnet" ? "" : "testnet."}tonviewer.com/${escrow.address.toString()}`,
    );
  }

  // Worth recording as configuration rather than rediscovering later. The
  // second value is a logical time (lt) on TON rather than a block height —
  // the per-account counter an indexer resumes from. 0 is right for a fresh
  // deployment: there is no history before it to skip past.
  console.log("\nDeployment:\n");
  console.log(`  network        ton ${network}`);
  console.log(`  address        ${escrow.address.toRawString()}`);
  console.log(`  deploy lt      0`);
  console.log(
    `\nThen allow-list the assets you intend to trade — until you do, the ` +
      `contract\nrefuses every funding attempt. See scripts/allow-asset.ts.`,
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
