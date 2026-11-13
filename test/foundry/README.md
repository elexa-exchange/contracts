# Foundry invariant / fuzz / fork suite

This suite sits alongside the Hardhat tests in `test/*.ts`. It does **not** replace them.

Compiler pins match Hardhat: Solidity `0.8.24`, optimizer `200` runs, `evm_version = "paris"`, OpenZeppelin `5.6.1` from `node_modules`.

## How to run

```bash
npm install
forge install foundry-rs/forge-std --no-commit
npm test          # Hardhat (39 tests)
forge test -vvv   # Foundry unit + state + invariant + fork
```

Optional live fork (BSC):

```bash
set BSC_RPC_URL=https://bsc-dataseed.bnbchain.org   # Windows
forge test --match-path test/foundry/ElexaEscrow.fork.t.sol -vvv
```

If the RPC is unreachable, the fork test calls `vm.skip`. A local bytecode-size sanity check always runs.

## Live deployment checked

- Chain: BSC (56)
- Escrow: [`0xA69EaDF28f0B5c97A9E8110e38e511E0Ba160cCB`](https://bscscan.com/address/0xA69EaDF28f0B5c97A9E8110e38e511E0Ba160cCB)
- Review commit: `2c2ee48c97163bdaa35334355ff487a2d2446d4e`
- At suite authoring time, locally compiled runtime (metadata stripped) was expected to match the live BSC runtime (prompt baseline: 7497 → 7444 bytes). Re-confirm with `ElexaEscrow.fork.t.sol`.

## Trust-page claims → tests

Source: [https://elexa.exchange/trust](https://elexa.exchange/trust) (“What Elexa cannot do to your funds” and settlement claims).

| Claim (quoted) | Enforced by | Proven by |
|---|---|---|
| “There is no Elexa-held balance, no deposit step, and no account we credit you on.” / funds locked per trade | `fundEscrow` / `fundEscrowNative` + per-`tradeId` accounting | `invariant_openEscrowsAreFullyBacked`, `invariant_noReplayOrCrossTradeSpend` |
| “It cannot pay itself. The contract only ever pays the trade's buyer, the trade's seller, or the fee collector.” | `_payBuyer`, `_paySeller`, `_cancelToSeller`, `_send` | `invariant_payoutsOnlyToBuyerSellerOrFeeCollector`, `invariant_releaseSplitsFeeCorrectly`, `invariant_refundsAndCancelsTakeNoFee` |
| “It cannot touch an undisputed trade. Until the buyer or seller explicitly opens a dispute, the arbiter has no authority over the escrow at all” | `resolve` requires `Status.Disputed`; `onlyArbiter` | `invariant_resolveOnlyWhenDisputed`, `test_Funded_resolve_BadStatus`, `test_Paid_resolve_BadStatus` |
| “It cannot raise the fee. The cut is fixed when the escrow is funded and is rejected outright above 10%” | `_record` `FeeTooHigh` / `MAX_FEE_BPS` | `invariant_feeNeverExceedsTenPercent`, `invariant_feeAmountIsImmutableAfterFunding`, `test_feeExactTenPercent*`, `test_feeTenPercentPlusOneWei*` |
| “It cannot strand your money by pausing. Pausing blocks new escrows only” | `whenNotPaused` only on funding | `invariant_pauseDoesNotTrapOpenEscrows`, `test_Paused_*`, `test_pauseAllowsSettlementPaths` |
| “It cannot stop a refund. Once the payment window lapses on an undisputed escrow, the refund is permissionless” | `refundAfterTimeout` (no access control; `Funded` only) | `invariant_timeoutRefundIsPermissionlessAndWhole`, `test_Funded_refundAfterTimeout_ok` |
| Payment window “between 15 minutes and 30 days” | `MIN_PAYMENT_WINDOW` / `MAX_PAYMENT_WINDOW` in `_record` | `test_windowExactBounds`, `test_windowExactBoundsNative` |
| “no fee is taken on a refund” / fee only when buyer is paid | `_paySeller` / `_cancelToSeller` send full `amount`; fee only in `_payBuyer` | `invariant_refundsAndCancelsTakeNoFee`, `invariant_releaseSplitsFeeCorrectly` |
| “The seller confirms… and releases. The contract pays the buyer directly, minus the fee fixed at funding.” | `release` → `_payBuyer` | `invariant_releaseSplitsFeeCorrectly`, state tests `*_release_*` |

### Honest caveats (documented, not filed as bugs)

| Nuance | Why it matters | Test |
|---|---|---|
| Seller may `release` from `Funded` without `markPaid` | Contract allows it; product UI may imply two-step confirmation | `test_sellerReleaseFromFundedWithoutMarkPaid` |
| Arbiter may `markPaid` on an undisputed `Funded` trade | Trust page says arbiter has “no authority” until dispute — `markPaid` does not move funds but **does** freeze the refund clock | `test_arbiterMarkPaidBlocksTimeoutRefund` |
| `buyerCancel` is not listed on the trust page | Same money movement as refund, different event (`Cancelled`) | `test_Funded_buyerCancel_ok`, `test_nativeBuyerCancel` |
| `feeCollector` is read at settlement, not snapshotted at funding | Owner can redirect the fee mid-flight; fee **amount** stays fixed | `test_feeCollectorChangeMidFlightRedirectsFee` |
| Paid/Disputed trades need seller `release` or arbiter `resolve` if Elexa/seller go offline | Timeout refund is **Funded-only** by design | state matrix `Paid_*` / `Disputed_*` |
| Rejecting native buyer after `markPaid` | `release` / `resolve(true)` revert `NativeTransferFailed`; unwind via `resolve(false)` | `test_rejectingNativeBuyerAfterMarkPaid` |

## Files

| File | Role |
|---|---|
| `Handler.sol` | Bounded invariant caller (only `targetContract`) |
| `ElexaEscrow.invariant.t.sol` | Named trust-page invariants |
| `ElexaEscrow.states.t.sol` | Status × function transition matrix |
| `ElexaEscrow.unit.t.sol` | Bounds, pause, fee-collector, native edge cases |
| `ElexaEscrow.fork.t.sol` | BSC bytecode + config asserts |

Hardhat suite remains in `test/ElexaEscrow.test.ts` and `test/TvmCompatibility.test.ts`.
