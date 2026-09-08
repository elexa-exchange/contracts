/**
 * Generate a TON wallet, or show the address of one you already have.
 *
 * Exists to close a specific footgun. The escrow only accepts `Resolve` from
 * the arbiter address it was deployed with, while whatever settles disputes
 * signs with the arbiter's mnemonic — two settings in two places that must
 * name the same wallet. If they disagree, nothing complains: linking works, funding works,
 * releases work, and the mismatch surfaces at the first dispute, when someone's
 * money is already locked and a support agent is trying to settle it.
 *
 * So derive the address from the mnemonic rather than typing it twice.
 *
 *   npm run wallet -- new                    # generate one (testnet form)
 *   npm run wallet:mainnet -- new            # generate one (mainnet form)
 *   npm run wallet -- show "24 words…"       # show an existing one
 *
 * The network only changes how the address is *displayed* — the same words are
 * the same account on both — but the displayed form is what goes into
 * TON_ARBITER_ADDRESS, and the mainnet scripts reject a testnet-form address.
 *
 * Uses wallet v4R2. Whatever signs on the arbiter's behalf must use the same
 * version: a different one derives a different address from the same words.
 */
// First import, and the order matters: ./env reads .env.<network> as a side
// effect of being loaded, so `show` with no argument can fall back to the
// TON_ARBITER_MNEMONIC in the file rather than needing it on a command line,
// where it would end up in shell history.
import { network } from "./env";

import { mnemonicNew, mnemonicToPrivateKey, mnemonicValidate } from "@ton/crypto";
import { WalletContractV4 } from "@ton/ton";

async function addressFor(words: string[]) {
  const keyPair = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  return wallet.address;
}

async function main() {
  const [mode, ...rest] = process.argv.slice(2);

  let words: string[];
  if (mode === "new") {
    words = await mnemonicNew();
  } else if (mode === "show") {
    const supplied = rest.join(" ").trim() || process.env.TON_ARBITER_MNEMONIC || "";
    if (!supplied) {
      throw new Error(
        'Pass the mnemonic: scripts/wallet.ts show "24 words…", or set TON_ARBITER_MNEMONIC.',
      );
    }
    words = supplied.split(/\s+/);
    if (words.length !== 24 && words.length !== 12) {
      throw new Error(`Expected 12 or 24 words, got ${words.length}.`);
    }

    // Checked here because `mnemonicToPrivateKey` does not check: it will
    // cheerfully derive a key from any 24 words, including a BIP-39 phrase.
    //
    // TON mnemonics are *not* BIP-39. They share a wordlist but validity is a
    // hash condition on the phrase, and the key derivation differs. A BIP-39
    // seed phrase therefore produces a perfectly usable-looking address here and
    // is then rejected outright by any signer that validates — leaving an
    // escrow deployed with an arbiter address nothing can sign for. Exactly the
    // mismatch this script exists to prevent, so it has to fail here.
    if (!(await mnemonicValidate(words))) {
      throw new Error(
        "Not a valid TON mnemonic. TON does not use BIP-39 — a seed phrase from " +
          "another chain will not work here. Generate one with `scripts/wallet.ts new`.",
      );
    }
  } else {
    throw new Error("Usage: scripts/wallet.ts <new|show> [mnemonic]");
  }

  const address = await addressFor(words);
  const testnet = network !== "mainnet";
  // Non-bounceable is the form to fund and to paste into a wallet app: a
  // bounceable transfer to an address with no contract deployed yet comes
  // straight back, and a fresh wallet has none until its first outgoing message.
  const friendly = address.toString({
    urlSafe: true,
    bounceable: false,
    testOnly: testnet,
  });

  // Labelled with the environment variables each value goes into, rather than
  // with what it is. "Mnemonic" and "Address" describe them correctly and still
  // leave you holding two strings and four settings to match up; naming the
  // settings removes the guess.
  const rule = "─".repeat(72);
  console.log(`\n${rule}`);

  if (mode === "new") {
    console.log("THE 24 WORDS BELOW ARE THE MNEMONIC — the wallet's only backup.");
    console.log("Write them down now. They cannot be recovered or regenerated.\n");
  }

  console.log("  Use as TON_DEPLOYER_MNEMONIC or TON_ARBITER_MNEMONIC:\n");
  // Wrapped at eight words a line so it is readable and transcribable, and so a
  // terminal does not reflow it into something ambiguous.
  for (let i = 0; i < words.length; i += 8) {
    console.log(`    ${words.slice(i, i + 8).join(" ")}`);
  }

  console.log("\n  Use as TON_ARBITER_ADDRESS (and send test TON here):\n");
  console.log(`    ${friendly}`);
  console.log(`\n  Same account, raw form (what a contract call returns):\n`);
  console.log(`    ${address.toRawString()}`);
  console.log(`${rule}\n`);

  console.log(
    testnet
      ? "Testnet. Fund the address from @testgiver_ton_bot on Telegram — a wallet\n" +
          "on TON is a contract, and an unfunded one cannot send anything."
      : "MAINNET. Fund the address before the first dispute — an unfunded wallet\n" +
          "cannot send, and that is the moment you would find out.",
  );
}

main().catch((error) => {
  console.error(String(error.message ?? error));
  process.exit(1);
});
