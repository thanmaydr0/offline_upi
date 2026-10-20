import { describe, expect, test } from '@jest/globals';
import { SyncEngine } from './engine';
import { fixture, id, proof } from '../api/__tests__/fixtures';
import type { Hex } from '@offline-pay/shared';

describe('sync idempotency and recovery', () => {
  test('overlapping calls share one sync; another sync does not settle twice', async () => {
    const deps = fixture(); deps.pending.set(id, proof); const engine = new SyncEngine(deps);
    await Promise.all([engine.run(), engine.run()]); await engine.run();
    expect(deps.api.settle).toHaveBeenCalledTimes(1); expect(deps.received.markSettled).toHaveBeenCalledWith(id, 0);
    expect(engine.getState().error).toBeNull(); expect(engine.getState().snapshot?.offlinePaise).toBe(10000n);
  });
  test('interrupted local acknowledgement replays saved results without another server settle', async () => {
    const deps = fixture(); deps.pending.set(id, proof);
    deps.received.markSettled.mockRejectedValueOnce(new Error('Disk busy'));
    const first = new SyncEngine(deps); await first.run(); expect(first.getState().error).toBe('Disk busy');
    expect(deps.values.has('settlement')).toBe(true);
    const second = new SyncEngine(deps); await second.run();
    expect(deps.api.settle).toHaveBeenCalledTimes(1); expect(deps.pending.size).toBe(0);
    expect(deps.values.has('settlement')).toBe(false);
  });
  test('per-item failure is stored and surfaced; no optimistic success', async () => {
    const deps = fixture(); deps.pending.set(id, proof);
    deps.api.settle.mockResolvedValue({ settlementId: 's1', results: [{ voucherId: id, status: 6 }] });
    const engine = new SyncEngine(deps); await engine.run();
    expect(deps.received.markSettled).toHaveBeenCalledWith(id, 6); expect(engine.getState().error).toContain('failed settlement');
  });
  test('partial response retains all pending proofs', async () => {
    const deps = fixture(); deps.pending.set(id, proof); deps.api.settle.mockResolvedValue({ settlementId: 's1', results: [] });
    const engine = new SyncEngine(deps); await engine.run();
    expect(deps.pending.size).toBe(1); expect(deps.received.markSettled).not.toHaveBeenCalled();
  });
  test('flagged ledger prevents settlement and network failure keeps cached snapshot', async () => {
    const deps = fixture(); const engine = new SyncEngine(deps); await engine.run(); const cached = engine.getState().snapshot;
    deps.pending.set(id, proof); deps.api.postLedgerHead.mockResolvedValue({ ok: false, flagged: true });
    await engine.run(); expect(deps.api.settle).not.toHaveBeenCalled(); expect(engine.getState().snapshot).toEqual(cached);
    deps.api.getConfig.mockRejectedValue(new Error('Offline')); await engine.run(); expect(engine.getState().snapshot).toEqual(cached);
  });
  test('drains all pending proofs in bounded batches', async () => {
    const deps = fixture();
    for (let index = 1; index <= 34; index++) {
      const voucherId = `0x${index.toString(16).padStart(64, '0')}` as Hex;
      deps.pending.set(voucherId, { ...proof, voucher: { ...proof.voucher, voucherId }, payment: { ...proof.payment, voucherId } });
    }
    const engine = new SyncEngine(deps); await engine.run();
    expect(deps.api.settle.mock.calls.map(([items]) => items.length)).toEqual([16, 16, 2]);
    expect(deps.pending.size).toBe(0); expect(engine.getState().error).toBeNull();
  });
  test('splits accumulated offline receipts below the backend amount cap on reconnection', async () => {
    const deps = fixture();
    deps.api.getConfig.mockResolvedValue({ limits: { maxSingleOfflinePaymentPaise: 200000 } });
    for (let index = 1; index <= 3; index++) {
      const voucherId = `0x${index.toString(16).padStart(64, '0')}` as Hex;
      deps.pending.set(voucherId, { ...proof, voucher: { ...proof.voucher, inrPaise: 150000, voucherId }, payment: { ...proof.payment, voucherId } });
    }
    const engine = new SyncEngine(deps); await engine.run();
    expect(deps.api.settle.mock.calls.map(([items]) => items.length)).toEqual([1, 1, 1]);
    expect(deps.pending.size).toBe(0); expect(engine.getState().error).toBeNull();
  });
});
