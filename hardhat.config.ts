import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
// Loading ./env is what reads .env.<target>. Hardhat evaluates this file before
// any task or script, so importing it here is what gives every entry point its
// settings — the scripts do not (and must not) load them a second time.
import { env } from "./env";

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY?.trim();
const accounts = DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [];

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // BSC follows Ethereum's London opcodes; pinning avoids the PUSH0 issue
      // that shanghai-compiled bytecode hits on chains that lag mainnet.
      evmVersion: "paris",
    },
  },
  networks: {
    bscTestnet: {
      url: env("BSC_TESTNET_RPC_URL", "https://data-seed-prebsc-1-s1.bnbchain.org:8545"),
      chainId: 97,
      accounts,
    },
    bsc: {
      url: env("BSC_RPC_URL", "https://bsc-dataseed.bnbchain.org"),
      chainId: 56,
      accounts,
    },
  },
  etherscan: {
    // BscScan verification. v2 of the Etherscan API serves BSC via the same key.
    apiKey: env("ETHERSCAN_API_KEY", ""),
  },
};

export default config;
