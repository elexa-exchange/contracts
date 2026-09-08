# ElexaEscrow on TON

The TON deployment of Elexa's non-custodial escrow. Same product as
`../contracts/ElexaEscrow.sol` — the seller locks funds against a trade
id, the platform is only an arbiter, and an abandoned trade refunds itself — but
not the same code, because TON is not an EVM chain and pretending otherwise is
how money gets lost here.

```
npm install
npm run build      # compile the Tact contract
npm test           # run it against a real TVM (@ton/sandbox)
```

## What is different from the EVM version, and why it matters

**Refusing a jetton transfer does not return the jettons.** This is the single
most important line in this directory. On EVM a failing `require` unwinds the
whole call, token transfer included. On TON the jettons have already arrived by
the time the contract hears about it, so a rejection that merely fails keeps
them. Every path that refuses a jetton funding therefore sends them back
explicitly (`refundJettons`), and there is a test named in shouting capitals to
stop anyone quietly "simplifying" it into a `require`.

Native funding *does* use `require`, and that is correct rather than
inconsistent: the TON is attached to the message being rejected, so bouncing
genuinely returns it.

**A jetton is not an ERC-20.** There is no central ledger and no
`transferFrom`. Every holder has their own jetton-wallet contract. The allow-list
is therefore keyed by *our own jetton wallet* for an asset, not by the jetton
master — the wallet's address is the only thing that appears on an incoming
message, and anyone can claim to be a master. `scripts/allow-asset.ts` takes the
master (which a human can verify on an explorer) and derives the wallet from it.

**Settled trades leave a tombstone.** Storage costs rent on TON for as long as
it exists, so a finished escrow is collapsed to its status alone. That keeps a
completed trade id permanently unusable — replaying one would let somebody lock
funds against a trade the application has already closed — without closed trades
accruing rent forever.

**Payouts are sent non-bounceable.** A TON wallet that has never received
anything is not deployed, which is entirely normal for a new account. A
bounceable payout to one would come straight back, leaving the escrow marked
settled and the money still here.

**A bounced jetton payout cannot be retried automatically.** A bounced message
carries only the first 224 bits of its body and a trade id alone is 256, so the
contract cannot tell which escrow a failed transfer belonged to. Rather than
guess, failures surface as a `JettonPayoutFailed` event for the indexer to raise,
and are recovered with `AdminJettonSweep`. The jettons are never lost — the
transfer simply did not happen — but a human has to move them.

**The contract pays rent out of the balance the escrows sit in.** `lockedNative`
tracks what belongs to sellers so that operating funds and escrowed funds can
never be spent as each other. `withdraw-surplus` is bounded by it plus a rent
floor, so a compromised owner key still cannot reach a single seller's escrow.

## Settings, and which file they come from

There is no `.env`. Each network has its own file, so no single edit can point a
mainnet deployment at testnet values:

```
.env.testnet          testnet settings
.env.mainnet          mainnet settings
.env.<network>.local  your own overrides, read first
.env                  optional, network-agnostic, read last
.env.example          the template — the only one that is committed
```

The network is chosen by the script you run — `npm run deploy:testnet` vs
`npm run deploy:mainnet` — and that choice is what selects the file. There is
deliberately no `TON_NETWORK` setting inside the files: it could only ever
disagree with the file's own name. Every script prints which file it read as its
first line; check it before confirming anything.

`scripts/env.ts` also rejects an address whose form does not match the network.
Testnet (`0Q…`/`kQ…`) and mainnet (`UQ…`/`EQ…`) forms of the same account differ
by one byte, both parse, and the contract stores either — so a testnet arbiter
pasted into `.env.mainnet` deploys cleanly and fails at the first dispute, with
real money already locked. That is the one mistake worth failing loudly on.

## Deploying to testnet

### 0. Build and test

```bash
cd contracts/ton
npm install
npm run build
npm test          # 37 tests against a real TVM — do not skip
```

### 1. Make two wallets

You need a **deployer** (pays for the deployment, becomes the owner) and an
**arbiter** (the key disputes are settled with). Keep them separate: the
owner key can change the arbiter, so it should live somewhere colder.

```bash
npm run wallet -- new     # run twice — deployer, then arbiter
```

Each run prints a mnemonic and an address. **TON mnemonics are not BIP-39** —
they share a wordlist but validate and derive differently, so a seed phrase from
another chain will not work and the script refuses it.

Fund both from **@testgiver_ton_bot** on Telegram (2 TON each is plenty). The
arbiter needs funding too: on TON a wallet is a *contract*, and an undeployed
one cannot send anything — its first outgoing message is what deploys it.

### 2. Deploy

Put the deployer's words, the arbiter address and the fee collector into
`.env.testnet` (copy `.env.example` if it is not there), then:

```bash
npm run deploy:testnet
```

It prints the escrow address and the values step 4 needs.

### 3. Allow-list the assets

A fresh deployment accepts **no asset at all**. That is deliberate — a
half-finished deploy should refuse funding rather than accept it on terms nobody
has checked.

Set `TON_ESCROW_ADDRESS` in `.env.testnet` to the address just printed, then:

```bash
npm run allow-asset:testnet -- native
npm run allow-asset:testnet -- jetton EQ…your-test-jetton-master
```

The `--` matters: without it npm eats the arguments rather than passing them on.

