// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ElexaEscrow} from "../../contracts/ElexaEscrow.sol";
import {MockERC20} from "../../contracts/test/MockERC20.sol";

/// @notice Bounded caller for invariant fuzzing. Prefer zero handler reverts.
contract EscrowHandler is Test {
    ElexaEscrow public immutable escrow;
    MockERC20 public immutable token;
    address public immutable owner;
    address public immutable arbiter;

    address[] public sellers;
    address[] public buyers;

    bytes32[] public tradeIds;
    mapping(bytes32 => bool) public seenTrade;

    /// @dev Sum of `amount` for escrows still in Funded / Paid / Disputed (token vs native).
    uint256 public openPrincipalToken;
    uint256 public openPrincipalNative;

    /// @dev Ghosts for settlement-path invariants.
    bool public lastSuccessfulResolve;
    bool public lastResolveWasDisputed;
    bytes32 public lastResolvedTrade;
    bool public lastResolveToBuyer;

    bool public lastSuccessfulTimeoutRefund;
    bytes32 public lastTimeoutTrade;
    address public lastTimeoutCaller;
    uint256 public lastTimeoutAmount;

    bool public lastSuccessfulRefundOrCancel;
    bytes32 public lastRefundTrade;
    uint256 public lastRefundAmount;
    bool public lastRefundWasCancel;

    bool public lastSuccessfulRelease;
    bytes32 public lastReleaseTrade;
    uint256 public lastReleasePayout;
    uint256 public lastReleaseFee;
    address public lastReleaseFeeCollector;

    uint256 public handlerCalls;
    uint256 public handlerReverts;

    /// @dev Snapshots at funding time for immutability checks.
    mapping(bytes32 => uint256) public fundedAmount;
    mapping(bytes32 => uint256) public fundedFee;
    mapping(bytes32 => address) public fundedSeller;
    mapping(bytes32 => address) public fundedBuyer;
    mapping(bytes32 => address) public fundedToken;

    constructor(
        ElexaEscrow escrow_,
        MockERC20 token_,
        address owner_,
        address arbiter_,
        address[] memory sellers_,
        address[] memory buyers_
    ) {
        escrow = escrow_;
        token = token_;
        owner = owner_;
        arbiter = arbiter_;
        sellers = sellers_;
        buyers = buyers_;
    }

    function tradeCount() external view returns (uint256) {
        return tradeIds.length;
    }

    function _seller(uint256 seed) internal view returns (address) {
        return sellers[seed % sellers.length];
    }

    function _buyer(uint256 seed) internal view returns (address) {
        return buyers[seed % buyers.length];
    }

    function _trade(uint256 seed) internal view returns (bytes32) {
        if (tradeIds.length == 0) return bytes32(0);
        return tradeIds[seed % tradeIds.length];
    }

    function _boundFee(uint256 amount, uint256 feeSeed) internal pure returns (uint256) {
        uint256 maxFee = (amount * 1000) / 10_000;
        if (maxFee == 0) return 0;
        return feeSeed % (maxFee + 1);
    }

    function _boundWindow(uint256 windowSeed) internal view returns (uint64) {
        uint64 minW = escrow.MIN_PAYMENT_WINDOW();
        uint64 maxW = escrow.MAX_PAYMENT_WINDOW();
        return uint64(minW + (windowSeed % uint256(maxW - minW + 1)));
    }

    function _openAdd(address tokenAddr, uint256 amount) internal {
        if (tokenAddr == address(0)) openPrincipalNative += amount;
        else openPrincipalToken += amount;
    }

    function _openSub(address tokenAddr, uint256 amount) internal {
        if (tokenAddr == address(0)) {
            openPrincipalNative -= amount;
        } else {
            openPrincipalToken -= amount;
        }
    }

    function fund(uint256 sellerSeed, uint256 buyerSeed, uint256 amountSeed, uint256 feeSeed, uint256 windowSeed)
        external
    {
        handlerCalls++;
        address seller = _seller(sellerSeed);
        address buyer = _buyer(buyerSeed);
        if (seller == buyer) {
            buyer = _buyer(buyerSeed + 1);
            if (seller == buyer) return;
        }

        uint256 amount = bound(amountSeed, 1e15, 100e18);
        uint256 fee = _boundFee(amount, feeSeed);
        uint64 window = _boundWindow(windowSeed);
        bytes32 tradeId = keccak256(abi.encode("t", handlerCalls, seller, buyer, amount, fee, block.timestamp));
        if (seenTrade[tradeId] || escrow.getEscrow(tradeId).status != ElexaEscrow.Status.None) return;

        token.mint(seller, amount);
        vm.startPrank(seller);
        token.approve(address(escrow), amount);
        try escrow.fundEscrow(tradeId, buyer, address(token), amount, fee, window) {
            seenTrade[tradeId] = true;
            tradeIds.push(tradeId);
            _openAdd(address(token), amount);
            fundedAmount[tradeId] = amount;
            fundedFee[tradeId] = fee;
            fundedSeller[tradeId] = seller;
            fundedBuyer[tradeId] = buyer;
            fundedToken[tradeId] = address(token);
        } catch {
            handlerReverts++;
        }
        vm.stopPrank();
    }

    function fundNative(uint256 sellerSeed, uint256 buyerSeed, uint256 amountSeed, uint256 feeSeed, uint256 windowSeed)
        external
    {
        handlerCalls++;
        if (!escrow.nativeAllowed()) return;
        if (escrow.paused()) return;

        address seller = _seller(sellerSeed);
        address buyer = _buyer(buyerSeed);
        if (seller == buyer) {
            buyer = _buyer(buyerSeed + 1);
            if (seller == buyer) return;
        }

        uint256 amount = bound(amountSeed, 1e15, 50e18);
        uint256 fee = _boundFee(amount, feeSeed);
        uint64 window = _boundWindow(windowSeed);
        bytes32 tradeId = keccak256(abi.encode("n", handlerCalls, seller, buyer, amount, fee, block.timestamp));
        if (seenTrade[tradeId] || escrow.getEscrow(tradeId).status != ElexaEscrow.Status.None) return;

        vm.deal(seller, amount);
        vm.prank(seller);
        try escrow.fundEscrowNative{value: amount}(tradeId, buyer, fee, window) {
            seenTrade[tradeId] = true;
            tradeIds.push(tradeId);
            _openAdd(address(0), amount);
            fundedAmount[tradeId] = amount;
            fundedFee[tradeId] = fee;
            fundedSeller[tradeId] = seller;
            fundedBuyer[tradeId] = buyer;
            fundedToken[tradeId] = address(0);
        } catch {
            handlerReverts++;
        }
    }

    function markPaidBuyer(uint256 tradeSeed) external {
        handlerCalls++;
        bytes32 tradeId = _trade(tradeSeed);
        if (tradeId == bytes32(0)) return;
        ElexaEscrow.Escrow memory e = escrow.getEscrow(tradeId);
        if (e.status != ElexaEscrow.Status.Funded) return;
        vm.prank(e.buyer);
        try escrow.markPaid(tradeId) {} catch {
            handlerReverts++;
        }
    }

    function markPaidArbiter(uint256 tradeSeed) external {
        handlerCalls++;
        bytes32 tradeId = _trade(tradeSeed);
        if (tradeId == bytes32(0)) return;
        ElexaEscrow.Escrow memory e = escrow.getEscrow(tradeId);
        if (e.status != ElexaEscrow.Status.Funded) return;
        vm.prank(arbiter);
        try escrow.markPaid(tradeId) {} catch {
            handlerReverts++;
        }
    }

    function disputeBuyer(uint256 tradeSeed) external {
        handlerCalls++;
        bytes32 tradeId = _trade(tradeSeed);
        if (tradeId == bytes32(0)) return;
        ElexaEscrow.Escrow memory e = escrow.getEscrow(tradeId);
        if (e.status != ElexaEscrow.Status.Funded && e.status != ElexaEscrow.Status.Paid) return;
        vm.prank(e.buyer);
        try escrow.dispute(tradeId) {} catch {
            handlerReverts++;
        }
    }

    function disputeSeller(uint256 tradeSeed) external {
        handlerCalls++;
        bytes32 tradeId = _trade(tradeSeed);
        if (tradeId == bytes32(0)) return;
        ElexaEscrow.Escrow memory e = escrow.getEscrow(tradeId);
        if (e.status != ElexaEscrow.Status.Funded && e.status != ElexaEscrow.Status.Paid) return;
        vm.prank(e.seller);
        try escrow.dispute(tradeId) {} catch {
            handlerReverts++;
        }
    }

    function release(uint256 tradeSeed) external {
        handlerCalls++;
        bytes32 tradeId = _trade(tradeSeed);
        if (tradeId == bytes32(0)) return;
        ElexaEscrow.Escrow memory e = escrow.getEscrow(tradeId);
        if (
            e.status != ElexaEscrow.Status.Funded && e.status != ElexaEscrow.Status.Paid
                && e.status != ElexaEscrow.Status.Disputed
        ) return;

        uint256 fee = e.fee;
        uint256 payout = e.amount - fee;
        address feeCol = escrow.feeCollector();
        address tok = e.token;

        vm.prank(e.seller);
        try escrow.release(tradeId) {
            _openSub(tok, e.amount);
            lastSuccessfulRelease = true;
            lastReleaseTrade = tradeId;
            lastReleasePayout = payout;
            lastReleaseFee = fee;
            lastReleaseFeeCollector = feeCol;
        } catch {
            handlerReverts++;
        }
    }

    function buyerCancel(uint256 tradeSeed) external {
        handlerCalls++;
        bytes32 tradeId = _trade(tradeSeed);
        if (tradeId == bytes32(0)) return;
        ElexaEscrow.Escrow memory e = escrow.getEscrow(tradeId);
        if (e.status != ElexaEscrow.Status.Funded) return;

        uint256 amount = e.amount;
        address tok = e.token;

        vm.prank(e.buyer);
        try escrow.buyerCancel(tradeId) {
            _openSub(tok, amount);
            lastSuccessfulRefundOrCancel = true;
            lastRefundTrade = tradeId;
            lastRefundAmount = amount;
            lastRefundWasCancel = true;
        } catch {
            handlerReverts++;
        }
    }

    function refundAfterTimeout(uint256 tradeSeed, uint256 strangerSeed) external {
        handlerCalls++;
        bytes32 tradeId = _trade(tradeSeed);
        if (tradeId == bytes32(0)) return;
        ElexaEscrow.Escrow memory e = escrow.getEscrow(tradeId);
        if (e.status != ElexaEscrow.Status.Funded) return;

        if (block.timestamp < e.refundableAt) {
            vm.warp(uint256(e.refundableAt));
        }

        address stranger = address(uint160(uint256(keccak256(abi.encode("stranger", strangerSeed)))));
        if (stranger == address(0) || stranger == address(escrow)) stranger = address(0xBEEF);

        uint256 amount = e.amount;
        address tok = e.token;

        vm.prank(stranger);
        try escrow.refundAfterTimeout(tradeId) {
            _openSub(tok, amount);
            lastSuccessfulTimeoutRefund = true;
            lastTimeoutTrade = tradeId;
            lastTimeoutCaller = stranger;
            lastTimeoutAmount = amount;
            lastSuccessfulRefundOrCancel = true;
            lastRefundTrade = tradeId;
            lastRefundAmount = amount;
            lastRefundWasCancel = false;
        } catch {
            handlerReverts++;
        }
    }

    function resolve(uint256 tradeSeed, bool toBuyer) external {
        handlerCalls++;
        bytes32 tradeId = _trade(tradeSeed);
        if (tradeId == bytes32(0)) return;
        ElexaEscrow.Escrow memory e = escrow.getEscrow(tradeId);
        if (e.status != ElexaEscrow.Status.Disputed) return;

        uint256 amount = e.amount;
        uint256 fee = e.fee;
        address tok = e.token;
        address feeCol = escrow.feeCollector();

        lastResolveWasDisputed = true;
        vm.prank(arbiter);
        try escrow.resolve(tradeId, toBuyer) {
            _openSub(tok, amount);
            lastSuccessfulResolve = true;
            lastResolvedTrade = tradeId;
            lastResolveToBuyer = toBuyer;
            if (toBuyer) {
                lastSuccessfulRelease = true;
                lastReleaseTrade = tradeId;
                lastReleasePayout = amount - fee;
                lastReleaseFee = fee;
                lastReleaseFeeCollector = feeCol;
            } else {
                lastSuccessfulRefundOrCancel = true;
                lastRefundTrade = tradeId;
                lastRefundAmount = amount;
                lastRefundWasCancel = false;
            }
        } catch {
            handlerReverts++;
            lastResolveWasDisputed = false;
        }
    }

    function pause() external {
        handlerCalls++;
        vm.prank(owner);
        try escrow.pause() {} catch {
            handlerReverts++;
        }
    }

    function unpause() external {
        handlerCalls++;
        vm.prank(owner);
        try escrow.unpause() {} catch {
            handlerReverts++;
        }
    }

    function setFeeCollector(uint256 seed) external {
        handlerCalls++;
        address next = address(uint160(uint256(keccak256(abi.encode("feeCol", seed)))));
        if (next == address(0) || next == address(escrow)) next = address(0xFEE1);
        vm.prank(owner);
        try escrow.setFeeCollector(next) {} catch {
            handlerReverts++;
        }
    }
}
