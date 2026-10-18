import { fireEvent, render } from '@testing-library/react-native';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

import HomeScreen from '../../app/(tabs)/index';
import { useBalanceStore } from '@/state/balances';
import { AmountKeypad, BalanceCard } from '../primitives';

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
    useBalanceStore.setState({ onlinePaise: 4_623_800, offlinePaise: 88_000 });
  });

  it('renders mock balances, payment actions, and the offline-ready call to action', async () => {
    const { getByText, getByTestId } = await render(<HomeScreen />);

    expect(getByText('Good morning, Ananya')).toBeTruthy();
    expect(getByText('Pay')).toBeTruthy();
    expect(getByText('Receive')).toBeTruthy();
    expect(getByText('Get offline-ready')).toBeTruthy();
    expect(getByTestId('balance-total').props.children).toBe('₹47,118');
    expect(getByText('Coffee House')).toBeTruthy();
  });
});
