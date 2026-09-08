import hre from "hardhat";
async function main() {
  const address = process.env.ESCROW_ADDRESS?.trim();
  if (!address) throw new Error("Set ESCROW_ADDRESS to the deployed contract.");
  const latest = await hre.ethers.provider.getBlockNumber();
  // Public nodes prune state, so getCode at old blocks fails ("missing trie
  // node"). Logs are kept, and the constructor emits two events — so the
  // earliest log for this address is the deploy block.
  const SPAN = 5000;
  for (let to = latest; to > latest - 60_000; to -= SPAN) {
    const from = Math.max(0, to - SPAN + 1);
    const logs = await hre.ethers.provider.getLogs({ address, fromBlock: from, toBlock: to });
    if (logs.length) {
      const first = logs.reduce((m, l) => Math.min(m, l.blockNumber), Infinity);
      console.log("latest block :", latest);
      console.log("deploy block :", first);
      console.log("logs found   :", logs.length);
      return;
    }
  }
  console.log("no logs found in the last 60k blocks; latest =", latest);
}
main().catch((e) => { console.error(e.shortMessage ?? e.message); process.exit(1); });
