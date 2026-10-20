import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { describe, expect, jest, test } from '@jest/globals';
import { OfflineScanner } from '../../offline/ui';

jest.mock('expo-router', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    const React = jest.requireActual<typeof import('react')>('react');
    React.useEffect(callback, [callback]);
  },
}));

jest.mock('expo-camera', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  const sampleQr = 'OPAY1:sample-offline-request';
  return {
    CameraView: ({ onCameraReady, onBarcodeScanned }: {
      onCameraReady?: () => void;
      onBarcodeScanned?: (result: { data: string }) => void;
    }) => {
      React.useEffect(() => { onCameraReady?.(); }, [onCameraReady]);
      return <Pressable testID="camera-qr-event" onPress={() => onBarcodeScanned?.({ data: sampleQr })}>
        <Text>Fake camera</Text>
      </Pressable>;
    },
    useCameraPermissions: () => [{ granted: true }, jest.fn()],
  };
});

jest.mock('../../ui', () => {
  const React = jest.requireActual<typeof import('react')>('react');
  const { Pressable, Text } = jest.requireActual<typeof import('react-native')>('react-native');
  return {
    Button: ({ title, onPress, disabled }: { title: string; onPress: () => void; disabled?: boolean }) =>
      <Pressable accessibilityRole="button" accessibilityState={{ disabled: Boolean(disabled) }} disabled={disabled} onPress={onPress}>
        <Text>{title}</Text>
      </Pressable>,
    useAppTheme: () => ({ text: '#111111' }),
  };
});

describe('OfflineScanner', () => {
  test('registers the native scanner at camera mount and only handles scans after Scan QR is tapped', async () => {
    const onScan = jest.fn(async (_data: string) => undefined);
    const { getByText, getByTestId } = await render(<OfflineScanner onScan={onScan} />);

    await waitFor(() => expect(getByText('Scan QR')).toBeTruthy());
    fireEvent.press(getByTestId('camera-qr-event'));
    expect(onScan).not.toHaveBeenCalled();

    fireEvent.press(getByText('Scan QR'));
    fireEvent.press(getByTestId('camera-qr-event'));
    await waitFor(() => expect(onScan).toHaveBeenCalledWith('OPAY1:sample-offline-request'));
  });
});
