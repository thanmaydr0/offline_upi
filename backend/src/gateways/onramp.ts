import { createHmac, timingSafeEqual } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import { z } from 'zod';
import type { BackendEnv } from '../env.js';
import { NotConfigured } from '../chain/index.js';
import { HttpError } from '../http.js';
import type { FiatGateway, OnrampOrder, GatewayPayout } from './fiat.js';

const transactionSchema = z.object({
  orderId: z.number().int().positive().safe(),
  merchantRecognitionId: z.string().uuid(),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  coinId: z.number().int(), chainId: z.number().int(), fiatType: z.number().int(),
  fiatAmount: z.union([z.string(), z.number().finite()]),
  status: z.number().int(), transactionHash: z.string(),
});
export type OnrampTransaction = z.infer<typeof transactionSchema>;
export const onrampNotificationSchema = z.object({
  eventType: z.literal('onramp'), orderId: z.number().int().positive().safe(),
  merchantRecognitionId: z.string().uuid(),
});

// Native USDC only. Onramp chain IDs are provider IDs, not EVM chain IDs.
const mainnetUsdc: Record<number, string> = {
  1: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  137: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
  8453: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
};
const vaultConfigurationAbi = parseAbi([
  'function usdc() view returns (address)',
  'function operator() view returns (address)',
  'function issuer() view returns (address)',
]);

/** Hosted checkout handles customer KYC. Browser return values never authorize credit.
 * Sources: docs.onramp.money/onramp/onramp-widget-integration/{hosted-mode,webhook-updates}
 * and rest-api-endpoints/{sample-request-for-endpoints,merchant-transaction-history}.
 */
export class OnrampMoneyGateway implements FiatGateway {
  constructor(private readonly env?: BackendEnv, private readonly fetcher: typeof fetch = fetch) {}

  requireLiveConfiguration(): BackendEnv {
    const env = this.env;
    if (!env?.ONRAMP_APP_ID || !env.ONRAMP_API_KEY || !env.ONRAMP_API_SECRET ||
        !env.ONRAMP_NETWORK || !env.ONRAMP_CHAIN_ID || !env.ONRAMP_COIN_ID) {
      throw new NotConfigured('Onramp live App ID, API credentials and USDC network/coin mapping are required. Complete partner KYB and live activation.');
    }
    if (env.CHAIN_MODE !== 'chain' || !mainnetUsdc[env.CHAIN_ID] ||
        env.USDC_ADDRESS.toLowerCase() !== mainnetUsdc[env.CHAIN_ID] ||
        /^0x0{40}$/i.test(env.VAULT_ADDRESS)) {
      throw new NotConfigured('Live INR collection requires a deployed mainnet vault and native USDC. Fake chains and testnet tokens cannot back real payments.');
    }
    return env;
  }

