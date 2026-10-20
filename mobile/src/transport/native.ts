import { requireOptionalNativeModule, NativeModule } from 'expo';
import { PermissionsAndroid, Platform } from 'react-native';
import { z } from 'zod';

export type ProofEvent = { id: string; session: string; payload: string };
type LinkEvents = { proof: (event: ProofEvent) => void; hello: (event: ProofEvent) => void; linkError: (event: { message: string }) => void };
declare class LinkModule extends NativeModule<LinkEvents> {
  scanQr(): Promise<string | null>;
  pairedDevices(): Promise<{ address: string; name: string }[]>;
  openBluetoothSettings(): Promise<void>;
  startReceiver(reqId: string): Promise<boolean>;
  connect(address: string, reqId: string, challenge: string): Promise<string>;
  sendProof(payload: string): Promise<string>;
  respond(id: string, payload: string): Promise<void>;
  disconnect(): Promise<void>;
}
export function localLink(): LinkModule {
  const module = requireOptionalNativeModule<LinkModule>('OfflineLink');
  if (!module) throw new Error('Install the new OfflinePay APK. This build does not contain the offline scanner and Bluetooth module.');
  return module;
}
export async function scanOfflineQr(): Promise<string | null> {
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
  if (result !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Allow camera access in Android app settings to scan.');
  return localLink().scanQr();
}
export async function ensureBluetooth(): Promise<void> {
  if (Platform.OS !== 'android') throw new Error('Offline radio payments require the Android APK.');
  if (Number(Platform.Version) >= 31) {
    const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
    if (granted !== PermissionsAndroid.RESULTS.GRANTED) throw new Error('Allow Nearby devices permission to connect the two phones.');
  }
  // The native call also verifies Bluetooth is enabled, without assuming internet.
  await localLink().pairedDevices();
}
export async function pairedPhones() {
  await ensureBluetooth();
  return z.array(z.object({ address: z.string().regex(/^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/i), name: z.string() }))
    .parse(await localLink().pairedDevices());
}
