import { fireEvent, render } from '@testing-library/react-native';
import { useEffect as mockUseEffect } from 'react';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import HomeScreen from '../../app/(tabs)/index';
import { useBalanceStore } from '@/state/balances';
import { AmountKeypad, BalanceCard } from '../primitives';

let mockOfflineBalance = 88_000n;
const mockSyncState = { running: false, error: null, snapshot: {
  wallet: { onlineInrPaise: 4_623_800n, pendingSettlementPaise: 0n }, offlinePaise: 88_000n,
  history: [{ id: 'one', type: 'onramp', amountInrPaise: 10000, status: 'funded' }], lastSync: 1,
} };
jest.mock('expo-router', () => ({
  router: { push: jest.fn() },
  useFocusEffect: (callback: () => void) => mockUseEffect(callback, [callback]),
}));
jest.mock('@/services', () => ({ servicesMode: 'real', services: {
  wallet: { offlineBalancePaise: async () => mockOfflineBalance },
} }));
jest.mock('@/sync/runtime', () => ({
  useSync: () => mockSyncState, enableSync: jest.fn(),
  loadBalanceFlow: { hydrate: async () => undefined }, syncEngine: { run: async () => undefined },
}));

jest.mock('expo-haptics', () => ({
  impactAsync: () => Promise.resolve(),
  selectionAsync: () => Promise.resolve(),
  ImpactFeedbackStyle: { Light: 'light' },
}));

jest.mock('expo-network', () => ({
  useNetworkState: () => ({ isConnected: true, isInternetReachable: true }),
}));

describe('AmountKeypad', () => {
  it('sends entered digits and deletes the last digit', async () => {
    const onChange = jest.fn();
    const { getByLabelText } = await render(<AmountKeypad value="12" onChange={onChange} />);

    await fireEvent.press(getByLabelText('3'));
    expect(onChange).toHaveBeenLastCalledWith('123');

    await fireEvent.press(getByLabelText('Delete'));
    expect(onChange).toHaveBeenLastCalledWith('1');
  });
});

describe('BalanceCard', () => {
  it('shows online and offline amounts in rupees', async () => {
    const { getByTestId, getByText } = await render(<BalanceCard onlinePaise={125_000} offlinePaise={50_000} />);

    expect(getByTestId('balance-online').props.children).toBe('₹1,250');
    expect(getByTestId('balance-offline').props.children).toBe('₹500');
    expect(getByText('₹1,750')).toBeTruthy();
  });
});

describe('Home screen', () => {
  beforeEach(() => {
    mockOfflineBalance = 88_000n;
    useBalanceStore.setState({ onlinePaise: 4_623_800, offlinePaise: 88_000 });
  });

  it('renders synced balances and the real payment actions', async () => {
    const { getByText, getByTestId } = await render(<HomeScreen />);

    expect(getByText('Your OfflinePay wallet')).toBeTruthy();
    expect(getByText('Pay')).toBeTruthy();
    expect(getByText('Receive')).toBeTruthy();
    expect(getByText('Load Offline Balance')).toBeTruthy();
    expect(getByTestId('balance-total').props.children).toBe('₹47,118');
    expect(getByText('onramp')).toBeTruthy();
  });

  it('shows the current local balance after an offline payment instead of the old sync balance', async () => {
    mockOfflineBalance = 0n;
    const { getByTestId } = await render(<HomeScreen />);
    expect(getByTestId('balance-offline').props.children).toBe('₹0');
    expect(getByTestId('balance-total').props.children).toBe('₹46,238');
  });
});
