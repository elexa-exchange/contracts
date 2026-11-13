// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ElexaEscrow} from "../../contracts/ElexaEscrow.sol";

/// @notice BSC fork checks against the live escrow, including metadata-stripped bytecode match.
contract ElexaEscrowForkTest is Test {
    address internal constant LIVE = 0xA69EaDF28f0B5c97A9E8110e38e511E0Ba160cCB;
    address internal constant EXPECTED_OWNER = 0xf7B5D36885Ea24eaa9412a48F87F9aDE6F6C60BB;
    address internal constant EXPECTED_ARBITER = 0xae691B5129C518Be37682E15E8699d1ba5047CC2;
    address internal constant EXPECTED_FEE_COLLECTOR = 0x86b10Bda75bec30327245A0AcfAE233EFFDD936a;
    address internal constant USDT = 0x55d398326f99059fF775485246999027B3197955;

    function _stripMetadata(bytes memory code) internal pure returns (bytes memory) {
        // Solidity appends a CBOR-encoded metadata section ending with a 2-byte length.
        if (code.length < 2) return code;
        uint256 metaLen = (uint256(uint8(code[code.length - 2])) << 8) | uint256(uint8(code[code.length - 1]));
        // typical: 0xa2... + length; length includes the 2 length bytes themselves in older solc,
        // but for 0.8.x the last two bytes are the metadata length and the CBOR sits just before.
        if (metaLen + 2 > code.length) return code;
        uint256 keep = code.length - metaLen - 2;
        bytes memory out = new bytes(keep);
        for (uint256 i = 0; i < keep; i++) {
            out[i] = code[i];
        }
        return out;
    }

    function _rpcUrl() internal view returns (string memory) {
        try vm.envString("BSC_RPC_URL") returns (string memory url) {
            if (bytes(url).length > 0) return url;
        } catch {}
        return "https://bsc-dataseed.bnbchain.org";
    }

    function test_liveBytecodeMatchesLocalRuntime() public {
        string memory rpc = _rpcUrl();
        try vm.createSelectFork(rpc) {
            // ok
        } catch {
            vm.skip(true);
            return;
        }

        bytes memory live = LIVE.code;
        assertTrue(live.length > 0, "live code missing");

        // Deploy a fresh local instance with dummy constructor args; compare runtime only (immutables
        // are not in ElexaEscrow — Ownable stores owner in storage). Runtime bytecode should match.
        ElexaEscrow local_ =
            new ElexaEscrow(address(0x1), address(0x2), address(0x3));
        bytes memory localCode = address(local_).code;

        bytes memory liveStripped = _stripMetadata(live);
        bytes memory localStripped = _stripMetadata(localCode);

        assertEq(liveStripped.length, localStripped.length, "runtime length after strip");
        assertEq(keccak256(liveStripped), keccak256(localStripped), "runtime keccak after strip");

        ElexaEscrow liveEscrow = ElexaEscrow(LIVE);
        assertEq(liveEscrow.owner(), EXPECTED_OWNER, "owner");
        assertEq(liveEscrow.arbiter(), EXPECTED_ARBITER, "arbiter");
        assertEq(liveEscrow.feeCollector(), EXPECTED_FEE_COLLECTOR, "feeCollector");
        assertTrue(liveEscrow.tokenAllowed(USDT), "USDT allow-listed");
        assertTrue(liveEscrow.nativeAllowed(), "nativeAllowed");
        assertFalse(liveEscrow.paused(), "paused");
        assertEq(liveEscrow.MAX_FEE_BPS(), 1000);
        assertEq(liveEscrow.MIN_PAYMENT_WINDOW(), 15 minutes);
        assertEq(liveEscrow.MAX_PAYMENT_WINDOW(), 30 days);
    }

    function test_localBytecodeLengthKnown() public {
        // Offline sanity: local compile produces the expected pre-strip size class from the prompt (~7497).
        ElexaEscrow local_ = new ElexaEscrow(address(0x1), address(0x2), address(0x3));
        bytes memory code = address(local_).code;
        assertTrue(code.length > 7000 && code.length < 9000, "unexpected local runtime size");
        bytes memory stripped = _stripMetadata(code);
        assertTrue(stripped.length < code.length, "metadata present");
        // Prompt: 7497 before strip, 7444 after — allow small drift if tooling differs, but flag large gaps.
        emit log_named_uint("local runtime bytes", code.length);
        emit log_named_uint("local stripped bytes", stripped.length);
    }
}