  async createOnramp(order: OnrampOrder): Promise<{ paymentUrl: string; status: 'pending' }> {
    const env = this.requireLiveConfiguration();
    if (!Number.isSafeInteger(order.amountInrPaise) || order.amountInrPaise <= 0 || order.amountInrPaise % 100 !== 0) {
      throw new HttpError(400, 'INVALID_AMOUNT', 'Checkout requires a positive whole INR amount.');
    }
    z.string().uuid().parse(order.orderId);
    // Relayer receives the purchased USDC before locking it for the device.
    const walletAddress = privateKeyToAccount(env.RELAYER_PRIVATE_KEY as Hex).address;
    const client = createPublicClient({ transport: http(env.RPC_URL) });
    try {
      const actualChainId = await client.getChainId();
      const vault = { address: env.VAULT_ADDRESS as Address, abi: vaultConfigurationAbi };
      const [token, operator, issuer, gas] = await Promise.all([
        client.readContract({ ...vault, functionName: 'usdc' }),
        client.readContract({ ...vault, functionName: 'operator' }),
        client.readContract({ ...vault, functionName: 'issuer' }),
        client.getBalance({ address: walletAddress }),
      ]);
      const expectedIssuer = privateKeyToAccount(env.ISSUER_PRIVATE_KEY as Hex).address;
      if (actualChainId !== env.CHAIN_ID || token.toLowerCase() !== env.USDC_ADDRESS.toLowerCase() ||
          operator.toLowerCase() !== walletAddress.toLowerCase() || issuer.toLowerCase() !== expectedIssuer.toLowerCase() || gas === 0n) {
        throw new Error('Settlement configuration mismatch');
      }
    } catch {
      throw new NotConfigured('Mainnet settlement preflight failed. Check RPC chain, deployed vault token/issuer/operator and relayer gas before collecting INR.');
    }
    const url = new URL('https://onramp.money/main/buy/');
    const params = { appId: String(env.ONRAMP_APP_ID), walletAddress, coinCode: 'usdc',
      network: env.ONRAMP_NETWORK!, fiatAmount: String(order.amountInrPaise / 100),
      fiatType: '1', paymentMethod: '1', merchantRecognitionId: order.orderId };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return { paymentUrl: url.toString(), status: 'pending' };
  }

  verifyNotification(payload: string, signature: string): boolean {
    const secret = this.env?.ONRAMP_API_SECRET;
    if (!secret || !payload || payload.length > 32768 || !/^[0-9a-f]{128}$/i.test(signature)) return false;
    const expected = createHmac('sha512', secret).update(payload).digest();
    return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
  }

  // The legacy synthetic webhook must never be accepted in live mode.
  verifyWebhook(_rawBody: Buffer, _signature: string): boolean { return false; }

  async findTransaction(providerOrderId: number, since: string): Promise<OnrampTransaction> {
    const env = this.requireLiveConfiguration();
    // Authenticated history is authoritative. The documented webhook HMAC signs a
    // header payload; do not trust an independently supplied HTTP body for amounts.
    for (let page = 1; page <= 20; page++) {
      const body = { page, pageSize: 500, since, order: 'ASC', type: 1 };
      const payload = Buffer.from(JSON.stringify({ timestamp: Date.now(), body })).toString('base64');
      const signature = createHmac('sha512', env.ONRAMP_API_SECRET!).update(payload).digest('hex');
      let response: Response;
      try {
        response = await this.fetcher('https://api.onramp.money/onramp/api/v1/transaction/merchantHistory', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json',
            'X-ONRAMP-APIKEY': env.ONRAMP_API_KEY!, 'X-ONRAMP-PAYLOAD': payload, 'X-ONRAMP-SIGNATURE': signature },
          body: JSON.stringify(body),
        });
      } catch { throw new HttpError(502, 'ONRAMP_UNAVAILABLE', 'Onramp could not be reached. The order is retained.'); }
      if (!response.ok) throw new HttpError(502, 'ONRAMP_UNAVAILABLE', 'Onramp rejected the status request.');
      const result = z.object({ status: z.literal(1), data: z.array(z.unknown()) }).safeParse(await response.json());
      if (!result.success) throw new HttpError(502, 'ONRAMP_INVALID_RESPONSE', 'Onramp returned an unexpected response.');
      for (const item of result.data.data) {
        const candidate = z.object({ orderId: z.number() }).safeParse(item);
        if (candidate.success && candidate.data.orderId === providerOrderId) return transactionSchema.parse(item);
      }
      if (result.data.data.length < 500) break;
    }
    throw new HttpError(409, 'ONRAMP_TRANSACTION_NOT_FOUND', 'Provider transaction is not yet available for reconciliation.');
  }

  async createPayout(_input: { payoutId: string; amountInrPaise: number; vpa: string }): Promise<GatewayPayout> {
    throw new NotConfigured('Onramp off-ramp requires a customer-authorized sell flow and verified bank details; a VPA alone cannot initiate a payout.');
  }
}
