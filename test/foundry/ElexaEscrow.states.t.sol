// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ElexaEscrow} from "../../contracts/ElexaEscrow.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// @notice Systematic status × function transition matrix.
contract ElexaEscrowStatesTest is Test {
    ElexaEscrow internal escrow;
    MockERC20 internal token;

    address internal owner = makeAddr("owner");
    address internal arbiter = makeAddr("arbiter");
    address internal feeCollector = makeAddr("feeCollector");
    address internal seller = makeAddr("seller");
    address internal buyer = makeAddr("buyer");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AMOUNT = 100e18;
    uint256 internal constant FEE = 1e18;
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

    function _id(string memory s) internal pure returns (bytes32) {
        return keccak256(bytes(s));
    }

    function _fundToken(bytes32 id) internal {
        vm.prank(seller);
        escrow.fundEscrow(id, buyer, address(token), AMOUNT, FEE, WINDOW);
    }

    function _fundNative(bytes32 id) internal {
        vm.prank(seller);
        escrow.fundEscrowNative{value: AMOUNT}(id, buyer, FEE, WINDOW);
    }

    // ── None ────────────────────────────────────────────────────────────

    function test_None_fundEscrow_ok() public {
        _fundToken(_id("n1"));
        assertEq(uint8(escrow.getEscrow(_id("n1")).status), uint8(ElexaEscrow.Status.Funded));
    }

    function test_None_fundEscrowNative_ok() public {
        _fundNative(_id("n2"));
        assertEq(uint8(escrow.getEscrow(_id("n2")).status), uint8(ElexaEscrow.Status.Funded));
    }

    function test_None_markPaid_BadStatus() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.None));
        escrow.markPaid(_id("missing"));
    }

    function test_None_dispute_BadStatus() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.None));
        escrow.dispute(_id("missing"));
    }

    function test_None_release_BadStatus() public {
        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.None));
        escrow.release(_id("missing"));
    }

    function test_None_buyerCancel_BadStatus() public {
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.None));
        escrow.buyerCancel(_id("missing"));
    }

    function test_None_refundAfterTimeout_BadStatus() public {
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.None));
        escrow.refundAfterTimeout(_id("missing"));
    }

    function test_None_resolve_BadStatus() public {
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.None));
        escrow.resolve(_id("missing"), true);
    }

    // ── Funded ──────────────────────────────────────────────────────────

    function test_Funded_markPaid_buyer_ok() public {
        bytes32 id = _id("f1");
        _fundToken(id);
        vm.prank(buyer);
        escrow.markPaid(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Paid));
    }

    function test_Funded_markPaid_arbiter_ok() public {
        bytes32 id = _id("f2");
        _fundToken(id);
        vm.prank(arbiter);
        escrow.markPaid(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Paid));
    }

    function test_Funded_dispute_buyer_ok() public {
        bytes32 id = _id("f3");
        _fundToken(id);
        vm.prank(buyer);
        escrow.dispute(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Disputed));
    }

    function test_Funded_dispute_seller_ok() public {
        bytes32 id = _id("f4");
        _fundToken(id);
        vm.prank(seller);
        escrow.dispute(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Disputed));
    }

    function test_Funded_release_seller_ok() public {
        bytes32 id = _id("f5");
        _fundToken(id);
        uint256 buyerBefore = token.balanceOf(buyer);
        vm.prank(seller);
        escrow.release(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Released));
        assertEq(token.balanceOf(buyer) - buyerBefore, AMOUNT - FEE);
    }

    function test_Funded_buyerCancel_ok() public {
        bytes32 id = _id("f6");
        _fundToken(id);
        vm.prank(buyer);
        escrow.buyerCancel(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Refunded));
    }

    function test_Funded_refundAfterTimeout_tooEarly() public {
        bytes32 id = _id("f7");
        _fundToken(id);
        vm.expectRevert();
        escrow.refundAfterTimeout(id);
    }

    function test_Funded_refundAfterTimeout_ok() public {
        bytes32 id = _id("f8");
        _fundToken(id);
        vm.warp(block.timestamp + WINDOW);
        vm.prank(stranger);
        escrow.refundAfterTimeout(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Refunded));
    }

    function test_Funded_resolve_BadStatus() public {
        bytes32 id = _id("f9");
        _fundToken(id);
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Funded));
        escrow.resolve(id, true);
    }

    function test_Funded_duplicateFund_TradeExists() public {
        bytes32 id = _id("f10");
        _fundToken(id);
        vm.prank(seller);
        vm.expectRevert(ElexaEscrow.TradeExists.selector);
        escrow.fundEscrow(id, buyer, address(token), AMOUNT, FEE, WINDOW);
    }

    // ── Paid ────────────────────────────────────────────────────────────

    function test_Paid_markPaid_BadStatus() public {
        bytes32 id = _id("p1");
        _fundToken(id);
        vm.prank(buyer);
        escrow.markPaid(id);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Paid));
        escrow.markPaid(id);
    }

    function test_Paid_dispute_ok() public {
        bytes32 id = _id("p2");
        _fundToken(id);
        vm.prank(buyer);
        escrow.markPaid(id);
        vm.prank(seller);
        escrow.dispute(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Disputed));
    }

    function test_Paid_release_ok() public {
        bytes32 id = _id("p3");
        _fundToken(id);
        vm.prank(buyer);
        escrow.markPaid(id);
        vm.prank(seller);
        escrow.release(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Released));
    }

    function test_Paid_buyerCancel_BadStatus() public {
        bytes32 id = _id("p4");
        _fundToken(id);
        vm.prank(buyer);
        escrow.markPaid(id);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Paid));
        escrow.buyerCancel(id);
    }

    function test_Paid_refundAfterTimeout_BadStatus() public {
        bytes32 id = _id("p5");
        _fundToken(id);
        vm.prank(buyer);
        escrow.markPaid(id);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Paid));
        escrow.refundAfterTimeout(id);
    }

    function test_Paid_resolve_BadStatus() public {
        bytes32 id = _id("p6");
        _fundToken(id);
        vm.prank(buyer);
        escrow.markPaid(id);
        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Paid));
        escrow.resolve(id, true);
    }

    // ── Disputed ────────────────────────────────────────────────────────

    function test_Disputed_release_ok() public {
        bytes32 id = _id("d1");
        _fundToken(id);
        vm.prank(buyer);
        escrow.dispute(id);
        vm.prank(seller);
        escrow.release(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Released));
    }

    function test_Disputed_resolve_toBuyer() public {
        bytes32 id = _id("d2");
        _fundToken(id);
        vm.prank(buyer);
        escrow.dispute(id);
        vm.prank(arbiter);
        escrow.resolve(id, true);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Released));
    }

    function test_Disputed_resolve_toSeller() public {
        bytes32 id = _id("d3");
        _fundToken(id);
        vm.prank(buyer);
        escrow.dispute(id);
        vm.prank(arbiter);
        escrow.resolve(id, false);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Refunded));
    }

    function test_Disputed_markPaid_BadStatus() public {
        bytes32 id = _id("d4");
        _fundToken(id);
        vm.prank(buyer);
        escrow.dispute(id);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Disputed));
        escrow.markPaid(id);
    }

    function test_Disputed_buyerCancel_BadStatus() public {
        bytes32 id = _id("d5");
        _fundToken(id);
        vm.prank(buyer);
        escrow.dispute(id);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Disputed));
        escrow.buyerCancel(id);
    }

    function test_Disputed_refundAfterTimeout_BadStatus() public {
        bytes32 id = _id("d6");
        _fundToken(id);
        vm.prank(buyer);
        escrow.dispute(id);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Disputed));
        escrow.refundAfterTimeout(id);
    }

    // ── Released / Refunded terminal ────────────────────────────────────

    function test_Released_allSettlement_BadStatus() public {
        bytes32 id = _id("r1");
        _fundToken(id);
        vm.prank(seller);
        escrow.release(id);

        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Released));
        escrow.markPaid(id);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Released));
        escrow.release(id);

        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Released));
        escrow.resolve(id, true);
    }

    function test_Refunded_allSettlement_BadStatus() public {
        bytes32 id = _id("rf1");
        _fundToken(id);
        vm.prank(buyer);
        escrow.buyerCancel(id);

        vm.prank(seller);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Refunded));
        escrow.release(id);

        vm.prank(arbiter);
        vm.expectRevert(abi.encodeWithSelector(ElexaEscrow.BadStatus.selector, ElexaEscrow.Status.Refunded));
        escrow.resolve(id, false);
    }

    // ── Pause vs funding ────────────────────────────────────────────────

    function test_Paused_fund_reverts() public {
        vm.prank(owner);
        escrow.pause();
        vm.prank(seller);
        vm.expectRevert();
        escrow.fundEscrow(_id("pause1"), buyer, address(token), AMOUNT, FEE, WINDOW);
    }

    function test_Paused_settlement_still_works() public {
        bytes32 id = _id("pause2");
        _fundToken(id);
        vm.prank(owner);
        escrow.pause();
        vm.prank(buyer);
        escrow.markPaid(id);
        vm.prank(seller);
        escrow.release(id);
        assertEq(uint8(escrow.getEscrow(id).status), uint8(ElexaEscrow.Status.Released));
    }
}
