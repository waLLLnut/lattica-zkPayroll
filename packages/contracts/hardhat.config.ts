import "@nomicfoundation/hardhat-toolbox";
import "hardhat-deploy";
import "hardhat-noir";
import { HardhatUserConfig } from "hardhat/config";
import envConfig from "./envConfig";
import "./shared/typed-hardhat-deploy";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 100000000,
      },
    },
  },
  noir: {
    version: "1.0.0-beta.5",
  },
  networks: {
    baseSepolia: {
      url: "https://sepolia.base.org",
      chainId: 84532,
      accounts: envConfig.DEPLOYER_PRIVATE_KEY
        ? [envConfig.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    sepolia: {
      url: `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY || "demo"}`,
      chainId: 11155111,
      accounts: envConfig.DEPLOYER_PRIVATE_KEY
        ? [envConfig.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    mantle: {
      url: "https://rpc.mantle.xyz",
      chainId: 5000,
      accounts: envConfig.DEPLOYER_PRIVATE_KEY
        ? [envConfig.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    mantleSepolia: {
      url: "https://rpc.sepolia.mantle.xyz",
      chainId: 5003,
      accounts: envConfig.DEPLOYER_PRIVATE_KEY
        ? [envConfig.DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },
  etherscan: {
    apiKey: {
      sepolia: "BSFWY85F56JH998I6GBM1R4YZJTM6G5WGA",
      baseSepolia: process.env.BASESCAN_API_KEY || "",
      mantle: process.env.MANTLE_API_KEY || "",
      mantleSepolia: process.env.MANTLE_API_KEY || "",
    },
    customChains: [
      {
        network: "mantle",
        chainId: 5000,
        urls: {
          apiURL: "https://explorer.mantle.xyz/api",
          browserURL: "https://explorer.mantle.xyz",
        },
      },
      {
        network: "mantleSepolia",
        chainId: 5003,
        urls: {
          apiURL: "https://explorer.sepolia.mantle.xyz/api",
          browserURL: "https://explorer.sepolia.mantle.xyz",
        },
      },
    ],
  },
  namedAccounts: {
    deployer: {
      hardhat: 0,
      localhost: 0,
      baseSepolia: `privatekey://${envConfig.DEPLOYER_PRIVATE_KEY}`,
      mantleSepolia: `privatekey://${envConfig.DEPLOYER_PRIVATE_KEY}`,
    },
  },
  mocha: {
    timeout: 999999999,
  },
};

export default config;
