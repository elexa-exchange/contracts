// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

/// @title ElexaEscrow
/// @notice Non-custodial escrow for Elexa P2P trades on BNB Smart Chain.
///
/// The seller locks BEP-20 tokens against a trade id minted by the Elexa
/// backend. From there the platform is only an arbiter:
///
///   - It can never move funds to itself. Payouts only ever reach the buyer,
///     the seller, or the fee collector, and the fee is bounded at funding time.
///   - It can only act at all on a trade that someone has explicitly disputed.
///   - An undisputed trade that nobody releases refunds itself to the seller
///     once its deadline passes, and *anyone* may push that refund through.
///
/// Timeout-first, in other words: the happy path and the abandoned path both
/// resolve without the platform, so a compromised arbiter key cannot touch the
/// overwhelming majority of escrows.
///
/// @dev Trade ids are supplied by the caller's application (keccak256 of its own
/// trade identifier) so an indexer can map an event back to a record without
/// extra bookkeeping.
contract ElexaEscrow is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    enum Status {
        None, // never funded
        Funded, // seller's tokens locked, refund clock running
        Paid, // buyer claims fiat is sent; refund clock frozen
        Disputed, // arbiter may now resolve
        Released, // paid out to buyer
        Refunded // returned to seller
    }

    struct Escrow {
        address seller;
        address buyer;
        /// @dev address(0) means the chain's native coin (BNB), not a token.
        address token;
        uint256 amount; // total locked, fee inclusive
        uint256 fee; // platform cut, taken only when the buyer is paid
        uint64 refundableAt; // unix seconds; only meaningful while Funded
        Status status;
    }

    /// @notice Bounds on the payment window a trade may be created with, so a
    /// malformed backend call can neither strand funds for a year nor let a
    /// seller reclaim them before the buyer has had a chance to pay.
    uint64 public constant MIN_PAYMENT_WINDOW = 15 minutes;
    uint64 public constant MAX_PAYMENT_WINDOW = 30 days;

    /// @notice Ceiling on the platform cut, in basis points of the locked
    /// amount. Enforced at funding time so no later call can inflate it.
    uint256 public constant MAX_FEE_BPS = 1000; // 10%

    mapping(bytes32 => Escrow) public escrows;

    /// @notice Tokens sellers may lock. Allow-listed rather than open so a
    /// rebasing or fee-on-transfer token can't desynchronise the accounting.
    mapping(address => bool) public tokenAllowed;

    /// @notice Whether the chain's native coin (BNB) may be escrowed.
    /// @dev Separate from `tokenAllowed` because address(0) is rejected there —
    /// letting it into that mapping would make a zero-address typo look like a
    /// valid token.
    bool public nativeAllowed;

    /// @notice Key permitted to freeze the refund clock and settle disputes.
    /// Held by the Elexa backend (or a Safe). Cannot withdraw funds.
    address public arbiter;

    /// @notice Destination for platform fees.
    address public feeCollector;

    event Funded(
        bytes32 indexed tradeId,
        address indexed seller,
        address indexed buyer,
        address token,
        uint256 amount,
        uint256 fee,
        uint64 refundableAt
    );
    event MarkedPaid(bytes32 indexed tradeId, address indexed caller);
    event Disputed(bytes32 indexed tradeId, address indexed caller);
    event Released(bytes32 indexed tradeId, address indexed buyer, uint256 payout, uint256 fee);
    event Refunded(bytes32 indexed tradeId, address indexed seller, uint256 amount);
    event Resolved(bytes32 indexed tradeId, bool toBuyer);
    /// @notice A trade the buyer withdrew from before paying.
    /// @dev Distinct from `Refunded` even though the money moves identically,
    /// because the two say different things about the people involved: a refund
    /// means a buyer stopped responding, a cancellation means they said so. Only
    /// the second is a courtesy, and a marketplace that cannot tell them apart
    /// cannot reward it.
    event Cancelled(bytes32 indexed tradeId, address indexed seller, uint256 amount);
    event ArbiterUpdated(address indexed previous, address indexed current);
    event FeeCollectorUpdated(address indexed previous, address indexed current);
    event TokenAllowanceUpdated(address indexed token, bool allowed);
    event NativeAllowanceUpdated(bool allowed);

    error NotArbiter();
    error NotSeller();
    error NotBuyer();
    error NotParticipant();
    error TradeExists();
    error BadStatus(Status actual);
    error BadWindow();
    error FeeTooHigh();
    error ZeroAddress();
    error ZeroAmount();
    error TooEarly(uint64 refundableAt);
    error TokenNotAllowed();
    error UnexpectedBalanceChange();
    error NativeNotAllowed();
    error WrongValue();
    error NativeTransferFailed();

    modifier onlyArbiter() {
        if (msg.sender != arbiter) revert NotArbiter();
        _;
    }

    constructor(address initialOwner, address initialArbiter, address initialFeeCollector) Ownable(initialOwner) {
        if (initialArbiter == address(0) || initialFeeCollector == address(0)) revert ZeroAddress();
        arbiter = initialArbiter;
        feeCollector = initialFeeCollector;
        emit ArbiterUpdated(address(0), initialArbiter);
        emit FeeCollectorUpdated(address(0), initialFeeCollector);
    }

    // ---------------------------------------------------------------- funding

    /// @notice Lock `amount` of `token` for a trade. Caller is the seller and
    /// must have approved this contract for `amount` first.
    /// @param tradeId keccak256 of the application's own trade identifier.
    /// @param fee platform cut, deducted from `amount` only if the buyer is paid.
    /// @param paymentWindow seconds the buyer has before the seller may reclaim.
    function fundEscrow(
        bytes32 tradeId,
        address buyer,
        address token,
        uint256 amount,
        uint256 fee,
        uint64 paymentWindow
    ) external nonReentrant whenNotPaused {
        if (!tokenAllowed[token]) revert TokenNotAllowed();

        uint64 refundableAt = _record(tradeId, buyer, token, amount, fee, paymentWindow);

        // Reject fee-on-transfer / rebasing tokens outright rather than trying
        // to account for them: if we didn't receive exactly `amount`, the
        // payout arithmetic below would be wrong.
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (IERC20(token).balanceOf(address(this)) - before != amount) revert UnexpectedBalanceChange();

        emit Funded(tradeId, msg.sender, buyer, token, amount, fee, refundableAt);
    }

    /// @notice Lock the chain's native coin (BNB) for a trade.
    /// @dev The amount is `msg.value`; there is no allowance step, so a seller
    /// trading BNB signs one transaction instead of two.
    function fundEscrowNative(
        bytes32 tradeId,
        address buyer,
        uint256 fee,
        uint64 paymentWindow
    ) external payable nonReentrant whenNotPaused {
        if (!nativeAllowed) revert NativeNotAllowed();

        uint64 refundableAt = _record(tradeId, buyer, address(0), msg.value, fee, paymentWindow);

        emit Funded(tradeId, msg.sender, buyer, address(0), msg.value, fee, refundableAt);
    }

    /// @dev Shared validation and storage for both funding paths, so the rules
    /// on windows, fees and duplicate trade ids cannot drift between them.
    function _record(
        bytes32 tradeId,
        address buyer,
        address token,
        uint256 amount,
        uint256 fee,
        uint64 paymentWindow
    ) private returns (uint64 refundableAt) {
        if (escrows[tradeId].status != Status.None) revert TradeExists();
        if (buyer == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (paymentWindow < MIN_PAYMENT_WINDOW || paymentWindow > MAX_PAYMENT_WINDOW) revert BadWindow();
        if (fee > (amount * MAX_FEE_BPS) / 10_000) revert FeeTooHigh();

        refundableAt = uint64(block.timestamp) + paymentWindow;

        escrows[tradeId] = Escrow({
            seller: msg.sender,
            buyer: buyer,
            token: token,
            amount: amount,
            fee: fee,
            refundableAt: refundableAt,
            status: Status.Funded
        });
    }

    // ------------------------------------------------------------- settlement

    /// @notice Freeze the refund clock because the buyer says the fiat is sent.
    /// @dev Callable by the buyer directly, or by the arbiter on their behalf so
    /// a buyer holding no BNB for gas isn't locked out of protecting themselves.
    /// Deliberately harmless: it can only ever delay the seller's refund, never
    /// move funds.
    function markPaid(bytes32 tradeId) external {
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.Funded) revert BadStatus(e.status);
        if (msg.sender != e.buyer && msg.sender != arbiter) revert NotParticipant();

        e.status = Status.Paid;
        emit MarkedPaid(tradeId, msg.sender);
    }

    /// @notice Seller confirms fiat received and pays the buyer out.
    /// @dev Available even while disputed: a seller conceding a dispute should
    /// never have to wait on the arbiter.
    function release(bytes32 tradeId) external nonReentrant {
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.Funded && e.status != Status.Paid && e.status != Status.Disputed) {
            revert BadStatus(e.status);
        }
        if (msg.sender != e.seller) revert NotSeller();

        _payBuyer(tradeId, e);
    }

    /// @notice Open a dispute, handing the arbiter authority over this trade.
    /// @dev Either party may call. From Funded this also stops the refund clock,
    /// so a seller cannot run it out while a complaint is pending.
    function dispute(bytes32 tradeId) external {
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.Funded && e.status != Status.Paid) revert BadStatus(e.status);
        if (msg.sender != e.buyer && msg.sender != e.seller) revert NotParticipant();

        e.status = Status.Disputed;
        emit Disputed(tradeId, msg.sender);
    }

    /// @notice Return an abandoned escrow to the seller once its window lapses.
    /// @dev Permissionless: the seller's refund must not depend on Elexa being
    /// alive. Only reachable from Funded, so a buyer who marked paid or disputed
    /// has already taken this path away.
    function refundAfterTimeout(bytes32 tradeId) external nonReentrant {
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.Funded) revert BadStatus(e.status);
        if (block.timestamp < e.refundableAt) revert TooEarly(e.refundableAt);

        _paySeller(tradeId, e);
    }

    /// @notice Return a trade the buyer has withdrawn from, before its window
    /// lapses.
    /// @dev Buyer only, and only from Funded. Not from Paid: a buyer who has
    /// said they sent the fiat must not be able to hand the money back with one
    /// more click, whether by mistake or because someone talked them into it.
    /// Once they have paid, the ways out are the seller releasing, or a dispute.
    ///
    /// Safe to give the buyer because it can only ever move funds *to the
    /// seller* — the party who deposited them. There is no version of this that
    /// pays the caller, so a buyer gains nothing by calling it except an earlier
    /// end to a trade they had already abandoned.
    function buyerCancel(bytes32 tradeId) external nonReentrant {
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.Funded) revert BadStatus(e.status);
        if (msg.sender != e.buyer) revert NotBuyer();

        _cancelToSeller(tradeId, e);
    }

    /// @notice Settle a disputed trade in favour of one side.
    /// @dev The arbiter's only power over funds, and it is reachable exclusively
    /// from Disputed. Refunds to the seller are made whole; the fee is charged
    /// only when the buyer is paid.
    function resolve(bytes32 tradeId, bool toBuyer) external nonReentrant onlyArbiter {
        Escrow storage e = escrows[tradeId];
        if (e.status != Status.Disputed) revert BadStatus(e.status);

        emit Resolved(tradeId, toBuyer);

        if (toBuyer) {
            _payBuyer(tradeId, e);
        } else {
            _paySeller(tradeId, e);
        }
    }

    // ------------------------------------------------------------- internals

    function _payBuyer(bytes32 tradeId, Escrow storage e) private {
        uint256 fee = e.fee;
        uint256 payout = e.amount - fee;
        address token = e.token;
        address buyer = e.buyer;

        // Status is written before any transfer: with nonReentrant on every
        // settlement path this is belt and braces, but a native payout hands
        // control to the recipient and must not find the escrow still open.
        e.status = Status.Released;

        _send(token, buyer, payout);
        if (fee > 0) _send(token, feeCollector, fee);

        emit Released(tradeId, buyer, payout, fee);
    }

    /// @dev `_paySeller` with a different event. Kept separate rather than
    /// parameterised so neither path can ever emit the other's log by accident —
    /// the indexer decides whether a trade reads as expired or cancelled purely
    /// on which of these two fired.
    function _cancelToSeller(bytes32 tradeId, Escrow storage e) private {
        uint256 amount = e.amount;
        address token = e.token;
        address seller = e.seller;

        e.status = Status.Refunded;

        _send(token, seller, amount);

        emit Cancelled(tradeId, seller, amount);
    }

    function _paySeller(bytes32 tradeId, Escrow storage e) private {
        uint256 amount = e.amount;
        address token = e.token;
        address seller = e.seller;

        e.status = Status.Refunded;

        _send(token, seller, amount);

        emit Refunded(tradeId, seller, amount);
    }

    /// @dev Pays out either the native coin or an ERC-20, depending on `token`.
    function _send(address token, address to, uint256 amount) private {
        if (token == address(0)) {
            // A recipient that rejects the transfer reverts the whole
            // settlement rather than silently stranding the escrow.
            (bool ok, ) = payable(to).call{value: amount}('');
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // ------------------------------------------------------------------ admin

    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert ZeroAddress();
        emit ArbiterUpdated(arbiter, newArbiter);
        arbiter = newArbiter;
    }

    function setFeeCollector(address newFeeCollector) external onlyOwner {
        if (newFeeCollector == address(0)) revert ZeroAddress();
        emit FeeCollectorUpdated(feeCollector, newFeeCollector);
        feeCollector = newFeeCollector;
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroAddress();
        tokenAllowed[token] = allowed;
        emit TokenAllowanceUpdated(token, allowed);
    }

    /// @notice Allow or forbid escrowing the native coin (BNB).
    /// @dev Off by default: a deployment that only trades stablecoins should
    /// not accept native deposits it has no offers for.
    function setNativeAllowed(bool allowed) external onlyOwner {
        nativeAllowed = allowed;
        emit NativeAllowanceUpdated(allowed);
    }

    /// @notice Stop new escrows being opened.
    /// @dev Pausing intentionally does not touch release, dispute, refund or
    /// resolve: money already locked must always be able to get out, whatever
    /// state the platform is in.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ------------------------------------------------------------------ views

    function getEscrow(bytes32 tradeId) external view returns (Escrow memory) {
        return escrows[tradeId];
    }
}
