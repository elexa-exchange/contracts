import "@stdlib/deploy";
import "@stdlib/ownable";

/// ElexaEscrow — non-custodial escrow for Elexa P2P trades on TON.
///
/// The TON counterpart of contracts/contracts/ElexaEscrow.sol, and deliberately
/// the same *product*: the seller locks funds against a trade id minted by the
/// Elexa backend, and from there the platform is only an arbiter.
///
///   - It can never move funds to itself. Payouts only ever reach the buyer,
///     the seller, or the fee collector, and the fee is bounded at funding time.
///   - It can only act at all on a trade someone has explicitly disputed.
///   - An undisputed trade nobody releases refunds itself to the seller once its
///     deadline passes, and *anyone* may push that refund through.
///
/// Timeout-first, in other words, exactly as on BSC and TRON.
///
/// ---------------------------------------------------------------------------
/// What TON changes, and why this is not a transliteration of the Solidity
/// ---------------------------------------------------------------------------
///
/// **There is no revert-and-refund.** On EVM a failing `require` unwinds the
/// whole call including the token transfer. On TON a failing message bounces,
/// which returns the *message* and its attached TON — but a jetton transfer has
/// already completed by the time we hear about it. Rejecting the notification
/// keeps the jettons. So every invalid jetton funding is refunded *explicitly*
/// (see `refundJettons`), never by `require`. Getting this wrong does not fail
/// a trade; it silently eats the seller's USDT.
///
/// **Native funding still uses require**, and that is correct rather than
/// inconsistent: the TON arrives attached to the very message being rejected,
/// so bouncing genuinely does return it.
///
/// **A jetton is not an ERC-20.** There is no central ledger and no
/// `transferFrom`. Every holder has their own jetton-wallet contract, and ours
/// is what tells us a transfer arrived. That is also the only thing we can
/// authenticate — hence `allowedJettonWallets` is keyed by *our own* wallet for
/// a jetton rather than by the jetton master, because the master's address never
/// appears on an incoming message and could be claimed by anyone.
///
/// **Settled trades collapse to a tombstone.** The Solidity version keeps the
/// full record forever; storage there is paid once. TON charges rent for as long
/// as data exists, so a settled escrow is reduced to its status — enough to keep
/// refusing a replayed trade id, small enough that closed trades do not
/// accumulate into an unbounded rent bill.
///
/// @dev Trade ids are supplied by the caller's application (keccak256 of its own
/// trade identifier, read as a uint256) so an indexer can map an event back to a
/// record.

// ---------------------------------------------------------------------- status

const StatusNone: Int = 0;
const StatusFunded: Int = 1;
const StatusPaid: Int = 2;
const StatusDisputed: Int = 3;
const StatusReleased: Int = 4;
const StatusRefunded: Int = 5;

// --------------------------------------------------------------------- limits

/// Bounds on the payment window a trade may be created with, so a malformed
/// backend call can neither strand funds for a year nor let a seller reclaim
/// them before the buyer has had a chance to pay.
const MinPaymentWindow: Int = 900;      // 15 minutes
const MaxPaymentWindow: Int = 2592000;  // 30 days

/// Ceiling on the platform cut, in basis points of the locked amount. Enforced
/// at funding time so no later message can inflate it.
const MaxFeeBps: Int = 1000; // 10%

/// TON the owner may never withdraw, so the contract can always pay its rent.
///
/// Storage rent is charged continuously on TON, and a contract that pays its
/// balance down to zero is eventually deleted — taking every open escrow's
/// bookkeeping with it. `withdraw-surplus` therefore stops this far short of
/// empty, on top of holding back `lockedNative`.
///
/// Note what this is *not*: a floor enforced on payouts. `payOut` does not
/// check it, and deliberately so — the escrow is tombstoned before the send, so
/// a payout that refused to run on a low balance would strand a settled trade's
/// funds rather than protect them. What keeps the operating balance healthy is
/// that nothing else may spend it on demand: refunds are gated on the sender
/// having attached their own gas (see `refundJettons`), and `topup` exists for
/// the rest. Monitor it anyway; this constant does not defend it.
const MinContractBalance: Int = ton("0.05");

/// TON attached to an outgoing jetton transfer to pay for its own delivery and
/// the recipient's wallet doing its work. A jetton payout is a chain of
/// messages, and each hop needs enough attached value to fund the next; too
/// little does not revert, it strands the transfer part-way.
const JettonTransferGas: Int = ton("0.05");

/// Minimum TON a funding message must carry beyond the escrowed amount, so the
/// contract is not left paying for the seller's transaction out of rent.
const MinFundingGas: Int = ton("0.05");

// --------------------------------------------------------------------- storage

