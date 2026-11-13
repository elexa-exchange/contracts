// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ElexaEscrow} from "../../contracts/ElexaEscrow.sol";
import {MockERC20, FeeOnTransferERC20} from "../../contracts/test/MockERC20.sol";

contract RejectEther {
    receive() external payable {
        revert("nope");
    }
}

/// @notice Gap checks and bounds the Hardhat suite / trust page leave explicit.
contract ElexaEscrowUnitTest is Test {
    ElexaEscrow internal escrow;
    MockERC20 internal token;

    address internal owner = makeAddr("owner");
    address internal arbiter = makeAddr("arbiter");
    address internal feeCollector = makeAddr("feeCollector");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");

    uint256 internal constant AMOUNT = 100e18;
    uint64 internal constant WINDOW = 1 hours;

    function setUp() public {
        token = new MockERC20();
        escrow = new ElexaEscrow(owner, arbiter, feeCollector);
        vm.startPrank(owner);
        escrow.setTokenAllowed(address(token), true);
        escrow.setNativeAllowed(true);
        vm.stopPrank();
        token.mint(seller, 1_000_000e18);
        vm.prank(seller);
        token.approve(address(escrow), type(uint256).max);
        vm.deal(seller, 1_000 ether);
    }

    function _fund(bytes32 id, uint256 fee) internal {
        vm.prank(seller);
        escrow.fundEscrow(id, buyer, address(token), AMOUNT, fee, WINDOW);
    }

    /// @dev Seller can release from Funded without markPaid (UI vs contract nuance, not a bug).
    function test_sellerReleaseFromFundedWithoutMarkPaid() public {
        bytes32 id = keccak256("gap-release-funded");
        _fund(id, 1e18);
        vm.prank(seller);
        escrow.release(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Released));
    }

    /// @dev Arbiter markPaid on undisputed Funded blocks timeout refund (trust-page wording nuance).
    function test_arbiterMarkPaidBlocksTimeoutRefund() public {
        bytes32 id = keccak256("gap-arbiter-mark");
        _fund(id, 1e18);
        vm.prank(arbiter);
        escrow.markPaid(id);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Paid));
        escrow.refundAfterTimeout(id);
    }

    function test_pauseAllowsSettlementPaths() public {
        bytes32 id = keccak256("gap-pause");
        _fund(id, 1e18);
        vm.prank(owner);
        escrow.pause();

        vm.prank(buyer);
        escrow.markPaid(id);
        // reopen another for timeout / dispute / cancel coverage
        bytes32 id2 = keccak256("gap-pause-2");
        // funding blocked while paused
        vm.prank(seller);
        vm.expectRevert();
        escrow.fundEscrow(id2, buyer, address(token), AMOUNT, 0, WINDOW);

        vm.prank(owner);
        escrow.unpause();
        _fund(id2, 0);
        vm.prank(owner);
        escrow.pause();

        vm.prank(buyer);
        escrow.dispute(id2);
        vm.prank(arbiter);
        escrow.resolve(id2, false);

        bytes32 id3 = keccak256("gap-pause-3");
        vm.prank(owner);
        escrow.unpause();
        _fund(id3, 0);
        vm.prank(owner);
        escrow.pause();
        vm.warp(block.timestamp + WINDOW);
        escrow.refundAfterTimeout(id3);

        bytes32 id4 = keccak256("gap-pause-4");
        vm.prank(owner);
        escrow.unpause();
        _fund(id4, 0);
        vm.prank(owner);
        escrow.pause();
        vm.prank(buyer);
        escrow.buyerCancel(id4);
    }

    function test_feeCollectorChangeMidFlightRedirectsFee() public {
        bytes32 id = keccak256("gap-feecol");
        _fund(id, 5e18);
        address newCol = makeAddr("newFeeCol");
        vm.prank(owner);
        escrow.setFeeCollector(newCol);

        uint256 beforeOld = token.balanceOf(feeCollector);
        uint256 beforeNew = token.balanceOf(newCol);
        vm.prank(seller);
        escrow.release(id);
        assertEq(token.balanceOf(feeCollector) - beforeOld, 0);
        assertEq(token.balanceOf(newCol) - beforeNew, 5e18);
    }

    function test_feeExactTenPercentAccepted() public {
        bytes32 id = keccak256("fee-10");
        uint256 fee = (AMOUNT * 1000) / 10_000;
        _fund(id, fee);
        assertEq(escrow.getEscrow(id).fee, fee);
    }

    function test_feeTenPercentPlusOneWeiRejected() public {
        bytes32 id = keccak256("fee-10p1");
        uint256 fee = (AMOUNT * 1000) / 10_000 + 1;
        vm.prank(seller);
        vm.expectRevert(ElexaEscrow.FeeTooHigh.selector);
        escrow.fundEscrow(id, buyer, address(token), AMOUNT, fee, WINDOW);
    }

    function test_feeExactTenPercentNativeAccepted() public {
        bytes32 id = keccak256("fee-10-n");
        uint256 fee = (AMOUNT * 1000) / 10_000;
        vm.prank(seller);
        escrow.fundEscrowNative{value: AMOUNT}(id, buyer, fee, WINDOW);
    }

    function test_feeTenPercentPlusOneWeiNativeRejected() public {
        bytes32 id = keccak256("fee-10p1-n");
        uint256 fee = (AMOUNT * 1000) / 10_000 + 1;
        vm.prank(seller);
        vm.expectRevert(ElexaEscrow.FeeTooHigh.selector);
        escrow.fundEscrowNative{value: AMOUNT}(id, buyer, fee, WINDOW);
    }

    function test_windowExactBounds() public {
        uint64 minW = escrow.MIN_PAYMENT_WINDOW();
        uint64 maxW = escrow.MAX_PAYMENT_WINDOW();

        vm.prank(seller);
        escrow.fundEscrow(keccak256("wmin"), buyer, address(token), AMOUNT, 0, minW);
        vm.prank(seller);
        escrow.fundEscrow(keccak256("wmax"), buyer, address(token), AMOUNT, 0, maxW);

        vm.prank(seller);
        vm.expectRevert(ElexaEscrow.BadWindow.selector);
        escrow.fundEscrow(keccak256("wmin-1"), buyer, address(token), AMOUNT, 0, minW - 1);

        vm.prank(seller);
        vm.expectRevert(ElexaEscrow.BadWindow.selector);
        escrow.fundEscrow(keccak256("wmax+1"), buyer, address(token), AMOUNT, 0, maxW + 1);
    }

    function test_windowExactBoundsNative() public {
        uint64 minW = escrow.MIN_PAYMENT_WINDOW();
        uint64 maxW = escrow.MAX_PAYMENT_WINDOW();
        vm.prank(seller);
        escrow.fundEscrowNative{value: AMOUNT}(keccak256("nwmin"), buyer, 0, minW);
        vm.prank(seller);
        escrow.fundEscrowNative{value: AMOUNT}(keccak256("nwmax"), buyer, 0, maxW);
        vm.prank(seller);
        vm.expectRevert(ElexaEscrow.BadWindow.selector);
        escrow.fundEscrowNative{value: AMOUNT}(keccak256("nwbad"), buyer, 0, minW - 1);
    }

    function test_buyerMarkPaid() public {
        bytes32 id = keccak256("buyer-mark");
        _fund(id, 0);
        vm.prank(buyer);
        escrow.markPaid(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Paid));
    }

    function test_nativeBuyerCancel() public {
        bytes32 id = keccak256("native-cancel");
        uint256 before = seller.balance;
        vm.prank(seller);
        escrow.fundEscrowNative{value: AMOUNT}(id, buyer, 1e18, WINDOW);
        vm.prank(buyer);
        escrow.buyerCancel(id);
        assertEq(seller.balance, before);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Refunded));
    }

    function test_tradeExistsAcrossTokenAndNativeIdSpace() public {
        bytes32 id = keccak256("shared-id");
        _fund(id, 0);
        vm.prank(seller);
        vm.expectRevert(ElexaEscrow.TradeExists.selector);
        escrow.fundEscrowNative{value: AMOUNT}(id, buyer, 0, WINDOW);
    }

    function test_feeOnTransferRejectedWhenAllowListed() public {
        FeeOnTransferERC20 skim = new FeeOnTransferERC20();
        vm.prank(owner);
        escrow.setTokenAllowed(address(skim), true);
        skim.mint(seller, AMOUNT);
        vm.startPrank(seller);
        skim.approve(address(escrow), AMOUNT);
        vm.expectRevert(ElexaEscrow.UnexpectedBalanceChange.selector);
        escrow.fundEscrow(keccak256("fot"), buyer, address(skim), AMOUNT, 0, WINDOW);
        vm.stopPrank();
    }

    function test_setArbiterAndFeeCollectorRejectZeroAndOnlyOwner() public {
        vm.prank(owner);
        vm.expectRevert(ElexaEscrow.ZeroAddress.selector);
        escrow.setArbiter(address(0));
        vm.prank(owner);
        vm.expectRevert(ElexaEscrow.ZeroAddress.selector);
        escrow.setFeeCollector(address(0));

        vm.prank(buyer);
        vm.expectRevert();
        escrow.setArbiter(makeAddr("x"));
    }

    function test_rejectingNativeBuyerAfterMarkPaid() public {
        RejectEther rej = new RejectEther();
        bytes32 id = keccak256("rej");
        vm.prank(seller);
        escrow.fundEscrowNative{value: AMOUNT}(id, address(rej), 1e18, WINDOW);

        vm.prank(arbiter);
        escrow.markPaid(id);

        vm.prank(seller);
        vm.expectRevert(ElexaEscrow.NativeTransferFailed.selector);
        escrow.release(id);

        vm.prank(seller);
        escrow.dispute(id);

        vm.prank(arbiter);
        vm.expectRevert(ElexaEscrow.NativeTransferFailed.selector);
        escrow.resolve(id, true);

        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Disputed));
        escrow.refundAfterTimeout(id);

        uint256 sellerBefore = seller.balance;
        vm.prank(arbiter);
        escrow.resolve(id, false);
        assertEq(seller.balance - sellerBefore, AMOUNT);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Refunded));
    }
}
