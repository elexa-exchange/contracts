import { expect } from "chai";
import hre from "hardhat";

/**
 * Guards the property that lets one ElexaEscrow.sol serve both BSC and TRON:
 * the compiled bytecode must contain no opcode the TVM does not implement.
 *
 * This is worth a test rather than a comment because of how it fails. TRON
 * rejects a contract containing an unknown opcode at *deployment*, with an
 * error that names neither the opcode nor the offset — so a shanghai build
 * looks like a broken endpoint, a bad fee limit, or an unfunded deployer, and
 * the actual cause is a compiler setting nobody touched deliberately. Bumping
 * the Solidity version without re-pinning `evmVersion` is the realistic way
 * this regresses; at shanghai solc emits 122 PUSH0 in this contract, at paris
 * none.
 *
 * The assertion is on the compiler setting rather than on a scan of the
 * bytecode, because a scan cannot be made trustworthy here. Distinguishing
 * opcodes from inline data needs a real control-flow disassembly — a linear
 * walk desyncs on the first data region and then reports the contract's own
 * constants as instructions, which is a test that fails on correct builds.
 * `evmVersion` is the exact cause, so it is what gets pinned.
 */

/**
 * EVM revisions the TVM implements in full, newest first.
 *
 * Deliberately an allow-list. A deny-list of known-bad revisions would pass by
 * default for every revision invented after this file was written, which is
 * the direction that puts a broken contract on chain rather than a red test.
 */
const TVM_SAFE_EVM_VERSIONS = [
  "paris",
  "london",
  "berlin",
  "istanbul",
  "petersburg",
  "constantinople",
  "byzantium",
];

describe("TVM compatibility", () => {
  it("compiles against an EVM version TRON implements", () => {
    const compilers = hre.config.solidity.compilers;
    expect(compilers, "expected at least one configured compiler").to.not.be.empty;

    for (const compiler of compilers) {
      expect(
        compiler.settings?.evmVersion,
        `Solidity ${compiler.version} has no pinned evmVersion. solc defaults to the ` +
          `newest revision it knows, which emits opcodes (PUSH0 and later) that TRON ` +
          `cannot deploy. Pin it in hardhat.config.ts.`,
      ).to.be.oneOf(TVM_SAFE_EVM_VERSIONS);
    }
  });

  it("produces deployable bytecode for both chains from one artifact", async () => {
    // The other half of the promise deploy-tron.ts makes: it reads this exact
    // artifact rather than recompiling, so BSC and TRON cannot end up running
    // different contracts.
    const artifact = await hre.artifacts.readArtifact("ElexaEscrow");

    expect(artifact.bytecode).to.match(/^0x[0-9a-f]+$/);
    expect(artifact.deployedBytecode.length).to.be.greaterThan(2);

    // TRON charges energy by code size and its deployment ceiling is lower than
    // BSC's. Well under it today; this exists so a contract that grows past it
    // fails here rather than at a mainnet deploy.
    const sizeKb = (artifact.bytecode.length - 2) / 2 / 1024;
    expect(sizeKb, `creation bytecode is ${sizeKb.toFixed(1)} KB`).to.be.lessThan(24);
  });
});
