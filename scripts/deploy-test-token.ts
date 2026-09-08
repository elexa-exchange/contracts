import hre from "hardhat";

/**
 * Deploys a mintable 18-decimal ERC-20 for testnet trials, and mints a supply
 * to each address you name.
 *
 * Testnet USDT is awkward to obtain in useful quantities, and you need the
 * seller to hold enough to escrow several times over. A token you control
 * removes that problem — it behaves identically to USDT BEP-20 as far as the
 * escrow contract is concerned.
 *
 *   MINT_TO=0xSeller,0xBuyer npx hardhat run scripts/deploy-test-token.ts --network bscTestnet
 *
 * NEVER deploy this to mainnet or allow-list it on a production escrow —
 * anyone can mint it.
 */
async function main() {
  if (hre.network.name === "bsc") {
    throw new Error("Refusing to deploy a freely-mintable token to mainnet.");
  }

  const [deployer] = await hre.ethers.getSigners();
  const token = await hre.ethers.deployContract("MockERC20");
  await token.waitForDeployment();
  const address = await token.getAddress();

  console.log(`Test token (USDT, 18 decimals) deployed at ${address}`);

  const recipients = (process.env.MINT_TO ?? deployer.address)
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);

  const amount = hre.ethers.parseUnits("100000", 18);
  for (const recipient of recipients) {
    const tx = await token.mint(recipient, amount);
    await tx.wait();
    console.log(`minted 100,000 to ${recipient}`);
  }

  console.log(`\nUse this as ALLOWED_TOKENS when deploying the escrow:\n  ${address}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
