# OfflineVault contracts

`OfflineVault` keeps USDC collateral by device and lets a payee redeem a voucher once, after checking the issuer's and device's EIP-712 signatures. The typed-data field order and integer widths match `shared/src/typedData.ts`. Invalid items return one of the documented status codes; a valid item in the same batch can still redeem.

The Solidity sources use `^0.8.24`. Hardhat compiles with solc 0.8.30 and Cancun output because the installed OpenZeppelin 5.6.1 package uses the Cancun `MCOPY` opcode.

The owner controls the issuer, relayer, pause state, and ownership transfer. The relayer can fund collateral, freeze devices, and start withdrawals. Withdrawals remain locked for seven days; outstanding requests reserve collateral so voucher redemptions cannot consume it. The relayer is trusted to choose withdrawal recipients, as specified.

`MockUSDC` is an unrestricted faucet token with 6 decimals. Its mint function only works on Base Sepolia and local Hardhat chain IDs; it is for testnet demos only and has no mainnet value.

Run `npm run compile -w contracts`, `npm run test -w contracts`, and `npm run typecheck -w contracts`. To deploy, set `DEPLOYER_PRIVATE_KEY`, `RPC_URL_BASE_SEPOLIA`, `RELAYER_ADDRESS`, and `ISSUER_ADDRESS` in `contracts/.env`, then run `npm run deploy:baseSepolia -w contracts`. Local deployment uses `npm run deploy:local -w contracts` while `RELAYER_ADDRESS` and `ISSUER_ADDRESS` are set.

The deployment script records contract addresses, chain ID, and deployment block under `contracts/deployments/`, then writes the contract ABIs to `shared/src/abi/`. Never use wallets that hold real funds for demos.

The contract tests print local gas usage for one-item and two-item redemptions. These measurements are from the Hardhat simulator and will change with contract or compiler settings.
