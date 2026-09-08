# Elexa contracts

Non-custodial escrow for Elexa P2P trades, on BNB Smart Chain (chain 56,
testnet 97) and TRON (mainnet, Shasta testnet).

**One contract, two chains.** TRON's TVM executes the bytecode solc already
emits for BSC, so `ElexaEscrow.sol` is deployed to both from the *same*
compiled artifact — there is no TRON-specific Solidity here and no second
compiler. A separate contracts project would mean a forked copy of the source
that drifts from the audited one the first time either side is patched.

## What the contract guarantees

`ElexaEscrow` replaces custodial balance bookkeeping entirely. The seller locks
BEP-20 tokens against a trade id; Elexa holds only an arbiter key.

Concretely, the arbiter key **cannot**:

- move funds to itself, the owner, or any address other than the trade's buyer,
  seller, or the fee collector;
- touch a trade that neither party has disputed;
- raise the fee after funding — the cut is fixed when the escrow is created and
  capped at `MAX_FEE_BPS` (10%);
- strand funds by pausing — `pause()` blocks new escrows only, never settlement.

And the seller's money does not depend on Elexa staying online: an undisputed
escrow becomes refundable after its payment window, and `refundAfterTimeout` is
permissionless, so anyone can push the refund through.

## State machine

```
              fundEscrow (seller)
                     │
                     ▼
                  Funded ──────── release (seller) ─────────► Released
                   │  │
   markPaid ───────┘  └─────── refundAfterTimeout (anyone,   ► Refunded
   (buyer or                    after deadline)
    arbiter)
      │
      ▼
     Paid ────────────── release (seller) ────────────────────► Released
      │
      │  dispute (buyer or seller; also reachable from Funded)
      ▼
   Disputed ─┬──── release (seller, conceding) ───────────────► Released
             └──── resolve (arbiter, either way) ─────────────► Released / Refunded
```

`markPaid` exists so a buyer who has sent fiat can stop the seller running the
clock out. The arbiter may call it on the buyer's behalf, because a buyer
holding USDT but no gas coin (BNB on BSC, TRX on TRON) has no way to pay for
the transaction themselves — and the call is harmless by construction: it can
only delay a refund, never move money.

Fees are charged only when the buyer is paid. Refunds return the full locked
amount to the seller.

## Commands

```bash
npm install
npm run build             # compile
npm test                  # 39 tests covering the guarantees above
npm run export-abi        # refresh abi/ElexaEscrow.json (see ABI_EXPORT_* in .env.example)

npm run deploy:testnet    # BSC testnet   — settings from .env.testnet
npm run deploy:mainnet    # BSC mainnet   — settings from .env.mainnet

npm run deploy:tron-shasta   # TRON Shasta  — the TRON_* half of .env.testnet
npm run deploy:tron          # TRON mainnet — the TRON_* half of .env.mainnet

npm run tron:admin           # owner-only calls against the Shasta deployment
npm run tron:admin:mainnet   # …and against the mainnet one
```

## Settings, and which file they come from

There is no `.env`. Testnet and mainnet have separate files so that no single
edit can point a mainnet deployment at testnet values, or vice versa:

```
.env.testnet         BSC testnet + TRON Shasta
.env.mainnet         BSC mainnet + TRON mainnet
.env.<target>.local  your own overrides, read first
.env                 optional, target-agnostic, read last
.env.example         the template — the only one that is committed
```

The npm scripts choose by setting `DEPLOY_ENV`. Running Hardhat by hand, `env.ts`
infers it from `--network` (`bsc` → mainnet, `bscTestnet` → testnet) or from
`TRON_NETWORK`, defaulting to testnet. Every deploy script prints which file it
read as its first line — check it before confirming anything.

TON is not covered by any of this. It is a different toolchain in
`contracts/ton`, with its own `.env.testnet` / `.env.mainnet`.

## Deploying to TRON

`scripts/deploy-tron.ts` reads Hardhat's build output and deploys it with
tronweb. Nothing is recompiled, so BSC and TRON cannot end up running different
contracts.

One compiler setting is load-bearing: **`evmVersion: "paris"` in
`hardhat.config.ts`**. At shanghai, solc emits 122 `PUSH0` instructions in this
contract, an opcode the TVM does not implement — and TRON rejects such a
contract *at deployment*, with an error naming neither the opcode nor the
offset. It reads exactly like a bad endpoint, a low fee limit, or an unfunded
deployer. `test/TvmCompatibility.test.ts` pins the setting so a Solidity
version bump fails on the right line instead.

Everything else that differs is in the script rather than the contract: base58
addresses, a `feeLimit` ceiling in SUN instead of a gas price, and TRON's
`userFeePercentage` set to 100 so callers pay their own energy — which is what
the EVM does and what every wallet expects.

## Before mainnet

0. **Fill in `.env.mainnet` from scratch.** Copy nothing across from
   `.env.testnet` — a key that has been used on a testnet has usually also been
   pasted into a faucet, a chat, or a CI log, and is not a key to hold real
   funds with.
1. **Get it audited.** The test suite proves the intended behaviour; it does not
   prove the absence of unintended behaviour.
2. **Verify every token address on BscScan / tronscan** before putting it in
   `ALLOWED_TOKENS` or `TRON_ALLOWED_TOKENS`. An allow-listed impostor token is
   the cheapest possible way to get users robbed, and base58 addresses are
   considerably harder to eyeball than 0x-hex.
3. **Consider a Safe for `ARBITER_ADDRESS`.** A hot arbiter key is the weakest
   link left in this design — it can't steal, but it can settle disputes wrongly.
4. **Run a full trade on testnet first**, including a timeout refund and a
   disputed resolution, with the indexer running against it. Do this once per
   chain: BSC testnet and TRON Shasta exercise different indexers and different
   frontend connectors, and only the contract is shared.
5. **Confirm the arbiter address matches on TRON.** The deploy script takes
   `TRON_ARBITER_ADDRESS` as a string, while whatever settles disputes derives
   its own address from a private key. If the two disagree, everything works
   until the first dispute — which then nobody can resolve. Derive the address
   from that key and compare it by hand before deploying.
