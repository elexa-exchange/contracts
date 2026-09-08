import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Address, beginCell, Cell, toNano } from "@ton/core";
import "@ton/test-utils";
import { ElexaEscrow, storeJettonTransfer } from "../build/ElexaEscrow_ElexaEscrow";

/**
 * ElexaEscrow on TON, exercised against a real TVM.
 *
 * These run in @ton/sandbox — an actual TON virtual machine, not a mock — so
 * every assertion here is about what the compiled contract genuinely does with
 * messages, balances and exit codes. That matters more than usual for this
 * contract, because the TON-specific hazards it guards against are all invisible
 * to a reading of the source:
 *
 *   - refusing a jetton transfer does not return the jettons, so every refusal
 *     path has to send them back by hand;
 *   - a bounceable payout to a wallet that has never been deployed comes
 *     straight back, stranding a settled escrow; and
 *   - the contract pays rent out of the same balance the escrows sit in, so
 *     "can the owner reach a seller's funds" is a real question rather than a
 *     theoretical one.
 *
 * The jetton side is modelled with a stand-in wallet contract rather than a full
 * jetton implementation. That is deliberate: what the escrow authenticates is
 * *which address* a transfer notification came from, never anything about the
 * jetton itself, so a stand-in exercises exactly the logic under test.
 */

const TRADE_ID = 0x1111n;
const OTHER_TRADE = 0x2222n;
const WINDOW = 3600; // 1 hour, inside MIN/MAX_PAYMENT_WINDOW