struct EscrowRecord {
    seller: Address;
    buyer: Address;
    /// Our own jetton wallet for the asset being escrowed, or null for native
    /// TON. Stored rather than the jetton master because this is the address a
    /// payout is actually sent to, and re-deriving it later would mean trusting
    /// an allow-list that may have changed since funding.
    jettonWallet: Address?;
    amount: Int as coins;  // total locked, fee inclusive
    fee: Int as coins;     // platform cut, taken only when the buyer is paid
    refundableAt: Int as uint32;
    status: Int as uint8;
}

// -------------------------------------------------------------------- messages

message(0x656c0001) FundNative {
    tradeId: Int as uint256;
    buyer: Address;
    /// Escrowed amount, stated explicitly rather than taken from the message
    /// value. On EVM `msg.value` *is* the amount; on TON the attached value also
    /// has to pay for delivery and storage, so the two are different numbers and
    /// conflating them would escrow slightly less than the trade was priced at.
    amount: Int as coins;
    fee: Int as coins;
    paymentWindow: Int as uint32;
}

message(0x656c0002) MarkPaid { tradeId: Int as uint256 }
message(0x656c0003) Release { tradeId: Int as uint256 }
message(0x656c0004) Dispute { tradeId: Int as uint256 }
message(0x656c0005) RefundAfterTimeout { tradeId: Int as uint256 }
/// Buyer walks away from a trade they have not paid for.
///
/// Exists so an abandoned trade does not have to be waited out. Without it a
/// buyer who changes their mind in the first minute still leaves the seller's
/// funds locked for the whole payment window, which costs an honest seller the
/// use of their capital for a decision the buyer has already made.
message(0x656c0007) BuyerCancel { tradeId: Int as uint256 }
message(0x656c0006) Resolve {
    tradeId: Int as uint256;
    toBuyer: Bool;
}

// admin
message(0x656c0010) SetArbiter { arbiter: Address }
message(0x656c0011) SetFeeCollector { feeCollector: Address }
message(0x656c0012) SetNativeAllowed { allowed: Bool }
/// Allow or forbid escrowing one jetton.
///
/// Takes *our* jetton wallet for the jetton, not the jetton master, because the
/// wallet is the only party whose messages we can authenticate — see the header.
/// The master is carried alongside purely so the emitted event, and therefore
/// the indexer, can name the asset a human would recognise.
message(0x656c0013) SetJettonAllowed {
    jettonWallet: Address;
    jettonMaster: Address;
    allowed: Bool;
}
message(0x656c0014) SetPaused { paused: Bool }
/// Recover jettons the contract holds but no open escrow accounts for.
///
/// Exists because a jetton payout that bounces cannot be automatically retried:
/// a bounced message carries only the first 224 bits of its body, which is not
/// enough to recover a 256-bit trade id, so the contract cannot tell which
/// escrow a failed transfer belonged to. Rather than pretend otherwise, failures
/// are surfaced as `JettonPayoutFailed` events and swept manually.
message(0x656c0015) AdminJettonSweep {
    jettonWallet: Address;
    to: Address;
    amount: Int as coins;
}

// ------------------------------------------------------------- jetton standard

message(0xf8a7ea5) JettonTransfer {
    queryId: Int as uint64;
    amount: Int as coins;
    destination: Address;
    responseDestination: Address?;
    customPayload: Cell?;
    forwardTonAmount: Int as coins;
    forwardPayload: Slice as remaining;
}

message(0x7362d09c) JettonTransferNotification {
    queryId: Int as uint64;
    amount: Int as coins;
    sender: Address;
    forwardPayload: Slice as remaining;
}

/// What a seller puts in the forward payload of a jetton transfer to say which
/// trade it funds. Built by whatever sends the transfer, usually a frontend.
struct JettonFundingPayload {
    tradeId: Int as uint256;
    buyer: Address;
    fee: Int as coins;
    paymentWindow: Int as uint32;
}

// --------------------------------------------------------------------- events

