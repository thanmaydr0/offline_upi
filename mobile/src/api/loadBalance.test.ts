import { describe, expect, jest, test } from '@jest/globals';
import { LoadBalanceFlow } from './loadBalance';
import { fixture, id, voucher } from './__tests__/fixtures';

describe('load balance state machine', () => {
  test('reviewed payments retain the order and never issue vouchers or reopen checkout', async () => {
    const deps = fixture();
    deps.api.kycStatus.mockResolvedValue('provider_required');
    deps.api.onrampStatus.mockResolvedValue('review');
    const openPayment = jest.fn<() => Promise<'opened'>>().mockResolvedValue('opened');
    const flow = new LoadBalanceFlow({ ...deps, openPayment });
    await flow.start(100);
    expect(flow.getState().error).toContain('needs review');
    expect(deps.values.has('load')).toBe(true);
    expect(deps.api.issueVouchers).not.toHaveBeenCalled();
    expect(openPayment).not.toHaveBeenCalled();
  });
  test('provider KYC is completed in hosted checkout without a local approval timer', async () => {
    const deps = fixture();
    deps.api.kycStatus.mockResolvedValue('provider_required');
    const flow = new LoadBalanceFlow({ ...deps, openPayment: async () => 'opened' });
    await flow.start(100);
    expect(deps.api.startKyc).not.toHaveBeenCalled();
    expect(deps.api.createOnramp).toHaveBeenCalledTimes(1);
    expect(flow.getState().phase).toBe('success');
  });
  test('double taps share one order and one ledger entry', async () => {
    const deps = fixture();
    const openPayment = jest.fn<(url: string) => Promise<'opened'>>().mockResolvedValue('opened');
    const flow = new LoadBalanceFlow({ ...deps, openPayment });
    await Promise.all([flow.start(100), flow.start(100)]);
    expect(flow.getState().phase).toBe('success'); expect(deps.api.createOnramp).toHaveBeenCalledTimes(1);
    expect(deps.wallet.addIssued).toHaveBeenCalledTimes(1); expect(deps.ledger.append).toHaveBeenCalledTimes(1);
    await flow.resume(); expect(deps.ledger.append).toHaveBeenCalledTimes(1);
  });
  test('KYC polls until approved before creating an order', async () => {
    const deps = fixture();
    deps.api.kycStatus.mockResolvedValueOnce('not_started').mockResolvedValueOnce('pending').mockResolvedValue('approved');
    const flow = new LoadBalanceFlow({ ...deps, sleep: async () => undefined, openPayment: async () => 'opened' });
    await flow.start(100); expect(deps.api.startKyc).toHaveBeenCalledTimes(1); expect(flow.getState().phase).toBe('success');
  });
  test('browser cancellation preserves order and resume never creates another', async () => {
    const deps = fixture(); deps.api.onrampStatus.mockResolvedValue('pending');
    const flow = new LoadBalanceFlow({ ...deps, openPayment: async () => 'cancel' });
    await flow.start(100); expect(flow.getState().phase).toBe('cancelled'); expect(deps.values.has('load')).toBe(true);
    deps.api.onrampStatus.mockResolvedValue('funded');
    const restarted = new LoadBalanceFlow({ ...deps, openPayment: async () => 'opened' });
    await restarted.resume(); expect(restarted.getState().phase).toBe('success'); expect(deps.api.createOnramp).toHaveBeenCalledTimes(1);
  });
  test('timeout retains order for retry and never issues unfunded vouchers', async () => {
    const deps = fixture(); deps.api.onrampStatus.mockResolvedValue('pending');
    let time = 0;
    const flow = new LoadBalanceFlow({ ...deps, openPayment: async () => 'opened', now: () => time, timeoutMs: 10, sleep: async () => { time += 10; } });
    await flow.start(100); expect(flow.getState().phase).toBe('failed'); expect(deps.api.issueVouchers).not.toHaveBeenCalled();
    expect(deps.values.has('load')).toBe(true);
  });
  test('recovers death after wallet or ledger save without duplicate balance', async () => {
    const deps = fixture();
    await deps.store.write('load', { amountInr: 100, orderId: 'order1', paymentUrl: 'https://pay.example', items: [voucher], complete: false });
    deps.stored.add(id); await deps.ledger.append({ kind: 'load:order1' });
    const flow = new LoadBalanceFlow({ ...deps, openPayment: async () => 'opened' });
    await flow.resume(); expect(flow.getState().phase).toBe('success'); expect(deps.wallet.addIssued).not.toHaveBeenCalled();
    expect(deps.api.issueVouchers).not.toHaveBeenCalled(); expect(deps.ledger.append).toHaveBeenCalledTimes(1);
  });
  test('wrong issuance amount never credits the wallet', async () => {
    const deps = fixture(); const flow = new LoadBalanceFlow({ ...deps, openPayment: async () => 'opened' });
    await flow.start(500); expect(flow.getState().phase).toBe('failed'); expect(deps.wallet.addIssued).not.toHaveBeenCalled();
  });
  test('only a server-confirmed terminal order can be cleared for a fresh load', async () => {
    const deps = fixture(); deps.api.onrampStatus.mockResolvedValue('failed');
    const flow = new LoadBalanceFlow({ ...deps, openPayment: async () => 'opened' });
    await flow.start(100); expect(flow.getState().phase).toBe('failed');
    deps.api.onrampStatus.mockResolvedValue('pending');
    await expect(flow.discardTerminalOrder()).rejects.toThrow('still active');
    expect(deps.values.has('load')).toBe(true);
    deps.api.onrampStatus.mockResolvedValue('failed'); await flow.discardTerminalOrder();
    expect(deps.values.has('load')).toBe(false); expect(flow.getState().phase).toBe('idle');
  });
});