describe("ElexaEscrow", () => {
  let blockchain: Blockchain;
  let escrow: SandboxContract<ElexaEscrow>;
  let owner: SandboxContract<TreasuryContract>;
  let arbiter: SandboxContract<TreasuryContract>;
  let feeCollector: SandboxContract<TreasuryContract>;
  let seller: SandboxContract<TreasuryContract>;
  let buyer: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  /** Stands in for the escrow's own jetton wallet. */
  let jettonWallet: SandboxContract<TreasuryContract>;
  let jettonMaster: SandboxContract<TreasuryContract>;

  beforeEach(async () => {
    blockchain = await Blockchain.create();

    owner = await blockchain.treasury("owner");
    arbiter = await blockchain.treasury("arbiter");
    feeCollector = await blockchain.treasury("feeCollector");
    seller = await blockchain.treasury("seller");
    buyer = await blockchain.treasury("buyer");
    stranger = await blockchain.treasury("stranger");
    jettonWallet = await blockchain.treasury("jettonWallet");
    jettonMaster = await blockchain.treasury("jettonMaster");

    escrow = blockchain.openContract(
      await ElexaEscrow.fromInit(owner.address, arbiter.address, feeCollector.address),
    );

    await escrow.send(
      owner.getSender(),
      { value: toNano("1") },
      { $$type: "Deploy", queryId: 0n },
    );
    // Native escrow is off by default, exactly as `setNativeAllowed` is on the
    // Solidity. Most tests want it on.
    await escrow.send(
      owner.getSender(),
      { value: toNano("0.05") },
      { $$type: "SetNativeAllowed", allowed: true },
    );
  });

  // ------------------------------------------------------------------ helpers

  const fundNative = async (
    opts: {
      tradeId?: bigint;
      amount?: string;
      fee?: string;
      window?: number;
      value?: string;
      from?: SandboxContract<TreasuryContract>;
    } = {},
  ) => {
    const amount = toNano(opts.amount ?? "10");
    return escrow.send(
      (opts.from ?? seller).getSender(),
      { value: toNano(opts.value ?? "10.2") },
      {
        $$type: "FundNative",
        tradeId: opts.tradeId ?? TRADE_ID,
        buyer: buyer.address,
        amount,
        fee: toNano(opts.fee ?? "0.2"),
        paymentWindow: BigInt(opts.window ?? WINDOW),
      },
    );
  };

  const allowJetton = () =>
    escrow.send(
      owner.getSender(),
      { value: toNano("0.05") },
      {
        $$type: "SetJettonAllowed",
        jettonWallet: jettonWallet.address,
        jettonMaster: jettonMaster.address,
        allowed: true,
      },
    );

  /** The forward payload a seller attaches to a jetton transfer. */
  const fundingPayload = (
    tradeId: bigint,
    fee: bigint,
    window: number,
    buyerAddress: Address = buyer.address,
  ) =>
    beginCell()
      // The `Either Cell ^Cell` prefix: 1 means "the payload is in a reference".
      .storeBit(1)
      .storeRef(
        beginCell()
          .storeUint(tradeId, 256)
          .storeAddress(buyerAddress)
          .storeCoins(fee)
          .storeUint(window, 32)
          .endCell(),
      )
      .endCell();

  const notifyJetton = async (
    opts: {
      amount?: bigint;
      payload?: Cell;
      from?: SandboxContract<TreasuryContract>;
      sender?: Address;
    } = {},
  ) =>
    escrow.send(
      (opts.from ?? jettonWallet).getSender(),
      { value: toNano("0.3") },
      {
        $$type: "JettonTransferNotification",
        queryId: 0n,
        amount: opts.amount ?? toNano("100"),
        sender: opts.sender ?? seller.address,
        forwardPayload: (opts.payload ?? fundingPayload(TRADE_ID, toNano("2"), WINDOW))
          .asSlice(),
      },
    );

  /** Whether a JettonTransfer body was sent from the escrow to `to`. */
  const jettonTransfersTo = (result: any, destination: Address) =>
    result.transactions
      .flatMap((tx: any) => tx.outMessages?.values?.() ?? [])
      .filter((msg: any) => {
        if (!msg.body) return false;
        try {
          const slice = msg.body.beginParse();
          if (slice.remainingBits < 32) return false;
          if (slice.loadUint(32) !== 0xf8a7ea5) return false;
          slice.loadUint(64); // queryId
          slice.loadCoins(); // amount
          return slice.loadAddress().equals(destination);
        } catch {
          return false;
        }
      });

  // ------------------------------------------------------------ native funding

  it("locks native TON and records the escrow", async () => {
    const result = await fundNative();
    expect(result.transactions).toHaveTransaction({
      from: seller.address,
      to: escrow.address,
      success: true,
    });

    const record = await escrow.getEscrow(TRADE_ID);
    expect(record).not.toBeNull();
    expect(record!.status).toBe(1n); // Funded
    expect(record!.amount).toBe(toNano("10"));
    expect(record!.fee).toBe(toNano("0.2"));
    expect(record!.seller.equals(seller.address)).toBe(true);
    expect(record!.buyer.equals(buyer.address)).toBe(true);
    expect(record!.jettonWallet).toBeNull();
    expect(await escrow.getLockedNative()).toBe(toNano("10"));
  });

  it("refuses native funding when the amount is not actually attached", async () => {
    // The trap the explicit `amount` field exists to catch: a seller claiming to
    // escrow 10 TON while attaching 1. On EVM msg.value *is* the amount and this
    // cannot happen; on TON they are separate numbers.
    const result = await fundNative({ amount: "10", value: "1" });
    expect(result.transactions).toHaveTransaction({
      from: seller.address,
      to: escrow.address,
      success: false,
    });
    expect(await escrow.getEscrow(TRADE_ID)).toBeNull();
  });

  it("refuses native funding when native is not allowed", async () => {
    await escrow.send(
      owner.getSender(),
      { value: toNano("0.05") },
      { $$type: "SetNativeAllowed", allowed: false },
    );
    const result = await fundNative();
    expect(result.transactions).toHaveTransaction({ success: false });
    expect(await escrow.getEscrow(TRADE_ID)).toBeNull();
  });

  it("refuses a duplicate trade id, and a settled one too", async () => {
    await fundNative();
    const duplicate = await fundNative();
    expect(duplicate.transactions).toHaveTransaction({ success: false });

    // Settle it, then try again. The tombstone is what keeps this refused —
    // deleting the record outright would let a closed trade id be reused.
    await escrow.send(
      seller.getSender(),
      { value: toNano("0.1") },
      { $$type: "Release", tradeId: TRADE_ID },
    );
    const afterSettle = await fundNative();
    expect(afterSettle.transactions).toHaveTransaction({ success: false });
  });

  it("refuses a payment window outside the allowed bounds", async () => {
    for (const window of [60, 60 * 60 * 24 * 40]) {
      const result = await fundNative({ tradeId: BigInt(window), window });
      expect(result.transactions).toHaveTransaction({ success: false });
    }
  });

  it("refuses a fee above the ceiling", async () => {
    // 10% is the cap; 2 TON on a 10 TON escrow is 20%.
    const result = await fundNative({ amount: "10", fee: "2", value: "10.2" });
    expect(result.transactions).toHaveTransaction({ success: false });
    expect(await escrow.getEscrow(TRADE_ID)).toBeNull();
  });

  // --------------------------------------------------------------- settlement

  it("pays the buyer and the fee collector on release", async () => {
    await fundNative();
    const buyerBefore = await buyer.getBalance();
    const feeBefore = await feeCollector.getBalance();

    const result = await escrow.send(
      seller.getSender(),
      { value: toNano("0.1") },
      { $$type: "Release", tradeId: TRADE_ID },
    );
    expect(result.transactions).toHaveTransaction({ success: true });

    expect(await buyer.getBalance()).toBeGreaterThan(buyerBefore + toNano("9.7"));
    expect(await feeCollector.getBalance()).toBeGreaterThan(feeBefore + toNano("0.19"));

    const record = await escrow.getEscrow(TRADE_ID);
    expect(record!.status).toBe(4n); // Released
    expect(record!.amount).toBe(0n); // collapsed to a tombstone
    expect(await escrow.getLockedNative()).toBe(0n);
  });

  it("lets only the seller release", async () => {
    await fundNative();
    for (const who of [buyer, arbiter, stranger]) {
      const result = await escrow.send(
        who.getSender(),
        { value: toNano("0.1") },
        { $$type: "Release", tradeId: TRADE_ID },
      );
      expect(result.transactions).toHaveTransaction({ success: false });
    }
  });

  it("lets the buyer cancel an unpaid trade, paying the seller back at once", async () => {
    await fundNative();
    const sellerBefore = await seller.getBalance();

    // No clock skip: the point of this path is that the seller does not have to
    // wait the window out for a buyer who has already walked away.
    const result = await escrow.send(
      buyer.getSender(),
      { value: toNano("0.05") },
      { $$type: "BuyerCancel", tradeId: TRADE_ID },
    );
    expect(result.transactions).toHaveTransaction({ success: true });

    // Whole, like a timeout refund: no fee is charged on a trade nobody paid for.
    expect(await seller.getBalance()).toBeGreaterThan(sellerBefore + toNano("9.9"));
    expect((await escrow.getEscrow(TRADE_ID))!.status).toBe(5n); // Refunded
  });

  it("REFUSES BuyerCancel once the buyer has marked paid", async () => {
    await fundNative();
    await escrow.send(
      buyer.getSender(),
      { value: toNano("0.05") },
      { $$type: "MarkPaid", tradeId: TRADE_ID },
    );

    // The whole reason this is restricted to Funded. A buyer who has sent fiat
    // must not be one click away from handing the money to the seller anyway —
    // by mistake, or because someone on the other end talked them into it.
    const result = await escrow.send(
      buyer.getSender(),
      { value: toNano("0.05") },
      { $$type: "BuyerCancel", tradeId: TRADE_ID },
    );
    expect(result.transactions).toHaveTransaction({ success: false });
    expect((await escrow.getEscrow(TRADE_ID))!.status).toBe(2n); // still Paid
  });

  it("lets nobody but the buyer cancel", async () => {
    await fundNative();

    // The seller especially: cancelling pays the seller, so if they could call
    // it themselves they would have a way to take the money back at any moment,
    // with no window and no dispute. That is the entire escrow defeated.
    for (const caller of [seller, stranger, arbiter]) {
      const result = await escrow.send(
        caller.getSender(),
        { value: toNano("0.05") },
        { $$type: "BuyerCancel", tradeId: TRADE_ID },
      );
      expect(result.transactions).toHaveTransaction({ success: false });
    }
    expect((await escrow.getEscrow(TRADE_ID))!.status).toBe(1n); // still Funded
  });

  it("cannot cancel a trade twice", async () => {
    await fundNative();
    await escrow.send(
      buyer.getSender(),
      { value: toNano("0.05") },
      { $$type: "BuyerCancel", tradeId: TRADE_ID },
    );

    // The tombstone has to hold: a second cancel that succeeded would pay the
    // seller a second time out of everyone else's escrowed funds.
    const again = await escrow.send(
      buyer.getSender(),
      { value: toNano("0.05") },
      { $$type: "BuyerCancel", tradeId: TRADE_ID },
    );
    expect(again.transactions).toHaveTransaction({ success: false });
  });

  it("freezes the refund clock when the buyer marks paid", async () => {
    await fundNative();
    await escrow.send(
      buyer.getSender(),
      { value: toNano("0.05") },
      { $$type: "MarkPaid", tradeId: TRADE_ID },
    );
    expect((await escrow.getEscrow(TRADE_ID))!.status).toBe(2n); // Paid

    // The timeout refund is now unreachable, however long anyone waits — this is
    // what stops a seller running the clock out on a buyer who has paid.
    blockchain.now = Math.floor(Date.now() / 1000) + WINDOW + 60;
    const result = await escrow.send(
      stranger.getSender(),
      { value: toNano("0.05") },
      { $$type: "RefundAfterTimeout", tradeId: TRADE_ID },
    );
    expect(result.transactions).toHaveTransaction({ success: false });
  });

  it("lets the arbiter mark paid on the buyer's behalf", async () => {
    await fundNative();
    const result = await escrow.send(
      arbiter.getSender(),
      { value: toNano("0.05") },
      { $$type: "MarkPaid", tradeId: TRADE_ID },
    );
    expect(result.transactions).toHaveTransaction({ success: true });
    expect((await escrow.getEscrow(TRADE_ID))!.status).toBe(2n);
  });

  it("refunds an abandoned escrow to the seller, and anyone may push it", async () => {
    await fundNative();
    const sellerBefore = await seller.getBalance();

    blockchain.now = Math.floor(Date.now() / 1000) + WINDOW + 60;
    // A stranger, deliberately: the seller's refund must not depend on Elexa
    // being alive, so this path is permissionless.
    const result = await escrow.send(
      stranger.getSender(),
      { value: toNano("0.05") },
      { $$type: "RefundAfterTimeout", tradeId: TRADE_ID },
    );
    expect(result.transactions).toHaveTransaction({ success: true });

    // Refunded whole — the fee is only ever charged when the buyer is paid.
    expect(await seller.getBalance()).toBeGreaterThan(sellerBefore + toNano("9.9"));
    expect((await escrow.getEscrow(TRADE_ID))!.status).toBe(5n); // Refunded
  });

  it("refuses a timeout refund before the window closes", async () => {
    await fundNative();
    const result = await escrow.send(
      stranger.getSender(),
      { value: toNano("0.05") },
      { $$type: "RefundAfterTimeout", tradeId: TRADE_ID },
    );
    expect(result.transactions).toHaveTransaction({ success: false });
  });

  // ----------------------------------------------------------------- disputes

  it("lets either party dispute, and only the arbiter resolve", async () => {
    await fundNative();
    await escrow.send(
      buyer.getSender(),
      { value: toNano("0.05") },
      { $$type: "Dispute", tradeId: TRADE_ID },
    );
    expect((await escrow.getEscrow(TRADE_ID))!.status).toBe(3n); // Disputed

    for (const who of [seller, buyer, stranger]) {
      const refused = await escrow.send(
        who.getSender(),
        { value: toNano("0.05") },
        { $$type: "Resolve", tradeId: TRADE_ID, toBuyer: true },
      );
      expect(refused.transactions).toHaveTransaction({ success: false });
    }

    const buyerBefore = await buyer.getBalance();
    const result = await escrow.send(
      arbiter.getSender(),
      { value: toNano("0.1") },
      { $$type: "Resolve", tradeId: TRADE_ID, toBuyer: true },
    );
    expect(result.transactions).toHaveTransaction({ success: true });
    expect(await buyer.getBalance()).toBeGreaterThan(buyerBefore + toNano("9.7"));
  });

  it("refunds the seller in full when the arbiter resolves against the buyer", async () => {
    await fundNative();
    await escrow.send(
      seller.getSender(),
      { value: toNano("0.05") },
      { $$type: "Dispute", tradeId: TRADE_ID },
    );
    const sellerBefore = await seller.getBalance();
    await escrow.send(
      arbiter.getSender(),
      { value: toNano("0.1") },
      { $$type: "Resolve", tradeId: TRADE_ID, toBuyer: false },
    );
    // No fee taken on a refund.
    expect(await seller.getBalance()).toBeGreaterThan(sellerBefore + toNano("9.9"));
  });

  it("lets a seller release even while disputed", async () => {
    await fundNative();
    await escrow.send(
      buyer.getSender(),
      { value: toNano("0.05") },
      { $$type: "Dispute", tradeId: TRADE_ID },
    );
    const result = await escrow.send(
      seller.getSender(),
      { value: toNano("0.1") },
      { $$type: "Release", tradeId: TRADE_ID },
    );
    expect(result.transactions).toHaveTransaction({ success: true });
    expect((await escrow.getEscrow(TRADE_ID))!.status).toBe(4n);
  });

  it("refuses to resolve a trade nobody disputed", async () => {
    await fundNative();
    const result = await escrow.send(
      arbiter.getSender(),
      { value: toNano("0.1") },
      { $$type: "Resolve", tradeId: TRADE_ID, toBuyer: true },
    );
    expect(result.transactions).toHaveTransaction({ success: false });
  });

  // ------------------------------------------------------------------ jettons

  it("locks jettons sent with a valid funding payload", async () => {
    await allowJetton();
    const result = await notifyJetton();
    expect(result.transactions).toHaveTransaction({
      from: jettonWallet.address,
      to: escrow.address,
      success: true,
    });

    const record = await escrow.getEscrow(TRADE_ID);
    expect(record).not.toBeNull();
    expect(record!.status).toBe(1n);
    expect(record!.amount).toBe(toNano("100"));
    // The seller is whoever sent the jettons, never the jetton wallet — which
    // is a contract, and refunding to it would lose the money.
    expect(record!.seller.equals(seller.address)).toBe(true);
    expect(record!.jettonWallet!.equals(jettonWallet.address)).toBe(true);
    // Jettons are not native TON and must not count towards the native lock.
    expect(await escrow.getLockedNative()).toBe(0n);
  });

  it("ignores a notification from a jetton wallet it does not know", async () => {
    // No allow-list entry: anyone can mint a worthless jetton and notify us
    // about it. Accepting would fund an escrow holding nothing.
    const result = await notifyJetton({ from: stranger });
    expect(await escrow.getEscrow(TRADE_ID)).toBeNull();
    // And nothing is sent back — we have no reason to believe that wallet holds
    // anything, and transferring to it would be doing an attacker's work.
    expect(jettonTransfersTo(result, stranger.address)).toHaveLength(0);
  });

  it("SENDS THE JETTONS BACK when it refuses a funding", async () => {
    // The single most important behaviour in this contract. On EVM a rejected
    // transfer unwinds itself; here the tokens have already arrived, so a
    // refusal that merely returned early would silently keep a seller's USDT.
    await allowJetton();

    const cases: Array<[string, Cell]> = [
      ["window too short", fundingPayload(TRADE_ID, toNano("2"), 60)],
      ["fee above the ceiling", fundingPayload(TRADE_ID, toNano("50"), WINDOW)],
      ["unreadable payload", beginCell().storeUint(1, 8).endCell()],
    ];

    for (const [label, payload] of cases) {
      const result = await notifyJetton({ payload });
      expect(await escrow.getEscrow(TRADE_ID)).toBeNull();
      // A jetton transfer back to the seller, for the full amount.
      const sentBack = jettonTransfersTo(result, seller.address);
      expect(sentBack.length).toBeGreaterThanOrEqual(1);
      if (sentBack.length === 0) throw new Error(`no refund for: ${label}`);
    }
  });

  it("sends jettons back when the trade id is already in use", async () => {
    await allowJetton();
    await notifyJetton();
    expect(await escrow.getEscrow(TRADE_ID)).not.toBeNull();

    const result = await notifyJetton();
    expect(jettonTransfersTo(result, seller.address).length).toBeGreaterThanOrEqual(1);
    // The original escrow is untouched by the rejected second funding.
    expect((await escrow.getEscrow(TRADE_ID))!.amount).toBe(toNano("100"));
  });

  it("pays jettons out to the buyer and the fee collector on release", async () => {
    await allowJetton();
    await notifyJetton();

    const result = await escrow.send(
      seller.getSender(),
      { value: toNano("0.3") },
      { $$type: "Release", tradeId: TRADE_ID },
    );
    expect(result.transactions).toHaveTransaction({ success: true });
    expect(jettonTransfersTo(result, buyer.address).length).toBeGreaterThanOrEqual(1);
    expect(jettonTransfersTo(result, feeCollector.address).length).toBeGreaterThanOrEqual(1);
  });

  it("refunds jettons to the seller on timeout", async () => {
    await allowJetton();
    await notifyJetton();
    blockchain.now = Math.floor(Date.now() / 1000) + WINDOW + 60;

    const result = await escrow.send(
      stranger.getSender(),
      { value: toNano("0.3") },
      { $$type: "RefundAfterTimeout", tradeId: TRADE_ID },
    );
    expect(jettonTransfersTo(result, seller.address).length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------- admin

  it("keeps the owner away from escrowed funds", async () => {
    await fundNative({ amount: "10", value: "10.2" });

    const before = await owner.getBalance();
    const result = await escrow.send(
      owner.getSender(),
      { value: toNano("0.05") },
      "withdraw-surplus",
    );

    // Whatever the owner can take, the locked 10 TON is not part of it.
    const after = await owner.getBalance();
    expect(after - before).toBeLessThan(toNano("1"));
    expect(await escrow.getLockedNative()).toBe(toNano("10"));

    // And the escrow can still pay out in full afterwards.
    const buyerBefore = await buyer.getBalance();
    await escrow.send(
      seller.getSender(),
      { value: toNano("0.1") },
      { $$type: "Release", tradeId: TRADE_ID },
    );
    expect(await buyer.getBalance()).toBeGreaterThan(buyerBefore + toNano("9.7"));
    expect(result.transactions.length).toBeGreaterThan(0);
  });

  it("lets only the owner change the arbiter, fee collector and allow-lists", async () => {
    // Sequentially, not with Promise.all: the sandbox processes one message at
    // a time, and issuing them concurrently interleaves the blocks so a result
    // can come back holding another send's transactions.
    for (const who of [arbiter, seller, stranger]) {
      const attempts = [
        { $$type: "SetArbiter" as const, arbiter: who.address },
        { $$type: "SetFeeCollector" as const, feeCollector: who.address },
        { $$type: "SetNativeAllowed" as const, allowed: false },
        {
          $$type: "SetJettonAllowed" as const,
          jettonWallet: who.address,
          jettonMaster: who.address,
          allowed: true,
        },
      ];
      for (const attempt of attempts) {
        const result = await escrow.send(
          who.getSender(),
          { value: toNano("0.05") },
          attempt,
        );
        expect(result.transactions).toHaveTransaction({
          from: who.address,
          to: escrow.address,
          success: false,
        });
      }
    }

    expect((await escrow.getArbiter()).equals(arbiter.address)).toBe(true);
    expect(await escrow.getNativeAllowed()).toBe(true);
  });

  it("pausing stops new escrows but never traps open ones", async () => {
    await fundNative();
    await escrow.send(
      owner.getSender(),
      { value: toNano("0.05") },
      { $$type: "SetPaused", paused: true },
    );

    const blocked = await fundNative({ tradeId: OTHER_TRADE });
    expect(blocked.transactions).toHaveTransaction({ success: false });

    // Money already locked must always be able to get out, whatever state the
    // platform is in.
    const released = await escrow.send(
      seller.getSender(),
      { value: toNano("0.1") },
      { $$type: "Release", tradeId: TRADE_ID },
    );
    expect(released.transactions).toHaveTransaction({ success: true });
  });

  it("sends jettons back rather than keeping them while paused", async () => {
    await allowJetton();
    await escrow.send(
      owner.getSender(),
      { value: toNano("0.05") },
      { $$type: "SetPaused", paused: true },
    );
    const result = await notifyJetton();
    expect(await escrow.getEscrow(TRADE_ID)).toBeNull();
    expect(jettonTransfersTo(result, seller.address).length).toBeGreaterThanOrEqual(1);
  });
  // --------------------------------------------------- sweep and gas accounting

  it("refuses to sweep jettons an open escrow accounts for", async () => {
    await allowJetton();
    await notifyJetton(); // 100 jettons now locked against TRADE_ID

    const record = await escrow.getEscrow(TRADE_ID);
    expect(record!.amount).toBe(toNano("100"));

    // Nothing arrived without an escrow, so there is nothing to sweep — the
    // owner key must not be able to reach the seller's locked jettons.
    expect(await escrow.getSweepableJettons(jettonWallet.address)).toBe(0n);

    const swept = await escrow.send(
      owner.getSender(),
      { value: toNano("0.2") },
      {
        $$type: "AdminJettonSweep",
        jettonWallet: jettonWallet.address,
        to: owner.address,
        amount: toNano("100"),
      },
    );
    expect(swept.transactions).toHaveTransaction({ success: false });
    expect(jettonTransfersTo(swept, owner.address).length).toBe(0);

    // And the escrow is untouched.
    expect((await escrow.getEscrow(TRADE_ID))!.amount).toBe(toNano("100"));
  });

  it("books an unknown jetton as sweepable, and lets the owner recover it", async () => {
    // Never allow-listed: we hold the jettons but have no escrow for them.
    const result = await notifyJetton({ amount: toNano("7") });
    expect(await escrow.getEscrow(TRADE_ID)).toBeNull();
    expect(await escrow.getSweepableJettons(jettonWallet.address)).toBe(toNano("7"));

    const swept = await escrow.send(
      owner.getSender(),
      { value: toNano("0.2") },
      {
        $$type: "AdminJettonSweep",
        jettonWallet: jettonWallet.address,
        to: owner.address,
        amount: toNano("7"),
      },
    );
    expect(swept.transactions).toHaveTransaction({ success: true });
    expect(jettonTransfersTo(swept, owner.address).length).toBeGreaterThanOrEqual(1);

    // Spent, so it cannot be swept twice.
    expect(await escrow.getSweepableJettons(jettonWallet.address)).toBe(0n);
    expect(result.transactions.length).toBeGreaterThan(0);
  });

  it("does not pay for a refund the sender did not fund", async () => {
    await allowJetton();
    const before = await escrow.getSweepableJettons(jettonWallet.address);

    // A malformed payload that would normally be handed straight back — but
    // with barely any TON attached, so returning it would come out of the
    // contract's own balance. Looping this is the drain.
    const result = await escrow.send(
      jettonWallet.getSender(),
      { value: toNano("0.01") },
      {
        $$type: "JettonTransferNotification",
        queryId: 0n,
        amount: toNano("1"),
        sender: seller.address,
        forwardPayload: beginCell().storeBit(0).endCell().asSlice(),
      },
    );

    // Nothing sent, so nothing drained; the jettons are booked for recovery.
    expect(jettonTransfersTo(result, seller.address).length).toBe(0);
    expect(await escrow.getSweepableJettons(jettonWallet.address)).toBe(
      before + toNano("1"),
    );
  });

  it("still refunds a malformed funding that paid its own way", async () => {
    await allowJetton();
    const result = await notifyJetton({
      payload: beginCell().storeBit(0).endCell(),
    });

    expect(await escrow.getEscrow(TRADE_ID)).toBeNull();
    expect(jettonTransfersTo(result, seller.address).length).toBeGreaterThanOrEqual(1);
    // Returned, so not ours to sweep.
    expect(await escrow.getSweepableJettons(jettonWallet.address)).toBe(0n);
  });

  it("returns a truncated payload rather than throwing on it", async () => {
    await allowJetton();

    // 256 bits of trade id and then nothing. `loadAddress` on an empty slice
    // throws, and a throw here would abort the transaction *after* the jettons
    // landed — no escrow, no refund, tokens stuck.
    const truncated = beginCell()
      .storeBit(1)
      .storeRef(
        beginCell()
          .storeUint(TRADE_ID, 256)
          // 100 bits where a 267-bit address belongs: comfortably past any
          // single up-front length check, and still short of one field.
          .storeUint(0b100, 3)
          .storeUint(0, 97)
          .endCell(),
      )
      .endCell();

    const result = await notifyJetton({ payload: truncated });

    expect(result.transactions).toHaveTransaction({ to: escrow.address, success: true });
    expect(await escrow.getEscrow(TRADE_ID)).toBeNull();
    expect(jettonTransfersTo(result, seller.address).length).toBeGreaterThanOrEqual(1);
  });

  it("returns a payload whose address is not a standard one", async () => {
    await allowJetton();

    // addr_none: two zero bits where a 267-bit addr_std belongs. Legal to
    // encode, and `loadAddress` throws on it.
    const addrNone = beginCell()
      .storeBit(1)
      .storeRef(
        beginCell()
          .storeUint(TRADE_ID, 256)
          .storeUint(0, 2)
          .storeCoins(toNano("2"))
          .storeUint(WINDOW, 32)
          .endCell(),
      )
      .endCell();

    const result = await notifyJetton({ payload: addrNone });

    expect(result.transactions).toHaveTransaction({ to: escrow.address, success: true });
    expect(await escrow.getEscrow(TRADE_ID)).toBeNull();
    expect(jettonTransfersTo(result, seller.address).length).toBeGreaterThanOrEqual(1);
  });
});
