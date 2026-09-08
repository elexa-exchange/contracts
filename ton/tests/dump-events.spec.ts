import { Blockchain, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { beginCell, toNano } from "@ton/core";
import "@ton/test-utils";
import * as fs from "fs";
import * as path from "path";
import { ElexaEscrow } from "../build/ElexaEscrow_ElexaEscrow";

/**
 * Captures real emitted event bodies as fixtures for an indexer's tests.
 *
 * Anything reading these events has to decode the cells, and their layout
 * is not something to take on trust: a Tact message longer than one cell — which
 * `Funded` is, at roughly 1369 bits — is silently split across references, and
 * exactly where the split falls is the compiler's decision, not ours. A decoder
 * written against an assumed layout would parse garbage and quarantine every
 * honest escrow.
 *
 * So the layout is pinned by example instead: this writes the actual bytes the
 * contract emits to `build/event-fixtures.json`, for a decoder's own tests to
 * read back. If the contract's event shape ever changes, those tests fail on
 * the next `npm run build` rather than in production.
 */
/** Event opcodes, mirroring the `message(0x…)` declarations in the contract. */
const EVENT_NAMES: Record<number, string> = {
  0x656c0100: "Funded",
  0x656c0101: "MarkedPaid",
  0x656c0102: "Disputed",
  0x656c0103: "Released",
  0x656c0104: "Refunded",
  0x656c0105: "Resolved",
  0x656c0106: "FundingRefunded",
  0x656c0107: "JettonPayoutFailed",
};

describe("event fixtures", () => {
  it("writes emitted event bodies for an indexer to test against", async () => {
    const blockchain = await Blockchain.create();
    const owner = await blockchain.treasury("owner");
    const arbiter = await blockchain.treasury("arbiter");
    const feeCollector = await blockchain.treasury("feeCollector");
    const seller = await blockchain.treasury("seller");
    const buyer = await blockchain.treasury("buyer");
    const jettonWallet = await blockchain.treasury("jettonWallet");
    const jettonMaster = await blockchain.treasury("jettonMaster");

    const escrow = blockchain.openContract(
      await ElexaEscrow.fromInit(owner.address, arbiter.address, feeCollector.address),
    );
    await escrow.send(owner.getSender(), { value: toNano("1") }, { $$type: "Deploy", queryId: 0n });
    await escrow.send(
      owner.getSender(),
      { value: toNano("0.05") },
      { $$type: "SetNativeAllowed", allowed: true },
    );
    await escrow.send(
      owner.getSender(),
      { value: toNano("0.05") },
      {
        $$type: "SetJettonAllowed",
        jettonWallet: jettonWallet.address,
        jettonMaster: jettonMaster.address,
        allowed: true,
      },
    );

    // Keyed by opcode rather than by the action that caused it, because one
    // message can emit several events — `Resolve` emits Resolved *and* the
    // Released or Refunded that follows it — and keying by action would silently
    // keep only whichever came last.
    const captured: Record<string, string> = {};
    const capture = (result: any) => {
      for (const tx of result.transactions) {
        for (const msg of tx.outMessages?.values?.() ?? []) {
          // External-out messages are what `emit()` produces: no destination.
          if (msg.info?.type !== "external-out") continue;
          const body = msg.body as any;
          const op = body.beginParse().loadUint(32);
          captured[EVENT_NAMES[op] ?? `op_${op.toString(16)}`] = body
            .toBoc()
            .toString("base64");
        }
      }
    };

    const NATIVE_TRADE = 0x1111n;
    const JETTON_TRADE = 0x2222n;

    capture(
      await escrow.send(
        seller.getSender(),
        { value: toNano("10.2") },
        {
          $$type: "FundNative",
          tradeId: NATIVE_TRADE,
          buyer: buyer.address,
          amount: toNano("10"),
          fee: toNano("0.2"),
          paymentWindow: 3600n,
        },
      ),
    );

    // Renamed before the jetton funding overwrites it: both are `Funded`, and
    // the native and jetton shapes differ in the one field the indexer most
    // needs to get right.
    captured["Funded_native"] = captured["Funded"];
    capture(
      await escrow.send(
        jettonWallet.getSender(),
        { value: toNano("0.3") },
        {
          $$type: "JettonTransferNotification",
          queryId: 0n,
          amount: toNano("100"),
          sender: seller.address,
          forwardPayload: beginCell()
            .storeBit(1)
            .storeRef(
              beginCell()
                .storeUint(JETTON_TRADE, 256)
                .storeAddress(buyer.address)
                .storeCoins(toNano("2"))
                .storeUint(3600, 32)
                .endCell(),
            )
            .endCell()
            .asSlice(),
        },
      ),
    );

    captured["Funded_jetton"] = captured["Funded"];

    capture(
      await escrow.send(
        buyer.getSender(),
        { value: toNano("0.05") },
        { $$type: "MarkPaid", tradeId: NATIVE_TRADE },
      ),
    );
    capture(
      await escrow.send(
        buyer.getSender(),
        { value: toNano("0.05") },
        { $$type: "Dispute", tradeId: NATIVE_TRADE },
      ),
    );
    capture(
      await escrow.send(
        arbiter.getSender(),
        { value: toNano("0.2") },
        { $$type: "Resolve", tradeId: NATIVE_TRADE, toBuyer: true },
      ),
    );
    capture(
      await escrow.send(
        seller.getSender(),
        { value: toNano("0.3") },
        { $$type: "Release", tradeId: JETTON_TRADE },
      ),
    );

    // A refund, on a second native trade left to time out.
    const TIMEOUT_TRADE = 0x3333n;
    await escrow.send(
      seller.getSender(),
      { value: toNano("5.2") },
      {
        $$type: "FundNative",
        tradeId: TIMEOUT_TRADE,
        buyer: buyer.address,
        amount: toNano("5"),
        fee: toNano("0.1"),
        paymentWindow: 3600n,
      },
    );
    blockchain.now = Math.floor(Date.now() / 1000) + 7200;
    capture(
      await escrow.send(
        seller.getSender(),
        { value: toNano("0.1") },
        { $$type: "RefundAfterTimeout", tradeId: TIMEOUT_TRADE },
      ),
    );

    const fixtures = {
      note: "Generated by tests/dump-events.spec.ts. Read back by the indexer's decoder tests.",
      addresses: {
        seller: seller.address.toRawString(),
        buyer: buyer.address.toRawString(),
        feeCollector: feeCollector.address.toRawString(),
        jettonMaster: jettonMaster.address.toRawString(),
        jettonWallet: jettonWallet.address.toRawString(),
      },
      trades: {
        native: "0x" + NATIVE_TRADE.toString(16).padStart(64, "0"),
        jetton: "0x" + JETTON_TRADE.toString(16).padStart(64, "0"),
        timeout: "0x" + TIMEOUT_TRADE.toString(16).padStart(64, "0"),
      },
      events: captured,
    };

    const outPath = path.join(__dirname, "..", "build", "event-fixtures.json");
    fs.writeFileSync(outPath, JSON.stringify(fixtures, null, 2));

    // Every event we expect the indexer to understand must actually have been
    // produced — an empty fixture would make a decoder's tests vacuously pass.
    for (const name of [
      "Funded_native",
      "Funded_jetton",
      "MarkedPaid",
      "Disputed",
      "Resolved",
      "Released",
      "Refunded",
    ]) {
      expect(captured[name]).toBeDefined();
    }
  });
});