There is no official USDT on TON testnet, so for jetton testing you have to mint
your own (via [minter.ton.org](https://minter.ton.org) on testnet) and use that
master address.

`allow-asset.ts jetton` takes the **master** and derives the escrow's own jetton
wallet from it by calling `get_wallet_address` on the master — the contract can
only authenticate the wallet, but only the master is verifiable by a human.

### 4. Point an application at it

Whatever trades against the escrow needs three things recorded:

- the **escrow address**, raw form (`0:…`), as printed by the deploy script;
- the **starting point for indexing**, `0` for a fresh deployment. On TON this
  is a logical time (`lt`) rather than a block height — the per-account counter
  an indexer resumes from, not a chain-wide one;
- the **jetton master** of every asset you allow-listed. An allow-list entry
  with nothing on the application side to match it has nothing tradeable on it.

Dispute settlement needs the **arbiter's mnemonic**, and it must be the wallet
whose address you deployed with. Nothing checks this at startup and nothing
fails until the first dispute, so derive the address from those words — with
`npm run wallet -- show` — and compare it to `TON_ARBITER_ADDRESS` now.

A `TONCENTER_API_KEY` from toncenter.com is worth having on any component that
reads the chain; the anonymous tier is throttled to roughly a request a second.

### Things that fail quietly

- **Skipping step 3.** The contract sends the seller's jettons straight back
  with a `FundingRefunded` event, which the indexer logs as an error. Safe, but
  baffling if you have forgotten.
- **An unfunded arbiter wallet.** Everything works until the first dispute.
- **A mismatched arbiter address.** Same symptom, same moment.
- **A wallet-linking domain that does not match the origin.** TON Connect signs
  the real page origin into the proof, so linking fails with "signed for a
  different site" until the two agree.

## Deploying to mainnet

Same shape as testnet, with the differences that matter called out. Do not
change a testnet deployment into a mainnet one by editing values — fill in
`.env.mainnet` from `.env.example`, from scratch.

### 0. Prove it on testnet first, with a real jetton

The sandbox suite uses a stand-in for the jetton wallet, because what the escrow
authenticates is which address a notification came from and nothing about the
jetton itself. Real jettons still differ in gas cost and forward-payload
encoding. Run a full lifecycle on testnet — fund, mark paid, release, a timeout
refund, and a disputed resolution — against a jetton you minted, with the
indexer running, before spending anything here.

### 1. New wallets, not the testnet ones

```bash
npm run wallet:mainnet -- new     # run twice — deployer, then arbiter
```

`wallet:mainnet` differs from `wallet` only in the form it prints the address
in, but that is the form `.env.mainnet` requires: a `0Q…` testnet address is
rejected rather than deployed with.

Fund the deployer with about 2 TON — 0.05 for the deployment, `TON_ESCROW_RESERVE`
(0.5 by default) for the contract's operating balance, and roughly 0.05 per
asset you allow-list. Fund the arbiter too: a wallet on TON is a contract, and
an unfunded one cannot send, which you would discover at the first dispute.

### 2. Set the owner deliberately

`TON_OWNER_ADDRESS` is optional and defaults to the deploying wallet. On mainnet,
set it to something colder. The owner can change the arbiter, sweep surplus and
allow-list assets — and it **cannot be handed over afterwards**: the contract is
`Ownable`, not `OwnableTransferable`, and the owner is an init parameter, so a
different owner is a different contract address holding none of the escrows.
Getting this wrong means migrating, not fixing.

Note that the deployer still needs to be the one that allow-lists assets in
step 4, since those are owner-only messages — so either allow-list before
handing over, or send the messages from the cold wallet.

### 3. Deploy

```bash
npm run build
npm run deploy:mainnet
```

The first line of output says which file the settings came from. The script
checks the deployer's balance before broadcasting anything, refuses testnet-form
addresses, and warns if the owner defaults to the deploying key.

### 4. Allow-list assets

A fresh deployment accepts nothing. Set `TON_ESCROW_ADDRESS` in `.env.mainnet`
to the address just printed, then:

```bash
npm run allow-asset:mainnet -- native
npm run allow-asset:mainnet -- jetton EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs
```

That is USDT on TON, issued by Tether — `0:b113a994…3621dfe` in raw form, which
is the value an application stores for the asset. Verify it on tonviewer.com
anyway. An allow-listed impostor jetton is the cheapest way to get
users robbed, and allow-listing is the moment the contract starts being able to
hold other people's money.

### 5. Point an application at it

Same three values as on testnet — escrow address, a starting `lt` of `0`, and
the master of every allow-listed jetton — and the mainnet arbiter's words for
dispute settlement, not the testnet ones. A `TONCENTER_API_KEY` has to be a
mainnet key: testnet is a different endpoint and the key will not authenticate
against it.

Verify the arbiter address derived from those words matches what you deployed
with. Nothing checks it, and the first dispute is a bad time to find out:

```bash
npm run wallet:mainnet -- show "…arbiter words…"
```

### 6. Watch the operating balance

The contract pays storage rent out of its own balance, and a TON contract at
zero balance is frozen and eventually deleted — taking every open escrow's
bookkeeping with it. `npm run deploy:mainnet` is idempotent and tops the balance
back up to `TON_ESCROW_RESERVE`, so it is also the maintenance command.

## Testing

`npm test` runs the contract in `@ton/sandbox`, a real TON virtual machine. The
suite covers the full lifecycle on both native TON and jettons, every access
control boundary, and the refusal-refunds-jettons behaviour above.

**Not covered, and worth knowing before mainnet:** these tests use a stand-in
for the jetton wallet rather than a real jetton implementation, because what the
escrow authenticates is which address a notification came from and nothing about
the jetton itself. A real jetton's gas costs and forward-payload encoding should
still be exercised on testnet against the actual USDT master before any mainnet
deployment.
