import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { PAYMENT_TYPES, type ProofItem } from '@offline-pay/shared';
import { loadEnv } from '../src/env.js';
import { stringify } from '../src/chain/real/index.js';

const env = loadEnv();
const base = process.env.API_URL ?? `http://127.0.0.1:${env.PORT}`;
async function api(path: string, body?: unknown, token?: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? stringify(body) : undefined });
  const json = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}
const payer = privateKeyToAccount(generatePrivateKey());
const payee = privateKeyToAccount(generatePrivateKey());
async function register(address: string) { return await api('/v1/devices/register', { deviceAddress: address, deviceName: 'P5 demo', integrity: { rooted: false, isDevice: true } }); }
const payerToken = (await register(payer.address)).token as string;
const payeeToken = (await register(payee.address)).token as string;
await api('/v1/payee/vpa', { vpa: 'demo@offlinepay' }, payeeToken);
await api('/v1/kyc/start', {}, payerToken);
await new Promise(resolve => setTimeout(resolve, 3200));
await api('/v1/kyc/status', undefined, payerToken);
const order = await api('/v1/onramp/create', { amountInr: 20 }, payerToken);
const payment = await fetch(`${base}/mock-upi/${String(order.orderId)}/action`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'result=paid' });
if (!payment.ok) throw new Error(`Mock payment failed: ${payment.status}`);
let issued: Record<string, unknown> | undefined;
for (let attempt = 0; attempt < 5; attempt++) {
  try { issued = await api('/v1/vouchers/issue', { orderId: order.orderId }, payerToken); break; }
  catch (error) {
    if (attempt === 4 || !(error instanceof Error) || !error.message.includes('NO_UNISSUED_COLLATERAL')) throw error;
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
}
if (!issued) throw new Error('Voucher issuance did not complete');
const items: ProofItem[] = [];
for (const entry of issued.vouchers as { voucher: ProofItem['voucher']; issuerSig: `0x${string}` }[]) {
  const voucher = { ...entry.voucher, usdcAmount: BigInt(entry.voucher.usdcAmount), expiry: BigInt(entry.voucher.expiry) };
  const payment = { voucherId: voucher.voucherId, device: payer.address, payee: payee.address, usdcAmount: voucher.usdcAmount, deadline: BigInt(Math.floor(Date.now()/1000) + 3600) };
  items.push({ voucher, issuerSig: entry.issuerSig, payment, deviceSig: await payer.signTypedData({ domain: { name: 'OfflineVault', version: '1', chainId: env.CHAIN_ID, verifyingContract: env.VAULT_ADDRESS as `0x${string}` }, types: PAYMENT_TYPES, primaryType: 'Payment', message: payment }) });
}
let settlement: Record<string, unknown> | undefined;
for (let attempt = 0; attempt < 4; attempt++) {
  try { settlement = await api('/v1/settle', { items }, payeeToken); break; }
  catch (error) {
    if (attempt === 3 || !(error instanceof Error) || !error.message.includes(': 500 ')) throw error;
    await new Promise(resolve => setTimeout(resolve, 4000));
  }
}
if (!settlement) throw new Error('Settlement did not complete');
await new Promise(resolve => setTimeout(resolve, 4000));
console.log(stringify({ payer: payer.address, payee: payee.address, orderId: order.orderId, settlement, payouts: await api('/v1/payouts', undefined, payeeToken) }));
