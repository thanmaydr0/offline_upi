import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeFunctionData,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { PAYMENT_TYPES, VOUCHER_TYPES } from "../../shared/src/typedData.js";
import type { Payment, Voucher } from "../../shared/src/types.js";

const issuer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const device = privateKeyToAccount("0x8b3a350cf5c34c9194ca3a545d8b6b40e4c7b2d2e2a0e6b4a3f5f5d1b52e3f6a");
const wrongSigner = privateKeyToAccount("0x2f4e3d6c5b8f6d9a09a0f64292d2f4d3c3a2b1e7b6c5d4a3928170615f4e3d2c");
const sharedConnection = await network.create();
const { viem } = sharedConnection;
const publicClient = await viem.getPublicClient();
const [ownerWallet, operatorWallet, outsiderWallet, payeeWallet] = await viem.getWalletClients();

if (!ownerWallet?.account || !operatorWallet?.account || !outsiderWallet?.account || !payeeWallet?.account) {
  throw new Error("Hardhat did not provide the expected local test accounts");
}

const ownerAddress = getAddress(ownerWallet.account.address);
const operatorAddress = getAddress(operatorWallet.account.address);
const outsiderAddress = getAddress(outsiderWallet.account.address);
const payeeAddress = getAddress(payeeWallet.account.address);

type Item = {
  voucher: Voucher;
  issuerSig: Hex;
  payment: Payment;
  deviceSig: Hex;
};

type TypedDataDomain = {
  name: "OfflineVault";
  version: "1";
  chainId: number;
  verifyingContract: Address;
};

type SharedVerifier = {
  verifyVoucher: (voucher: Voucher, signature: Hex, expectedIssuer: Address, domain: TypedDataDomain) => Promise<boolean>;
  verifyPayment: (payment: Payment, signature: Hex, expectedDevice: Address, domain: TypedDataDomain) => Promise<boolean>;
};

type Fixture = Awaited<ReturnType<typeof deployFixture>>;
let fixture: Fixture;
let nextVoucherId = 1n;

async function deployFixture() {
  const token = await viem.deployContract("MockUSDC");
  const vault = await viem.deployContract("OfflineVault", [ownerAddress, token.address, issuer.address]);
  const operatorVault = await viem.getContractAt("OfflineVault", vault.address, {
    client: { public: publicClient, wallet: operatorWallet },
  });
  const outsiderVault = await viem.getContractAt("OfflineVault", vault.address, {
    client: { public: publicClient, wallet: outsiderWallet },
  });
  const operatorToken = await viem.getContractAt("MockUSDC", token.address, {
    client: { public: publicClient, wallet: operatorWallet },
  });
  await vault.write.setOperator([operatorAddress]);
  return { token, vault, operatorVault, outsiderVault, operatorToken };
}

async function makeItem(
  targetVault: Fixture["vault"],
  options: {
    voucher?: Partial<Voucher>;
    payment?: Partial<Payment>;
    issuerSigner?: typeof issuer;
    deviceSigner?: typeof device;
    issuerChainId?: number;
    issuerContract?: Address;
    deviceChainId?: number;
    deviceContract?: Address;
  } = {},
): Promise<Item> {
  const chainId = await publicClient.getChainId();
  const block = await publicClient.getBlock();
  const domainBase = { name: "OfflineVault" as const, version: "1" as const };
  const voucher: Voucher = {
    voucherId: `0x${nextVoucherId.toString(16).padStart(64, "0")}` as Hex,
    device: device.address,
    usdcAmount: 1_000_000n,
    inrPaise: 100,
    expiry: block.timestamp + 3_600n,
    ...options.voucher,
  };
  nextVoucherId += 1n;
  const payment: Payment = {
    voucherId: voucher.voucherId,
    device: voucher.device,
    payee: payeeAddress,
    usdcAmount: voucher.usdcAmount,
    deadline: block.timestamp + 3_600n,
    ...options.payment,
  };
  const voucherDomain = {
    ...domainBase,
    chainId: options.issuerChainId ?? chainId,
    verifyingContract: options.issuerContract ?? targetVault.address,
  };
  const paymentDomain = {
    ...domainBase,
    chainId: options.deviceChainId ?? chainId,
    verifyingContract: options.deviceContract ?? targetVault.address,
  };
  const issuerSig = await (options.issuerSigner ?? issuer).signTypedData({
    domain: voucherDomain,
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: voucher,
  });
  const deviceSig = await (options.deviceSigner ?? device).signTypedData({
    domain: paymentDomain,
    types: PAYMENT_TYPES,
    primaryType: "Payment",
    message: payment,
  });
  return { voucher, issuerSig, payment, deviceSig };
}

async function fund(target: Fixture, amount: bigint) {
  await target.operatorToken.write.mint([operatorAddress, amount]);
  await target.operatorToken.write.approve([target.vault.address, amount]);
  await target.operatorVault.write.fundCollateral([device.address, amount]);
}