/// Emitted as external-out messages, which is the closest thing TON has to a
/// log. An indexer reads them off each transaction's out-messages.
message(0x656c0100) Funded {
    tradeId: Int as uint256;
    seller: Address;
    buyer: Address;
    /// The jetton *master*, or null for native TON.
    ///
    /// The master rather than our jetton wallet, even though the wallet is what
    /// the record stores and what payouts are sent to. The wallet is an internal
    /// detail — one address per (jetton, holder) pair, meaningless outside this
    /// contract — while the master is what an explorer shows, what an
    /// application stores as the asset's address, and therefore what an indexer
    /// compares against to know the seller locked the asset the trade was priced
    /// in. Emitting the wallet would make that check impossible without a second
    /// lookup.
    token: Address?;
    amount: Int as coins;
    fee: Int as coins;
    refundableAt: Int as uint32;
}
message(0x656c0101) MarkedPaid { tradeId: Int as uint256; caller: Address }
message(0x656c0102) Disputed { tradeId: Int as uint256; caller: Address }
message(0x656c0103) Released {
    tradeId: Int as uint256;
    buyer: Address;
    payout: Int as coins;
    fee: Int as coins;
}
message(0x656c0104) Refunded {
    tradeId: Int as uint256;
    seller: Address;
    amount: Int as coins;
}
message(0x656c0105) Resolved { tradeId: Int as uint256; toBuyer: Bool }
/// A trade the buyer withdrew from before paying.
///
/// Distinct from `Refunded` even though the money moves identically, because the
/// two say different things about the people involved: a refund means a buyer
/// stopped responding, a cancellation means they said so. Only the second is a
/// courtesy, and a marketplace that cannot tell them apart cannot reward it.
message(0x656c0108) Cancelled {
    tradeId: Int as uint256;
    seller: Address;
    amount: Int as coins;
}
/// A jetton funding that could not be accepted and was sent back instead.
/// Not a silent drop: the indexer surfaces these so a seller whose transfer was
/// refused can be told why rather than being left watching an empty escrow.
message(0x656c0106) FundingRefunded {
    tradeId: Int as uint256;
    to: Address;
    amount: Int as coins;
    reason: Int as uint8;
}
message(0x656c0107) JettonPayoutFailed {
    jettonWallet: Address;
    amount: Int as coins;
}

/// Why a jetton funding was sent back. Numeric so the event stays cheap; the
/// indexer maps these to sentences.
const RefusedUnknownJetton: Int = 1;
const RefusedBadPayload: Int = 2;
const RefusedTradeExists: Int = 3;
const RefusedBadWindow: Int = 4;
const RefusedFeeTooHigh: Int = 5;
const RefusedPaused: Int = 6;
const RefusedZeroAmount: Int = 7;
/// Refused *and not sent back*, because the funding did not attach enough TON
/// to pay for its own return. The jettons are still ours and still the sender's
/// to reclaim — see `AdminJettonSweep` — but they did not move, and the indexer
/// has to say so rather than telling the seller their transfer was returned.
const RefusedInsufficientGas: Int = 8;

// -------------------------------------------------------------------- contract

