import { expect } from "chai";
import hre from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { anyValue } from "@nomicfoundation/hardhat-chai-matchers/withArgs";
import { keccak256, toUtf8Bytes, parseUnits, ZeroAddress } from "ethers";

const TRADE_ID = keccak256(toUtf8Bytes("4MUdoh16MWP"));
const AMOUNT = parseUnits("101", 18); // 100 USDT + 1 USDT seller fee
const FEE = parseUnits("1", 18);
const WINDOW = 60 * 60; // 1 hour

async function deployFixture() {
  const [owner, arbiter, feeCollector, seller, buyer, stranger] = await hre.ethers.getSigners();

  const token = await hre.ethers.deployContract("MockERC20");
  const escrow = await hre.ethers.deployContract("ElexaEscrow", [
    owner.address,
    arbiter.address,
    feeCollector.address,
  ]);

  await escrow.setTokenAllowed(await token.getAddress(), true);
  await token.mint(seller.address, parseUnits("1000", 18));
  await token.connect(seller).approve(await escrow.getAddress(), hre.ethers.MaxUint256);

  return { escrow, token, owner, arbiter, feeCollector, seller, buyer, stranger };
}

async function fund(ctx: Awaited<ReturnType<typeof deployFixture>>) {
  const { escrow, token, seller, buyer } = ctx;
  await escrow.connect(seller).fundEscrow(TRADE_ID, buyer.address, await token.getAddress(), AMOUNT, FEE, WINDOW);
}