async function redeem(targetVault: Fixture["vault"], items: Item[]) {
  const simulation = await publicClient.simulateContract({
    account: outsiderWallet.account,
    address: targetVault.address,
    abi: targetVault.abi,
    functionName: "redeemBatch",
    args: [items],
  });
  const hash = await outsiderWallet.writeContract(simulation.request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { statuses: simulation.result, receipt };
}

async function mustRevert(action: () => Promise<unknown>) {
  await assert.rejects(action);
}

function makeHighSSignature(signature: Hex): Hex {
  const curveOrder = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const r = signature.slice(2, 66);
  const lowS = BigInt(`0x${signature.slice(66, 130)}`);
  const highS = (curveOrder - lowS).toString(16).padStart(64, "0");
  const v = Number.parseInt(signature.slice(130, 132), 16);
  const malleableV = (v === 27 ? 28 : 27).toString(16).padStart(2, "0");
  return `0x${r}${highS}${malleableV}` as Hex;
}

describe("OfflineVault", () => {
  beforeEach(async () => {
    fixture = await deployFixture();
  });

  it("redeems a valid single voucher and prints its gas use", async () => {
    await fund(fixture, 2_000_000n);
    const item = await makeItem(fixture.vault);
    const result = await redeem(fixture.vault, [item]);
    assert.deepEqual(result.statuses, [0]);
    assert.equal(await fixture.token.read.balanceOf([payeeAddress]), 1_000_000n);
    assert.equal(await fixture.vault.read.collateral([device.address]), 1_000_000n);
    console.log(`OfflineVault gas: single redemption ${result.receipt.gasUsed.toString()}`);
  });

  it("redeems a valid batch and prints its gas use", async () => {
    await fund(fixture, 3_000_000n);
    const items = [await makeItem(fixture.vault), await makeItem(fixture.vault)];
    const result = await redeem(fixture.vault, items);
    assert.deepEqual(result.statuses, [0, 0]);
    assert.equal(await fixture.token.read.balanceOf([payeeAddress]), 2_000_000n);
    console.log(`OfflineVault gas: two item batch ${result.receipt.gasUsed.toString()}`);
  });

  it("returns ALREADY_REDEEMED on replay", async () => {
    await fund(fixture, 1_000_000n);
    const item = await makeItem(fixture.vault);
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [0]);
    const replay = await redeem(fixture.vault, [item]);
    assert.deepEqual(replay.statuses, [1]);
  });

  it("returns BAD_ISSUER_SIG for a signature from another issuer", async () => {
    const item = await makeItem(fixture.vault, { issuerSigner: wrongSigner });
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [2]);
  });

  it("returns BAD_DEVICE_SIG for a signature from another device", async () => {
    const item = await makeItem(fixture.vault, { deviceSigner: wrongSigner });
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [3]);
  });

  it("returns VOUCHER_EXPIRED for an expired voucher", async () => {
    const block = await publicClient.getBlock();
    const item = await makeItem(fixture.vault, { voucher: { expiry: block.timestamp - 1n } });
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [4]);
  });

  it("returns DEADLINE_PASSED when the signed payment deadline has passed", async () => {
    const block = await publicClient.getBlock();
    const item = await makeItem(fixture.vault, { payment: { deadline: block.timestamp - 1n } });
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [5]);
  });

  it("returns DEVICE_FROZEN for a frozen device", async () => {
    await fund(fixture, 1_000_000n);
    const item = await makeItem(fixture.vault);
    await fixture.operatorVault.write.freeze([device.address]);
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [6]);
  });

  it("returns INSUFFICIENT_COLLATERAL when collateral is too low", async () => {
    await fund(fixture, 999_999n);
    const item = await makeItem(fixture.vault);
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [7]);
  });

  it("returns FIELD_MISMATCH when voucher and payment fields differ", async () => {
    const item = await makeItem(fixture.vault, { payment: { usdcAmount: 999_999n } });
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [8]);
  });

  it("rejects a malleable high-s issuer signature", async () => {
    const item = await makeItem(fixture.vault);
    item.issuerSig = makeHighSSignature(item.issuerSig);
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [2]);
  });

  it("rejects a signature made for a different chain ID", async () => {
    const chainId = await publicClient.getChainId();
    const item = await makeItem(fixture.vault, { issuerChainId: chainId + 1 });
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [2]);
  });

  it("rejects a signature made for a different verifying contract", async () => {
    const item = await makeItem(fixture.vault, {
      issuerContract: "0x000000000000000000000000000000000000dead",
    });
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [2]);
  });

  it("keeps successful items when another item in a batch has a bad signature", async () => {
    await fund(fixture, 2_000_000n);
    const valid = await makeItem(fixture.vault);
    const invalid = await makeItem(fixture.vault, { issuerSigner: wrongSigner });
    const result = await redeem(fixture.vault, [valid, invalid]);
    assert.deepEqual(result.statuses, [0, 2]);
    assert.equal(await fixture.token.read.balanceOf([payeeAddress]), 1_000_000n);
    assert.equal(await fixture.vault.read.collateral([device.address]), 1_000_000n);
  });

  it("blocks a reentrant redeem attempt from a malicious token callback", async () => {
    const token = await viem.deployContract("ReentrantToken");
    const vault = await viem.deployContract("OfflineVault", [ownerAddress, token.address, issuer.address]);
    const operatorVault = await viem.getContractAt("OfflineVault", vault.address, {
      client: { public: publicClient, wallet: operatorWallet },
    });
    const operatorToken = await viem.getContractAt("ReentrantToken", token.address, {
      client: { public: publicClient, wallet: operatorWallet },
    });
    await vault.write.setOperator([operatorAddress]);
    await operatorToken.write.mint([operatorAddress, 1_000_000n]);
    await operatorToken.write.approve([vault.address, 1_000_000n]);
    await operatorVault.write.fundCollateral([device.address, 1_000_000n]);
    const item = await makeItem(vault);
    const callbackData = encodeFunctionData({
      abi: vault.abi,
      functionName: "redeemBatch",
      args: [[item]],
    });
    await operatorToken.write.setCallback([vault.address, callbackData]);
    const result = await redeem(vault, [item]);
    assert.deepEqual(result.statuses, [0]);
    assert.equal(await token.read.callbackAttempted(), true);
    assert.equal(await token.read.callbackSucceeded(), false);
    assert.equal(await token.read.balanceOf([payeeAddress]), 1_000_000n);
  });

  it("enforces the seven-day withdrawal delay and reserves collateral", async () => {
    await fund(fixture, 1_500_000n);
    await fixture.operatorVault.write.requestWithdraw([device.address, 1_000_000n]);
    await mustRevert(() => fixture.operatorVault.write.executeWithdraw([device.address, outsiderAddress]));

    const redemption = await makeItem(fixture.vault);
    assert.deepEqual((await redeem(fixture.vault, [redemption])).statuses, [7]);

    await sharedConnection.networkHelpers.time.increase(7 * 24 * 60 * 60);
    await fixture.operatorVault.write.executeWithdraw([device.address, outsiderAddress]);
    assert.equal(await fixture.token.read.balanceOf([outsiderAddress]), 1_000_000n);
    assert.equal(await fixture.vault.read.collateral([device.address]), 500_000n);
  });

  it("gates operator and owner functions", async () => {
    await mustRevert(() => fixture.outsiderVault.write.fundCollateral([device.address, 1n]));
    await mustRevert(() => fixture.outsiderVault.write.freeze([device.address]));
    await mustRevert(() => fixture.outsiderVault.write.unfreeze([device.address]));
    await mustRevert(() => fixture.outsiderVault.write.requestWithdraw([device.address, 1n]));
    await mustRevert(() => fixture.outsiderVault.write.executeWithdraw([device.address, outsiderAddress]));
    await mustRevert(() => fixture.outsiderVault.write.setIssuer([outsiderAddress]));
    await mustRevert(() => fixture.outsiderVault.write.setOperator([outsiderAddress]));
    await mustRevert(() => fixture.outsiderVault.write.pause());
    await mustRevert(() => fixture.outsiderVault.write.unpause());
    await mustRevert(() => fixture.operatorVault.write.setIssuer([outsiderAddress]));
    await mustRevert(() => fixture.operatorVault.write.setOperator([outsiderAddress]));
    await mustRevert(() => fixture.operatorVault.write.pause());
  });

  it("blocks funding and redemption while paused", async () => {
    await fund(fixture, 1_000_000n);
    const item = await makeItem(fixture.vault);
    await fixture.vault.write.pause();
    await mustRevert(() => fixture.operatorVault.write.fundCollateral([device.address, 1n]));
    await mustRevert(() => redeem(fixture.vault, [item]));
    await fixture.vault.write.unpause();
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [0]);
  });

  it("signs with the shared typed-data definitions and matches contract hashing", async () => {
    await fund(fixture, 1_000_000n);
    const item = await makeItem(fixture.vault);
    const domain = {
      name: "OfflineVault" as const,
      version: "1" as const,
      chainId: await publicClient.getChainId(),
      verifyingContract: fixture.vault.address,
    };
    const sharedVerifier = await import(new URL("../../shared/src/verify.js", import.meta.url).href) as SharedVerifier;
    assert.equal(await sharedVerifier.verifyVoucher(item.voucher, item.issuerSig, issuer.address, domain), true);
    assert.equal(await sharedVerifier.verifyPayment(item.payment, item.deviceSig, device.address, domain), true);
    assert.deepEqual((await redeem(fixture.vault, [item])).statuses, [0]);
  });

  it("has six decimals and exposes the faucet mint on local testnet", async () => {
    const outsiderToken = await viem.getContractAt("MockUSDC", fixture.token.address, {
      client: { public: publicClient, wallet: outsiderWallet },
    });
    await outsiderToken.write.mint([outsiderAddress, 5_000_000n]);
    assert.equal(await fixture.token.read.decimals(), 6);
    assert.equal(await fixture.token.read.balanceOf([outsiderAddress]), 5_000_000n);
  });
});