contract ElexaEscrow with Deployable, Ownable {
    owner: Address;
    /// Key permitted to freeze the refund clock and settle disputes. Held by the
    /// Elexa backend. Cannot withdraw funds.
    arbiter: Address;
    /// Destination for platform fees.
    feeCollector: Address;

    escrows: map<Int as uint256, EscrowRecord>;
    /// Our own jetton wallets we accept transfers from, and the master each
    /// belongs to. Presence with `true` is the allow-list.
    allowedJettonWallets: map<Address, Address>;

    nativeAllowed: Bool;
    paused: Bool;

    /// Total native TON currently escrowed across all open trades.
    ///
    /// Tracked rather than inferred from the balance because the two are not the
    /// same number: the contract's balance also holds gas change and rent. Every
    /// native payout is checked against this, so operating funds and sellers'
    /// funds cannot be spent as each other.
    lockedNative: Int as coins;

    /// Jettons we hold that no escrow accounts for, keyed by the jetton wallet
    /// they arrived through. The exact and only budget `AdminJettonSweep` may
    /// spend.
    ///
    /// The native side has `lockedNative`, and `withdraw-surplus` subtracts it
    /// so a compromised owner key cannot reach a seller's escrowed TON. The
    /// jetton side had no such bound: the sweep sent any amount of any jetton
    /// anywhere, which made the owner key a custody key over every open jetton
    /// escrow — the one thing the contract header promises it is not.
    ///
    /// Tracked forwards rather than derived as `balance - locked`, because a
    /// jetton balance lives in our jetton *wallet*, a separate contract we
    /// cannot read synchronously. So instead of guessing what we hold, we count
    /// exactly what arrived without an escrow attached: an unknown jetton, a
    /// funding we refused but could not afford to return, and a payout that
    /// bounced. Nothing else is ever added, so nothing an escrow owns can ever
    /// be swept.
    sweepableJettons: map<Address, Int>;

    init(owner: Address, arbiter: Address, feeCollector: Address) {
        self.owner = owner;
        self.arbiter = arbiter;
        self.feeCollector = feeCollector;
        self.nativeAllowed = false;
        self.paused = false;
        self.lockedNative = 0;
    }

    /// Credit jettons that arrived with no escrow to account for them.
    fun creditSweepable(jettonWallet: Address, amount: Int) {
        if (amount <= 0) {
            return;
        }
        let held: Int? = self.sweepableJettons.get(jettonWallet);
        self.sweepableJettons.set(jettonWallet, (held == null ? 0 : held!!) + amount);
    }

    // ------------------------------------------------------------- native fund

    receive(msg: FundNative) {
        let ctx: Context = context();

        // Rejecting here is safe and returns the seller's TON, because the TON
        // in question is attached to this very message. Contrast the jetton path
        // below, where the funds have already landed.
        require(!self.paused, "Escrow is paused");
        require(self.nativeAllowed, "Native TON is not accepted here");
        require(msg.amount > 0, "Zero amount");
        require(
            ctx.value >= msg.amount + MinFundingGas,
            "Attach the escrowed amount plus gas",
        );

        let refundableAt: Int = self.record(
            msg.tradeId,
            sender(),
            msg.buyer,
            null,
            msg.amount,
            msg.fee,
            msg.paymentWindow,
        );

        self.lockedNative = self.lockedNative + msg.amount;

        emit(Funded{
            tradeId: msg.tradeId,
            seller: sender(),
            buyer: msg.buyer,
            token: null,
            amount: msg.amount,
            fee: msg.fee,
            refundableAt: refundableAt,
        }.toCell());
    }

    // ------------------------------------------------------------- jetton fund

    receive(msg: JettonTransferNotification) {
        // The sender of a transfer notification is a jetton wallet claiming to
        // hold value for us. Only our own wallets actually do — anyone can mint
        // a worthless jetton and notify us about it, and without this check that
        // would fund an escrow with nothing in it.
        let knownMaster: Address? = self.allowedJettonWallets.get(sender());
        if (knownMaster == null) {
            // Deliberately not a refund: we have no reason to believe this
            // notification came from a wallet holding anything, and sending a
            // transfer back to an unknown contract would be doing work an
            // attacker asked for. Ignored, and left for an admin sweep — which
            // is why the amount is booked as sweepable here.
            self.creditSweepable(sender(), msg.amount);
            emit(FundingRefunded{
                tradeId: 0,
                to: msg.sender,
                amount: msg.amount,
                reason: RefusedUnknownJetton,
            }.toCell());
            return;
        }

        let payload: JettonFundingPayload? = self.parseFundingPayload(msg.forwardPayload);
        if (payload == null) {
            self.refundJettons(sender(), msg.sender, msg.amount, 0, RefusedBadPayload);
            return;
        }
        let terms: JettonFundingPayload = payload!!;

        // From here on every rejection has to hand the jettons back explicitly.
        // This is the heart of the file: `require` would keep them.
        if (self.paused) {
            self.refundJettons(sender(), msg.sender, msg.amount, terms.tradeId, RefusedPaused);
            return;
        }
        if (msg.amount <= 0) {
            self.refundJettons(sender(), msg.sender, msg.amount, terms.tradeId, RefusedZeroAmount);
            return;
        }
        if (self.isTaken(terms.tradeId)) {
            self.refundJettons(sender(), msg.sender, msg.amount, terms.tradeId, RefusedTradeExists);
            return;
        }
        if (terms.paymentWindow < MinPaymentWindow || terms.paymentWindow > MaxPaymentWindow) {
            self.refundJettons(sender(), msg.sender, msg.amount, terms.tradeId, RefusedBadWindow);
            return;
        }
        if (terms.fee * 10000 > msg.amount * MaxFeeBps) {
            self.refundJettons(sender(), msg.sender, msg.amount, terms.tradeId, RefusedFeeTooHigh);
            return;
        }

        let refundableAt: Int = now() + terms.paymentWindow;
        self.escrows.set(terms.tradeId, EscrowRecord{
            // `msg.sender` is who sent the jettons, i.e. the seller. `sender()`
            // is our jetton wallet, which is a contract, not a person — using it
            // here would make the escrow refundable to the wrong party.
            seller: msg.sender,
            buyer: terms.buyer,
            jettonWallet: sender(),
            amount: msg.amount,
            fee: terms.fee,
            refundableAt: refundableAt,
            status: StatusFunded,
        });

        emit(Funded{
            tradeId: terms.tradeId,
            seller: msg.sender,
            buyer: terms.buyer,
            token: knownMaster,
            amount: msg.amount,
            fee: terms.fee,
            refundableAt: refundableAt,
        }.toCell());
    }

    // -------------------------------------------------------------- settlement

    /// Freeze the refund clock because the buyer says the fiat is sent.
    ///
    /// Callable by the buyer directly, or by the arbiter on their behalf so a
    /// buyer holding no TON for fees isn't locked out of protecting themselves.
    /// Deliberately harmless: it can only ever delay the seller's refund, never
    /// move funds.
    receive(msg: MarkPaid) {
        let e: EscrowRecord = self.openEscrow(msg.tradeId);
        require(e.status == StatusFunded, "Trade is not awaiting payment");
        require(
            sender() == e.buyer || sender() == self.arbiter,
            "Only the buyer or the arbiter may do this",
        );

        e.status = StatusPaid;
        self.escrows.set(msg.tradeId, e);
        emit(MarkedPaid{tradeId: msg.tradeId, caller: sender()}.toCell());
    }

    /// Seller confirms fiat received and pays the buyer out.
    ///
    /// Available even while disputed: a seller conceding a dispute should never
    /// have to wait on the arbiter.
    receive(msg: Release) {
        let e: EscrowRecord = self.openEscrow(msg.tradeId);
        require(
            e.status == StatusFunded || e.status == StatusPaid || e.status == StatusDisputed,
            "Trade cannot be released from this state",
        );
        require(sender() == e.seller, "Only the seller may release");

        self.payBuyer(msg.tradeId, e);
    }

    /// Open a dispute, handing the arbiter authority over this trade.
    ///
    /// Either party may call. From Funded this also stops the refund clock, so a
    /// seller cannot run it out while a complaint is pending.
    receive(msg: Dispute) {
        let e: EscrowRecord = self.openEscrow(msg.tradeId);
        require(
            e.status == StatusFunded || e.status == StatusPaid,
            "Trade cannot be disputed from this state",
        );
        require(
            sender() == e.buyer || sender() == e.seller,
            "Only a party to the trade may dispute it",
        );

        e.status = StatusDisputed;
        self.escrows.set(msg.tradeId, e);
        emit(Disputed{tradeId: msg.tradeId, caller: sender()}.toCell());
    }

    /// Return an abandoned escrow to the seller once its window lapses.
    ///
    /// Permissionless: the seller's refund must not depend on Elexa being alive.
    /// Only reachable from Funded, so a buyer who marked paid or disputed has
    /// already taken this path away.
    receive(msg: RefundAfterTimeout) {
        let e: EscrowRecord = self.openEscrow(msg.tradeId);
        require(e.status == StatusFunded, "Only an unpaid, undisputed trade times out");
        require(now() >= e.refundableAt, "The payment window has not closed yet");

        self.paySeller(msg.tradeId, e);
    }

    /// Return a trade the buyer has withdrawn from, before its window lapses.
    ///
    /// Buyer only, and only from Funded. Not from Paid: a buyer who has said
    /// they sent the fiat must not be able to hand the money back with one more
    /// click, whether by mistake or because someone talked them into it. Once
    /// they have paid, the ways out are the seller releasing, or a dispute.
    ///
    /// Safe to give the buyer because it can only ever move funds *to the
    /// seller* — the party who deposited them. There is no version of this that
    /// pays the caller, so a buyer gains nothing by calling it except an earlier
    /// end to a trade they had already abandoned.
    receive(msg: BuyerCancel) {
        let e: EscrowRecord = self.openEscrow(msg.tradeId);
        require(e.status == StatusFunded, "Only an unpaid trade can be cancelled");
        require(sender() == e.buyer, "Only the buyer may cancel");

        let amount: Int = e.amount;
        self.settle(msg.tradeId, e, StatusRefunded);
        self.payOut(e, e.seller, amount);
        emit(Cancelled{tradeId: msg.tradeId, seller: e.seller, amount: amount}.toCell());
    }

    /// Settle a disputed trade in favour of one side.
    ///
    /// The arbiter's only power over funds, and reachable exclusively from
    /// Disputed. Refunds to the seller are made whole; the fee is charged only
    /// when the buyer is paid.
    receive(msg: Resolve) {
        require(sender() == self.arbiter, "Only the arbiter may resolve");
        let e: EscrowRecord = self.openEscrow(msg.tradeId);
        require(e.status == StatusDisputed, "Only a disputed trade can be resolved");

        emit(Resolved{tradeId: msg.tradeId, toBuyer: msg.toBuyer}.toCell());

        if (msg.toBuyer) {
            self.payBuyer(msg.tradeId, e);
        } else {
            self.paySeller(msg.tradeId, e);
        }
    }

    // --------------------------------------------------------------- internals

    /// Shared validation and storage for the native funding path.
    fun record(
        tradeId: Int,
        seller: Address,
        buyer: Address,
        jettonWallet: Address?,
        amount: Int,
        fee: Int,
        paymentWindow: Int,
    ): Int {
        require(!self.isTaken(tradeId), "That trade id is already in use");
        require(
            paymentWindow >= MinPaymentWindow && paymentWindow <= MaxPaymentWindow,
            "Payment window is out of bounds",
        );
        require(fee * 10000 <= amount * MaxFeeBps, "Fee is above the ceiling");

        let refundableAt: Int = now() + paymentWindow;
        self.escrows.set(tradeId, EscrowRecord{
            seller: seller,
            buyer: buyer,
            jettonWallet: jettonWallet,
            amount: amount,
            fee: fee,
            refundableAt: refundableAt,
            status: StatusFunded,
        });
        return refundableAt;
    }

    /// Whether a trade id has ever been used, open or settled.
    ///
    /// Settled trades survive as a tombstone precisely so this stays true for
    /// them: reusing the id of a completed trade would let someone lock funds
    /// against a record the backend has already closed.
    fun isTaken(tradeId: Int): Bool {
        return self.escrows.get(tradeId) != null;
    }

    /// The escrow for `tradeId`, or fail if there is none that can still move.
    fun openEscrow(tradeId: Int): EscrowRecord {
        let found: EscrowRecord? = self.escrows.get(tradeId);
        require(found != null, "No such trade");
        let e: EscrowRecord = found!!;
        require(
            e.status != StatusReleased && e.status != StatusRefunded,
            "This trade has already been settled",
        );
        return e;
    }

    fun payBuyer(tradeId: Int, e: EscrowRecord) {
        let fee: Int = e.fee;
        let payout: Int = e.amount - fee;

        // State first, transfers after. Belt and braces on TON — an outgoing
        // message cannot re-enter this transaction the way an EVM call can — but
        // it keeps the ordering identical to the Solidity, and the tombstone
        // must be in place before anything is sent in case a later message in
        // the same block references this trade.
        self.settle(tradeId, e, StatusReleased);

        self.payOut(e, e.buyer, payout);
        if (fee > 0) {
            self.payOut(e, self.feeCollector, fee);
        }

        emit(Released{tradeId: tradeId, buyer: e.buyer, payout: payout, fee: fee}.toCell());
    }

    fun paySeller(tradeId: Int, e: EscrowRecord) {
        let amount: Int = e.amount;
        self.settle(tradeId, e, StatusRefunded);
        self.payOut(e, e.seller, amount);
        emit(Refunded{tradeId: tradeId, seller: e.seller, amount: amount}.toCell());
    }

    /// Collapse a finished escrow to a tombstone.
    ///
    /// Keeps the status — so the trade id can never be reused — and drops
    /// everything else, which is what stops closed trades accruing rent forever.
    fun settle(tradeId: Int, e: EscrowRecord, status: Int) {
        if (e.jettonWallet == null) {
            self.lockedNative = self.lockedNative - e.amount;
        }
        self.escrows.set(tradeId, EscrowRecord{
            seller: e.seller,
            buyer: e.buyer,
            jettonWallet: null,
            amount: 0,
            fee: 0,
            refundableAt: 0,
            status: status,
        });
    }

    /// Pay `amount` of whatever this escrow holds to `to`.
    fun payOut(e: EscrowRecord, to: Address, amount: Int) {
        if (amount <= 0) {
            return;
        }

        if (e.jettonWallet == null) {
            // bounce: false is the important flag. A payout may be going to a
            // wallet that has never been deployed — normal for a fresh TON
            // account — and a bounceable message to one would come straight
            // back, leaving the escrow marked settled and the money here.
            send(SendParameters{
                to: to,
                value: amount,
                mode: SendPayGasSeparately,
                bounce: false,
            });
        } else {
            send(SendParameters{
                to: e.jettonWallet!!,
                value: JettonTransferGas,
                mode: SendPayGasSeparately,
                bounce: true,
                body: JettonTransfer{
                    queryId: 0,
                    amount: amount,
                    destination: to,
                    // Change from the attached gas goes back to the recipient
                    // rather than to us: it is theirs, and routing it here would
                    // quietly accumulate other people's TON in this contract.
                    responseDestination: to,
                    customPayload: null,
                    forwardTonAmount: 0,
                    forwardPayload: emptySlice(),
                }.toCell(),
            });
        }
    }

    /// Hand a jetton transfer back to whoever sent it.
    ///
    /// The counterpart of a revert on EVM, spelled out because TON does not have
    /// one. Every path that refuses a jetton funding goes through here — a
    /// refusal that merely returned early would keep the seller's tokens.
    fun refundJettons(jettonWallet: Address, to: Address, amount: Int, tradeId: Int, reason: Int) {
        // A refund's delivery is paid out of the *contract's* balance —
        // JettonTransferGas, SendPayGasSeparately — while the TON attached to
        // the funding that triggered it is chosen by whoever sent the jettons.
        // The two are unrelated, so without this check anyone holding a single
        // unit of an allow-listed jetton can loop malformed fundings and bill
        // us 0.05 TON per message until the operating balance is gone. An
        // operating balance at zero is not a nuisance: native payouts stop and
        // the contract is eventually deleted for unpaid rent, taking every open
        // escrow's bookkeeping with it.
        //
        // Declining is not keeping the seller's money — the distinction the
        // whole jetton path is built around. The jettons stay ours, the amount
        // is booked as sweepable, and `AdminJettonSweep` returns them. What is
        // refused is spending our TON on an attacker's schedule.
        if (context().value < JettonTransferGas) {
            self.creditSweepable(jettonWallet, amount);
            emit(FundingRefunded{
                tradeId: tradeId,
                to: to,
                amount: amount,
                reason: RefusedInsufficientGas,
            }.toCell());
            return;
        }

        if (amount > 0) {
            send(SendParameters{
                to: jettonWallet,
                value: JettonTransferGas,
                mode: SendPayGasSeparately,
                bounce: true,
                body: JettonTransfer{
                    queryId: 0,
                    amount: amount,
                    destination: to,
                    responseDestination: to,
                    customPayload: null,
                    forwardTonAmount: 0,
                    forwardPayload: emptySlice(),
                }.toCell(),
            });
        }
        emit(FundingRefunded{
            tradeId: tradeId,
            to: to,
            amount: amount,
            reason: reason,
        }.toCell());
    }

    /// Read the seller's terms out of a jetton transfer's forward payload.
    ///
    /// Returns null rather than failing on anything malformed, because the
    /// caller has to refund rather than revert. The payload is accepted both
    /// inline and as a reference: TON's `either` encoding lets a wallet send it
    /// either way, and which one arrives is not something the seller controls.
    fun parseFundingPayload(payload: Slice): JettonFundingPayload? {
        let body: Slice = payload;

        // The jetton standard types `forward_payload` as `(Either Cell ^Cell)`:
        // a leading 0 bit means the data follows inline, a leading 1 bit that it
        // sits in a reference. Both spellings are legitimate and which one
        // arrives is the sending wallet's choice, not the seller's, so both are
        // read rather than one being mandated.
        if (body.bits() < 1) {
            return null;
        }
        if (body.loadBool()) {
            if (body.refs() < 1) {
                return null;
            }
            body = body.loadRef().beginParse();
        }

        // Every read below is guarded by the bits actually remaining, one field
        // at a time, because the fields are not all fixed width and a single
        // up-front check cannot cover them.
        //
        // Getting this wrong is not a rejected trade. Reading past the end of a
        // slice *throws*, and a throw here aborts the whole transaction — after
        // the jettons have already landed in our wallet. No escrow is recorded
        // and no refund is sent, so the seller's USDT sits in the contract until
        // an admin sweeps it out by hand. That is precisely the outcome this
        // function returns null to avoid, and it is why a bounds check is a
        // security control here rather than defensive tidiness.
        if (body.bits() < 256) {
            return null;
        }
        let tradeId: Int = body.loadUint(256);

        // addr_std with no anycast is the only address form we accept, and it is
        // exactly 267 bits: the tag `10`, a zero anycast bit, int8 workchain,
        // uint256 hash. The shape is checked *before* `loadAddress`, which
        // throws — rather than returning null — on addr_none, addr_extern, or an
        // anycast address. `0b100` is the three-bit prefix, i.e. 4.
        if (body.bits() < 267 || body.preloadUint(3) != 4) {
            return null;
        }
        let buyer: Address = body.loadAddress();

        // loadCoins is VarUInteger 16: a 4-bit byte-length, then that many
        // bytes. Both halves have to be checked, and the length has to be read
        // before we can know how long the whole field is.
        if (body.bits() < 4) {
            return null;
        }
        let feeBytes: Int = body.preloadUint(4);
        if (body.bits() < 4 + feeBytes * 8 + 32) {
            return null;
        }
        let fee: Int = body.loadCoins();
        let paymentWindow: Int = body.loadUint(32);

        return JettonFundingPayload{
            tradeId: tradeId,
            buyer: buyer,
            fee: fee,
            paymentWindow: paymentWindow,
        };
    }

    // ----------------------------------------------------------------- bounces

    /// A jetton payout came back.
    ///
    /// Cannot be retried automatically: a bounced message carries only the first
    /// 224 bits of its body, and a trade id alone is 256, so there is no way to
    /// tell which escrow this belonged to. The jettons are still ours — the
    /// transfer never happened — so nothing is lost, but recovering them needs a
    /// human. Surfaced as an event so the indexer can raise it rather than
    /// leaving it to be noticed by accident.
    bounced(msg: bounced<JettonTransfer>) {
        // The transfer never happened, so these jettons are ours again — and
        // the escrow they belonged to was tombstoned before the send, so
        // nothing accounts for them any more. Booking them sweepable is what
        // lets the manual recovery below actually reach them.
        self.creditSweepable(sender(), msg.amount);
        emit(JettonPayoutFailed{
            jettonWallet: sender(),
            amount: msg.amount,
        }.toCell());
    }

    // ------------------------------------------------------------------- admin

    receive(msg: SetArbiter) {
        self.requireOwner();
        self.arbiter = msg.arbiter;
    }

    receive(msg: SetFeeCollector) {
        self.requireOwner();
        self.feeCollector = msg.feeCollector;
    }

    /// Allow or forbid escrowing native TON.
    ///
    /// Off by default: a deployment that only trades stablecoins should not
    /// accept native deposits it has no offers for.
    receive(msg: SetNativeAllowed) {
        self.requireOwner();
        self.nativeAllowed = msg.allowed;
    }

    receive(msg: SetJettonAllowed) {
        self.requireOwner();
        if (msg.allowed) {
            self.allowedJettonWallets.set(msg.jettonWallet, msg.jettonMaster);
        } else {
            self.allowedJettonWallets.set(msg.jettonWallet, null);
        }
    }

    /// Stop new escrows being opened.
    ///
    /// Pausing intentionally does not touch release, dispute, refund or resolve:
    /// money already locked must always be able to get out, whatever state the
    /// platform is in.
    receive(msg: SetPaused) {
        self.requireOwner();
        self.paused = msg.paused;
    }

    receive(msg: AdminJettonSweep) {
        self.requireOwner();

        // Bounded by what actually has no owner, exactly as `withdraw-surplus`
        // is bounded by `lockedNative`. Without this the sweep could send any
        // amount of any jetton anywhere, which made a compromised owner key a
        // custody key over every open jetton escrow — flatly contradicting the
        // promise at the top of this file that the platform "can never move
        // funds to itself".
        let free: Int? = self.sweepableJettons.get(msg.jettonWallet);
        let available: Int = (free == null ? 0 : free!!);
        require(msg.amount > 0, "Nothing to sweep");
        require(msg.amount <= available, "Sweep exceeds the unaccounted balance");
        self.sweepableJettons.set(msg.jettonWallet, available - msg.amount);

        send(SendParameters{
            to: msg.jettonWallet,
            value: JettonTransferGas,
            mode: SendPayGasSeparately,
            bounce: true,
            body: JettonTransfer{
                queryId: 0,
                amount: msg.amount,
                destination: msg.to,
                responseDestination: msg.to,
                customPayload: null,
                forwardTonAmount: 0,
                forwardPayload: emptySlice(),
            }.toCell(),
        });
    }

    /// Top the contract up so it can pay its rent.
    ///
    /// Explicitly *not* credited to any escrow: this is operating balance, and
    /// `lockedNative` is untouched by it.
    receive("topup") {}

    /// Withdraw operating balance only.
    ///
    /// The one place the owner can move native TON, and it is bounded by
    /// `lockedNative` and the rent floor — so a compromised owner key still
    /// cannot reach a single seller's escrowed funds.
    receive("withdraw-surplus") {
        self.requireOwner();
        let surplus: Int = myBalance() - self.lockedNative - MinContractBalance;
        require(surplus > 0, "No surplus to withdraw");
        send(SendParameters{
            to: self.owner,
            value: surplus,
            mode: SendPayGasSeparately,
            bounce: false,
        });
    }

    // ------------------------------------------------------------------- views

    get fun escrow(tradeId: Int): EscrowRecord? {
        return self.escrows.get(tradeId);
    }

    get fun arbiter(): Address {
        return self.arbiter;
    }

    get fun feeCollector(): Address {
        return self.feeCollector;
    }

    get fun nativeAllowed(): Bool {
        return self.nativeAllowed;
    }

    get fun jettonAllowed(jettonWallet: Address): Bool {
        return self.allowedJettonWallets.get(jettonWallet) != null;
    }

    get fun lockedNative(): Int {
        return self.lockedNative;
    }

    /// How much of `jettonWallet`'s balance no escrow accounts for — the
    /// ceiling on what `AdminJettonSweep` can move.
    get fun sweepableJettons(jettonWallet: Address): Int {
        let held: Int? = self.sweepableJettons.get(jettonWallet);
        return (held == null ? 0 : held!!);
    }

    get fun paused(): Bool {
        return self.paused;
    }
}
