// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only stand-in for USDT BEP-20 (18 decimals on BSC).
contract MockERC20 is ERC20 {
    constructor() ERC20("Mock USDT", "USDT") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Test-only token that skims 1% on transfer, to prove fundEscrow rejects
/// fee-on-transfer tokens rather than mis-accounting them.
contract FeeOnTransferERC20 is ERC20 {
    constructor() ERC20("Skim", "SKIM") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 skim = value / 100;
            super._update(from, address(0xdead), skim);
            value -= skim;
        }
        super._update(from, to, value);
    }
}
