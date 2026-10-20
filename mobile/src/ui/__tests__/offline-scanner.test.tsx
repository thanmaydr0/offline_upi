import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { OfflineScanner } from '../../offline/ui';
import { scanOfflineQr } from '../../transport/native';

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(callback, [callback]);
  },
}));
jest.mock('../../transport/native', () => ({ scanOfflineQr: jest.fn() }));
jest.mock('../../ui', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Button: ({ title, onPress, loading }: { title: string; onPress: () => void; loading?: boolean }) =>
      <Pressable accessibilityRole="button" disabled={loading} onPress={onPress}><Text>{title}</Text></Pressable>,
    useAppTheme: () => ({ text: '#111111' }),
  };
});
const scan = jest.mocked(scanOfflineQr);
beforeEach(() => { scan.mockReset(); });
describe('OfflineScanner', () => {
  test('automatically opens the bundled native QR scanner and forwards decoded data', async () => {
    scan.mockResolvedValue('OPAYBT1:offline-request');
    const onScan = jest.fn(async (_data: string) => undefined);
    await render(<OfflineScanner onScan={onScan} />);
    await waitFor(() => expect(onScan).toHaveBeenCalledWith('OPAYBT1:offline-request'));
    expect(scan).toHaveBeenCalledTimes(1);
  });
  test('cancellation does not submit a payment and Scan QR allows retry', async () => {
    scan.mockResolvedValueOnce(null).mockResolvedValueOnce('OPAYBT1:retry');
    const onScan = jest.fn(async (_data: string) => undefined);
    const { getByText } = await render(<OfflineScanner onScan={onScan} />);
    expect(onScan).not.toHaveBeenCalled();
    await fireEvent.press(getByText('Scan QR'));
    await waitFor(() => expect(onScan).toHaveBeenCalledWith('OPAYBT1:retry'));
  });
  test('shows permission/native errors instead of leaving an inert camera preview', async () => {
    scan.mockRejectedValue(new Error('Camera permission denied'));
    const { findByText } = await render(<OfflineScanner onScan={async () => undefined} />);
    expect(await findByText('Camera permission denied')).toBeTruthy();
  });
});