describe("ElexaEscrow", () => {
  describe("funding", () => {
    it("locks the seller's tokens and records the trade", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);

      expect(await ctx.token.balanceOf(await ctx.escrow.getAddress())).to.equal(AMOUNT);

      const e = await ctx.escrow.getEscrow(TRADE_ID);
      expect(e.seller).to.equal(ctx.seller.address);
      expect(e.buyer).to.equal(ctx.buyer.address);
      expect(e.amount).to.equal(AMOUNT);
      expect(e.fee).to.equal(FEE);
      expect(e.status).to.equal(1); // Funded
    });

    it("rejects a duplicate trade id", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await expect(fund(ctx)).to.be.revertedWithCustomError(ctx.escrow, "TradeExists");
    });

    it("rejects tokens that are not allow-listed", async () => {
      const ctx = await loadFixture(deployFixture);
      const other = await hre.ethers.deployContract("MockERC20");
      await other.mint(ctx.seller.address, AMOUNT);
      await other.connect(ctx.seller).approve(await ctx.escrow.getAddress(), AMOUNT);

      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .fundEscrow(TRADE_ID, ctx.buyer.address, await other.getAddress(), AMOUNT, FEE, WINDOW),
      ).to.be.revertedWithCustomError(ctx.escrow, "TokenNotAllowed");
    });

    it("rejects fee-on-transfer tokens instead of mis-accounting them", async () => {
      const ctx = await loadFixture(deployFixture);
      const skim = await hre.ethers.deployContract("FeeOnTransferERC20");
      await skim.mint(ctx.seller.address, AMOUNT);
      await skim.connect(ctx.seller).approve(await ctx.escrow.getAddress(), AMOUNT);
      await ctx.escrow.setTokenAllowed(await skim.getAddress(), true);

      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .fundEscrow(TRADE_ID, ctx.buyer.address, await skim.getAddress(), AMOUNT, FEE, WINDOW),
      ).to.be.revertedWithCustomError(ctx.escrow, "UnexpectedBalanceChange");
    });

    it("rejects a fee above the hard ceiling", async () => {
      const ctx = await loadFixture(deployFixture);
      const tooMuch = (AMOUNT * 1001n) / 10_000n;
      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .fundEscrow(TRADE_ID, ctx.buyer.address, await ctx.token.getAddress(), AMOUNT, tooMuch, WINDOW),
      ).to.be.revertedWithCustomError(ctx.escrow, "FeeTooHigh");
    });

    it("rejects payment windows outside the allowed bounds", async () => {
      const ctx = await loadFixture(deployFixture);
      const tokenAddr = await ctx.token.getAddress();

      await expect(
        ctx.escrow.connect(ctx.seller).fundEscrow(TRADE_ID, ctx.buyer.address, tokenAddr, AMOUNT, FEE, 60),
      ).to.be.revertedWithCustomError(ctx.escrow, "BadWindow");

      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .fundEscrow(TRADE_ID, ctx.buyer.address, tokenAddr, AMOUNT, FEE, 31 * 24 * 60 * 60),
      ).to.be.revertedWithCustomError(ctx.escrow, "BadWindow");
    });
  });

  describe("release", () => {
    it("pays the buyer net of the fee and sends the fee to the collector", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);

      await expect(ctx.escrow.connect(ctx.seller).release(TRADE_ID))
        .to.emit(ctx.escrow, "Released")
        .withArgs(TRADE_ID, ctx.buyer.address, AMOUNT - FEE, FEE);

      expect(await ctx.token.balanceOf(ctx.buyer.address)).to.equal(AMOUNT - FEE);
      expect(await ctx.token.balanceOf(ctx.feeCollector.address)).to.equal(FEE);
      expect(await ctx.token.balanceOf(await ctx.escrow.getAddress())).to.equal(0);
    });

    it("cannot be called by anyone but the seller", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);

      await expect(ctx.escrow.connect(ctx.buyer).release(TRADE_ID)).to.be.revertedWithCustomError(
        ctx.escrow,
        "NotSeller",
      );
      await expect(ctx.escrow.connect(ctx.arbiter).release(TRADE_ID)).to.be.revertedWithCustomError(
        ctx.escrow,
        "NotSeller",
      );
    });

    it("cannot be replayed", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await ctx.escrow.connect(ctx.seller).release(TRADE_ID);

      await expect(ctx.escrow.connect(ctx.seller).release(TRADE_ID)).to.be.revertedWithCustomError(
        ctx.escrow,
        "BadStatus",
      );
    });

    it("still works while disputed, so a seller can concede without the arbiter", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await ctx.escrow.connect(ctx.buyer).dispute(TRADE_ID);

      await expect(ctx.escrow.connect(ctx.seller).release(TRADE_ID)).to.emit(ctx.escrow, "Released");
    });
  });

  describe("timeout refund", () => {
    it("is not available before the deadline", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);

      await expect(ctx.escrow.refundAfterTimeout(TRADE_ID)).to.be.revertedWithCustomError(ctx.escrow, "TooEarly");
    });

    it("can be pushed through by anyone once the deadline passes", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await time.increase(WINDOW + 1);

      const before = await ctx.token.balanceOf(ctx.seller.address);
      await expect(ctx.escrow.connect(ctx.stranger).refundAfterTimeout(TRADE_ID))
        .to.emit(ctx.escrow, "Refunded")
        .withArgs(TRADE_ID, ctx.seller.address, AMOUNT);

      // Refunds are made whole: no fee is taken when the buyer isn't paid.
      expect(await ctx.token.balanceOf(ctx.seller.address)).to.equal(before + AMOUNT);
      expect(await ctx.token.balanceOf(ctx.feeCollector.address)).to.equal(0);
    });

    it("is blocked once the buyer marks paid, even after the deadline", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await ctx.escrow.connect(ctx.buyer).markPaid(TRADE_ID);
      await time.increase(WINDOW + 1);

      await expect(ctx.escrow.refundAfterTimeout(TRADE_ID)).to.be.revertedWithCustomError(ctx.escrow, "BadStatus");
    });

    it("is blocked once disputed, even after the deadline", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await ctx.escrow.connect(ctx.buyer).dispute(TRADE_ID);
      await time.increase(WINDOW + 1);

      await expect(ctx.escrow.refundAfterTimeout(TRADE_ID)).to.be.revertedWithCustomError(ctx.escrow, "BadStatus");
    });
  });

  describe("buyer cancel", () => {
    it("returns the seller's funds at once, without waiting out the window", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);

      // No time.increase: the point of this path is that a seller does not have
      // to wait out a buyer who has already walked away.
      const before = await ctx.token.balanceOf(ctx.seller.address);
      await expect(ctx.escrow.connect(ctx.buyer).buyerCancel(TRADE_ID))
        .to.emit(ctx.escrow, "Cancelled")
        .withArgs(TRADE_ID, ctx.seller.address, AMOUNT);

      // Whole, like a timeout refund: no fee on a trade nobody paid for.
      expect(await ctx.token.balanceOf(ctx.seller.address)).to.equal(before + AMOUNT);
      expect(await ctx.token.balanceOf(ctx.feeCollector.address)).to.equal(0);
    });

    it("is refused once the buyer has marked paid", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await ctx.escrow.connect(ctx.buyer).markPaid(TRADE_ID);

      // The whole reason this is restricted to Funded. A buyer who has sent
      // fiat must not be one click away from handing the money to the seller
      // anyway — by mistake, or because someone talked them into it.
      await expect(ctx.escrow.connect(ctx.buyer).buyerCancel(TRADE_ID))
        .to.be.revertedWithCustomError(ctx.escrow, "BadStatus");
    });

    it("is refused once disputed", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await ctx.escrow.connect(ctx.buyer).dispute(TRADE_ID);

      await expect(ctx.escrow.connect(ctx.buyer).buyerCancel(TRADE_ID))
        .to.be.revertedWithCustomError(ctx.escrow, "BadStatus");
    });

    it("is refused to everyone except the buyer", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);

      // The seller above all: cancelling pays the seller, so a seller who could
      // call it would have a way to take the money back at any moment, with no
      // window and no dispute. That is the entire escrow defeated.
      for (const caller of [ctx.seller, ctx.stranger, ctx.arbiter]) {
        await expect(ctx.escrow.connect(caller).buyerCancel(TRADE_ID))
          .to.be.revertedWithCustomError(ctx.escrow, "NotBuyer");
      }
    });

    it("cannot be replayed against a settled trade", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await ctx.escrow.connect(ctx.buyer).buyerCancel(TRADE_ID);

      // A second cancel that succeeded would pay the seller again out of the
      // funds other escrows are holding.
      await expect(ctx.escrow.connect(ctx.buyer).buyerCancel(TRADE_ID))
        .to.be.revertedWithCustomError(ctx.escrow, "BadStatus");
    });
  });

  describe("markPaid", () => {
    it("accepts the arbiter as a stand-in for a buyer with no gas", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);

      await expect(ctx.escrow.connect(ctx.arbiter).markPaid(TRADE_ID))
        .to.emit(ctx.escrow, "MarkedPaid")
        .withArgs(TRADE_ID, ctx.arbiter.address);
    });

    it("rejects everyone else, including the seller", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);

      await expect(ctx.escrow.connect(ctx.seller).markPaid(TRADE_ID)).to.be.revertedWithCustomError(
        ctx.escrow,
        "NotParticipant",
      );
      await expect(ctx.escrow.connect(ctx.stranger).markPaid(TRADE_ID)).to.be.revertedWithCustomError(
        ctx.escrow,
        "NotParticipant",
      );
    });
  });

  describe("arbiter powers", () => {
    it("cannot resolve a trade nobody disputed", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);

      await expect(ctx.escrow.connect(ctx.arbiter).resolve(TRADE_ID, true)).to.be.revertedWithCustomError(
        ctx.escrow,
        "BadStatus",
      );

      await ctx.escrow.connect(ctx.buyer).markPaid(TRADE_ID);
      await expect(ctx.escrow.connect(ctx.arbiter).resolve(TRADE_ID, true)).to.be.revertedWithCustomError(
        ctx.escrow,
        "BadStatus",
      );
    });

    it("settles a disputed trade to the buyer, net of the fee", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await ctx.escrow.connect(ctx.buyer).dispute(TRADE_ID);

      await expect(ctx.escrow.connect(ctx.arbiter).resolve(TRADE_ID, true))
        .to.emit(ctx.escrow, "Resolved")
        .withArgs(TRADE_ID, true);

      expect(await ctx.token.balanceOf(ctx.buyer.address)).to.equal(AMOUNT - FEE);
      expect(await ctx.token.balanceOf(ctx.feeCollector.address)).to.equal(FEE);
    });

    it("settles a disputed trade back to the seller in full", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      const before = await ctx.token.balanceOf(ctx.seller.address);
      await ctx.escrow.connect(ctx.seller).dispute(TRADE_ID);
      await ctx.escrow.connect(ctx.arbiter).resolve(TRADE_ID, false);

      expect(await ctx.token.balanceOf(ctx.seller.address)).to.equal(before + AMOUNT);
      expect(await ctx.token.balanceOf(ctx.feeCollector.address)).to.equal(0);
    });

    it("is not open to the owner or a stranger", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await ctx.escrow.connect(ctx.buyer).dispute(TRADE_ID);

      await expect(ctx.escrow.connect(ctx.owner).resolve(TRADE_ID, true)).to.be.revertedWithCustomError(
        ctx.escrow,
        "NotArbiter",
      );
      await expect(ctx.escrow.connect(ctx.stranger).resolve(TRADE_ID, true)).to.be.revertedWithCustomError(
        ctx.escrow,
        "NotArbiter",
      );
    });

    it("has no path that sends funds to itself or the owner", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await ctx.escrow.connect(ctx.buyer).dispute(TRADE_ID);
      await ctx.escrow.connect(ctx.arbiter).resolve(TRADE_ID, true);

      expect(await ctx.token.balanceOf(ctx.arbiter.address)).to.equal(0);
      expect(await ctx.token.balanceOf(ctx.owner.address)).to.equal(0);
    });
  });

  describe("dispute", () => {
    it("is closed to non-participants", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);

      await expect(ctx.escrow.connect(ctx.stranger).dispute(TRADE_ID)).to.be.revertedWithCustomError(
        ctx.escrow,
        "NotParticipant",
      );
      await expect(ctx.escrow.connect(ctx.arbiter).dispute(TRADE_ID)).to.be.revertedWithCustomError(
        ctx.escrow,
        "NotParticipant",
      );
    });
  });

  describe("native BNB", () => {
    const NATIVE_TRADE = keccak256(toUtf8Bytes("native-trade"));
    const NATIVE_AMOUNT = parseUnits("1.01", 18);
    const NATIVE_FEE = parseUnits("0.01", 18);

    async function nativeFixture() {
      const ctx = await loadFixture(deployFixture);
      await ctx.escrow.setNativeAllowed(true);
      return ctx;
    }

    const fundNative = (ctx: Awaited<ReturnType<typeof deployFixture>>) =>
      ctx.escrow
        .connect(ctx.seller)
        .fundEscrowNative(NATIVE_TRADE, ctx.buyer.address, NATIVE_FEE, WINDOW, {
          value: NATIVE_AMOUNT,
        });

    it("is refused until the owner enables it", async () => {
      const ctx = await loadFixture(deployFixture);
      await expect(fundNative(ctx)).to.be.revertedWithCustomError(ctx.escrow, "NativeNotAllowed");
    });

    it("locks BNB with no allowance step", async () => {
      const ctx = await nativeFixture();
      await expect(fundNative(ctx))
        .to.emit(ctx.escrow, "Funded")
        .withArgs(
          NATIVE_TRADE,
          ctx.seller.address,
          ctx.buyer.address,
          ZeroAddress,
          NATIVE_AMOUNT,
          NATIVE_FEE,
          anyValue,
        );

      expect(await hre.ethers.provider.getBalance(await ctx.escrow.getAddress())).to.equal(
        NATIVE_AMOUNT,
      );
    });

    it("pays the buyer in BNB net of the fee", async () => {
      const ctx = await nativeFixture();
      await fundNative(ctx);

      await expect(ctx.escrow.connect(ctx.seller).release(NATIVE_TRADE)).to.changeEtherBalances(
        [ctx.buyer, ctx.feeCollector],
        [NATIVE_AMOUNT - NATIVE_FEE, NATIVE_FEE],
      );
      expect(await hre.ethers.provider.getBalance(await ctx.escrow.getAddress())).to.equal(0);
    });

    it("refunds BNB in full after the timeout", async () => {
      const ctx = await nativeFixture();
      await fundNative(ctx);
      await time.increase(WINDOW + 1);

      await expect(
        ctx.escrow.connect(ctx.stranger).refundAfterTimeout(NATIVE_TRADE),
      ).to.changeEtherBalances([ctx.seller, ctx.feeCollector], [NATIVE_AMOUNT, 0]);
    });

    it("settles a disputed BNB trade through the arbiter", async () => {
      const ctx = await nativeFixture();
      await fundNative(ctx);
      await ctx.escrow.connect(ctx.buyer).dispute(NATIVE_TRADE);

      await expect(
        ctx.escrow.connect(ctx.arbiter).resolve(NATIVE_TRADE, false),
      ).to.changeEtherBalances([ctx.seller], [NATIVE_AMOUNT]);
    });

    it("rejects a zero-value deposit", async () => {
      const ctx = await nativeFixture();
      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .fundEscrowNative(NATIVE_TRADE, ctx.buyer.address, 0, WINDOW, { value: 0 }),
      ).to.be.revertedWithCustomError(ctx.escrow, "ZeroAmount");
    });

    it("applies the same fee ceiling as the token path", async () => {
      const ctx = await nativeFixture();
      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .fundEscrowNative(NATIVE_TRADE, ctx.buyer.address, (NATIVE_AMOUNT * 1001n) / 10_000n, WINDOW, {
            value: NATIVE_AMOUNT,
          }),
      ).to.be.revertedWithCustomError(ctx.escrow, "FeeTooHigh");
    });

    it("shares the trade id space with token escrows", async () => {
      const ctx = await nativeFixture();
      await fund(ctx); // TRADE_ID, ERC-20
      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .fundEscrowNative(TRADE_ID, ctx.buyer.address, NATIVE_FEE, WINDOW, { value: NATIVE_AMOUNT }),
      ).to.be.revertedWithCustomError(ctx.escrow, "TradeExists");
    });
  });

  describe("admin", () => {
    it("pauses new escrows without trapping funds already locked", async () => {
      const ctx = await loadFixture(deployFixture);
      await fund(ctx);
      await ctx.escrow.pause();

      const second = keccak256(toUtf8Bytes("another-trade"));
      await expect(
        ctx.escrow
          .connect(ctx.seller)
          .fundEscrow(second, ctx.buyer.address, await ctx.token.getAddress(), AMOUNT, FEE, WINDOW),
      ).to.be.revertedWithCustomError(ctx.escrow, "EnforcedPause");

      // The existing escrow still settles normally.
      await expect(ctx.escrow.connect(ctx.seller).release(TRADE_ID)).to.emit(ctx.escrow, "Released");
    });

    it("restricts arbiter and fee collector changes to the owner", async () => {
      const ctx = await loadFixture(deployFixture);

      await expect(ctx.escrow.connect(ctx.arbiter).setArbiter(ctx.stranger.address)).to.be.revertedWithCustomError(
        ctx.escrow,
        "OwnableUnauthorizedAccount",
      );
      await expect(ctx.escrow.setFeeCollector(ZeroAddress)).to.be.revertedWithCustomError(ctx.escrow, "ZeroAddress");

      await expect(ctx.escrow.setArbiter(ctx.stranger.address)).to.emit(ctx.escrow, "ArbiterUpdated");
      expect(await ctx.escrow.arbiter()).to.equal(ctx.stranger.address);
    });
  });
});
